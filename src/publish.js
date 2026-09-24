// publish.js — runs AFTER bot.js has fully exited (called from start-bot.ps1).
// 1. Finds the session folder (arg, or newest folder with a timeline.json)
// 2. Starts a tiny localhost server and opens the player page immediately
// 3. Uploads each participant's final .mp4 to Cloudinary (2 at a time)
// 4. Marks the manifest ready -> the page stops loading and starts playback
// If Cloudinary isn't configured or an upload fails, that file is served
// locally instead, so the demo never breaks.
//
// Usage: node src/publish.js [sessionDir]

const fs = require("fs");
const path = require("path");
// .env can live in the project root or in src/ — load whichever exists
try {
  const envPath = [path.join(__dirname, "..", ".env"), path.join(__dirname, ".env")].find((p) => fs.existsSync(p));
  if (envPath) require("dotenv").config({ path: envPath });
} catch (_) {}
const http = require("http");
const { exec, spawn } = require("child_process");

const PORT = Number(process.env.PLAYER_PORT || 4747);
const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || "recordings");
const PLAYER_HTML = path.join(__dirname, "player", "player.html");
const UPLOAD_CONCURRENCY = 2;
const OUTPUT_DIR = path.join(__dirname, "finalOutput"); // combined meeting recordings
let ffmpegPath = null;
try { ffmpegPath = require("ffmpeg-static"); } catch (_) {}

// ---------- session + participants ----------
function findSessionDir() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  if (!fs.existsSync(RECORDINGS_DIR)) throw new Error(`No recordings folder at ${RECORDINGS_DIR}`);
  const dirs = fs.readdirSync(RECORDINGS_DIR)
    .map((d) => path.join(RECORDINGS_DIR, d))
    .filter((d) => fs.existsSync(path.join(d, "timeline.json")))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!dirs.length) throw new Error(`No session with timeline.json under ${RECORDINGS_DIR}`);
  return dirs[0];
}

const safe = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function loadParticipants(sessionDir) {
  const tl = JSON.parse(fs.readFileSync(path.join(sessionDir, "timeline.json"), "utf8"));
  // Only .mp4s written after this meeting started — older meetings' files in
  // the same folder are ignored.
  const mp4s = fs.readdirSync(sessionDir)
    .filter((f) => f.toLowerCase().endsWith(".mp4"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(sessionDir, f)).mtimeMs }))
    .filter((x) => !tl.meetingStart || x.mtime >= tl.meetingStart)
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.f);
  const stem = (f) => safe(path.basename(f, path.extname(f)));
  const used = new Set();
  const list = [];
  const pick = (test) => mp4s.find((f) => !used.has(f) && test(f));

  for (const p of Object.values(tl.participants || {})) {
    // Exact file from stitch -> exact id match -> id contained -> name contained.
    const id = safe(p.id), nm = safe(p.name);
    let file = p.file && mp4s.includes(p.file) ? p.file : null;
    if (!file && id) file = pick((f) => stem(f) === id) || pick((f) => stem(f).includes(id));
    if (!file && nm) file = pick((f) => stem(f).includes(nm));
    if (!file) { console.warn(`[PUBLISH] no .mp4 found for ${p.name || p.id}, skipping`); continue; }
    used.add(file);
    list.push({
      id: p.id,
      name: p.name || path.basename(file, ".mp4"),
      file,
      offset: Math.max(0, (p.startedAt - tl.meetingStart) / 1000), // seconds from meeting start
    });
  }
  list.sort((a, b) => a.offset - b.offset);
  return { sessionId: tl.sessionId || path.basename(sessionDir), participants: list };
}

// ---------- Cloudinary ----------
function cloudinaryClient() {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) return null;
  const cloudinary = require("cloudinary").v2;
  cloudinary.config({ cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET, secure: true });
  return cloudinary;
}

function uploadOnce(cloudinary, filePath, folder, publicId) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_large(
      filePath,
      { resource_type: "video", folder, public_id: publicId, overwrite: true, chunk_size: 20 * 1024 * 1024 },
      (err, res) => (err ? reject(err) : res && res.secure_url ? resolve(res.secure_url) : reject(new Error("no secure_url")))
    );
  });
}

async function upload(cloudinary, filePath, folder, publicId) {
  try { return await uploadOnce(cloudinary, filePath, folder, publicId); }
  catch (e) {
    console.warn(`[PUBLISH] upload retry for ${path.basename(filePath)}: ${e.message}`);
    return uploadOnce(cloudinary, filePath, folder, publicId);
  }
}

// ---------- status shared with the page ----------
const status = { state: "uploading", done: 0, total: 0, manifest: null, message: "" };

async function publish(sessionDir) {
  const { sessionId, participants } = loadParticipants(sessionDir);
  status.total = participants.length;
  if (!participants.length) { status.state = "error"; status.message = "No participant videos found in this session."; return; }

  const cloudinary = cloudinaryClient();
  if (!cloudinary) console.warn("[PUBLISH] Cloudinary not configured, serving videos locally");

  const queue = [...participants];
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift();
      const local = `/media/${encodeURIComponent(p.file)}`;
      if (cloudinary) {
        try {
          p.url = await upload(cloudinary, path.join(sessionDir, p.file), `meet-bot/${sessionId}`, safe(p.id || p.name) || undefined);
          console.log(`[PUBLISH] uploaded ${p.name} -> ${p.url}`);
        } catch (e) {
          console.warn(`[PUBLISH] upload failed for ${p.name}, using local file: ${e.message}`);
          p.url = local;
        }
      } else p.url = local;
      status.done++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, participants.length) }, worker));

  status.manifest = {
    sessionId,
    participants: participants.map(({ id, name, url, file, offset }) => ({
      id, name, url, localUrl: `/media/${encodeURIComponent(file)}`, offset,
    })),
  };
  fs.writeFileSync(path.join(sessionDir, "manifest.json"), JSON.stringify(status.manifest, null, 2));
  status.state = "ready";
  console.log(`[PUBLISH] ready: ${participants.length} participant(s)`);
}

// ---------- server ----------
function serveMedia(req, res, sessionDir, name) {
  const file = path.join(sessionDir, path.basename(decodeURIComponent(name)));
  if (!file.startsWith(sessionDir) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const size = fs.statSync(file).size;
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) { // range support is required for video seeking
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": size });
    fs.createReadStream(file).pipe(res);
  }
}

// ---------- combined recording (page streams chunks here while it records) ----------
const recordings = new Map(); // id -> { part, ext }
const sendJson = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const stamp = () => {
  const d = new Date(), z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
};

// Browser recordings lack proper duration/seek info; a quick ffmpeg pass fixes that.
function finalizeRecording(rec, outPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg-static not found"));
    const args = rec.ext === "mp4"
      ? ["-y", "-i", rec.part, "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", outPath]
      : ["-y", "-i", rec.part, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", outPath];
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))));
  });
}

async function handleRecording(req, res, url) {
  const action = url.pathname.slice("/api/rec/".length);
  const projectRoot = path.join(__dirname, "..");

  if (action === "start") {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const ext = url.searchParams.get("ext") === "mp4" ? "mp4" : "webm";
    const id = Date.now().toString(36);
    const part = path.join(OUTPUT_DIR, `_recording_in_progress_${id}.${ext}`);
    fs.writeFileSync(part, "");
    recordings.set(id, { part, ext });
    console.log("[RECORD] started");
    return sendJson(res, 200, { id });
  }

  const id = url.searchParams.get("id");
  const rec = recordings.get(id);
  if (!rec) return sendJson(res, 404, { error: "unknown recording" });

  if (action === "chunk") {
    const out = fs.createWriteStream(rec.part, { flags: "a" });
    out.on("finish", () => sendJson(res, 200, { ok: true }));
    out.on("error", (e) => sendJson(res, 500, { error: e.message }));
    return req.pipe(out);
  }

  if (action === "cancel") {
    recordings.delete(id);
    fs.rmSync(rec.part, { force: true });
    console.log("[RECORD] cancelled");
    return sendJson(res, 200, { ok: true });
  }

  if (action === "finish") {
    recordings.delete(id);
    const outPath = path.join(OUTPUT_DIR, `meeting_${stamp()}.mp4`);
    console.log("[RECORD] finalizing...");
    try {
      await finalizeRecording(rec, outPath);
      fs.rmSync(rec.part, { force: true });
      console.log(`[RECORD] saved ${outPath}`);
      return sendJson(res, 200, { file: path.relative(projectRoot, outPath) });
    } catch (e) {
      // never lose the recording: keep the raw file if post-processing fails
      const rawPath = outPath.replace(/\.mp4$/, `.raw.${rec.ext}`);
      fs.renameSync(rec.part, rawPath);
      console.warn(`[RECORD] post-processing failed, kept raw file ${rawPath}: ${e.message}`);
      return sendJson(res, 200, { file: path.relative(projectRoot, rawPath), warning: "saved without post-processing" });
    }
  }
  sendJson(res, 404, { error: "unknown action" });
}

function openBrowser(url) {
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, (err) => err && console.warn(`[PUBLISH] open the player manually: ${url}`));
}

function main() {
  const sessionDir = findSessionDir();
  console.log(`[PUBLISH] session: ${sessionDir}`);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(PLAYER_HTML).pipe(res);
    }
    if (url.pathname === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(status));
    }
    if (url.pathname.startsWith("/media/")) return serveMedia(req, res, sessionDir, url.pathname.slice(7));
    if (url.pathname.startsWith("/api/rec/") && req.method === "POST") {
      return handleRecording(req, res, url).catch((e) => sendJson(res, 500, { error: e.message }));
    }
    res.writeHead(404); res.end();
  });

  server.listen(PORT, "127.0.0.1", () => {
    const url = `http://localhost:${PORT}/`;
    console.log(`[PUBLISH] player at ${url} (Ctrl+C to close)`);
    openBrowser(url);
    publish(sessionDir).catch((e) => {
      status.state = "error"; status.message = e.message;
      console.error("[PUBLISH] failed:", e);
    });
  });
}

main();