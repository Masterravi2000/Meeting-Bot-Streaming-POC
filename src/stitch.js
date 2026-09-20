const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const recordingsDir = path.join(__dirname, "recordings");
const finalDir = path.join(__dirname, "finalRecorded");
if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });

// --- Solution 3: track every spawned ffmpeg process for cleanup ---
const activeFfmpegProcesses = new Set();

function killAllActiveFfmpeg() {
  if (activeFfmpegProcesses.size === 0) return;
  console.log(
    `[FFMPEG_CLEANUP] Killing ${activeFfmpegProcesses.size} still-running ffmpeg process(es)...`,
  );
  for (const proc of activeFfmpegProcesses) {
    try {
      proc.kill("SIGKILL");
    } catch (e) {}
  }
  activeFfmpegProcesses.clear();
}

function renderProgressBar(current, total, label) {
  const width = 24;
  const filled = Math.round((current / total) * width);
  const bar = "#".repeat(filled) + "-".repeat(width - filled);
  const pct = Math.round((current / total) * 100);
  process.stdout.write(
    `\r[STITCH_PROGRESS] [${bar}] ${pct}% (${current}/${total}) ${label}`,
  );
}

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const proc = spawn(ffmpegPath, args, { detached: true });
    activeFfmpegProcesses.add(proc); // Solution 3

    const timer = setInterval(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      process.stdout.write(
        `\r[FFMPEG] ${label} — processing... ${elapsed}s elapsed`,
      );
    }, 1000);

    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("close", (code) => {
      clearInterval(timer);
      activeFfmpegProcesses.delete(proc); // Solution 3
      process.stdout.write("\n");
      if (code === 0) {
        console.log(
          `[FFMPEG_DONE] ${label} — completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`,
        );
        resolve();
      } else {
        console.log(`[FFMPEG_ERROR] ${label} — exited with code ${code}`);
        console.log(stderr.slice(-1500));
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      clearInterval(timer);
      activeFfmpegProcesses.delete(proc); // Solution 3
      console.log(`[FFMPEG_SPAWN_ERROR] ${label}: ${err.message}`);
      reject(err);
    });
  });
}

function readHasAudio(base, segNum) {
  const metaPath = path.join(recordingsDir, `${base}__seg${segNum}.meta.json`);
  if (fs.existsSync(metaPath)) {
    try {
      return !!JSON.parse(fs.readFileSync(metaPath, "utf8")).hasAudio;
    } catch (e) {
      return false;
    }
  }
  return false;
}

async function runWithConcurrencyLimit(tasks, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const current = index++;
      results[current] = await tasks[current]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function stitchAllRecordings() {
  console.log("[STITCH_START] Scanning recordings folder...");

  const files = fs
    .readdirSync(recordingsDir)
    .filter((f) => f.endsWith(".webm"));
  const groups = {};
  for (const f of files) {
    const match = f.match(/^(.+)__seg(\d+)\.webm$/);
    if (!match) continue;
    const [, base, segNum] = match;
    groups[base] = groups[base] || [];
    groups[base].push(parseInt(segNum, 10));
  }

  const participantNames = Object.keys(groups);
  if (participantNames.length === 0) {
    console.log("[STITCH_SKIP] No segment files found to stitch.");
    return;
  }

  const totalSteps = participantNames.reduce(
    (sum, base) => sum + groups[base].length + 1,
    0,
  );
  let completedSteps = 0;

  const concurrencyLimit = Math.max(1, os.cpus().length - 1);
  console.log(
    `[STITCH_CONCURRENCY] Using up to ${concurrencyLimit} parallel ffmpeg processes`,
  );

  const normalizedByBase = {};
  const failedBases = new Set(); // Solution 2: track which participants had a failure

  for (const base of participantNames) {
    const segs = groups[base].sort((a, b) => a - b);
    const tempDir = path.join(recordingsDir, `__temp_${base}`);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    normalizedByBase[base] = { tempDir, files: [], segs };
  }

  // --- Solution 2: every normalize task is individually try/caught ---
  const normalizeTasks = [];
  for (const base of participantNames) {
    const { tempDir, segs } = normalizedByBase[base];
    segs.forEach((seg) => {
      normalizeTasks.push(async () => {
        const inputPath = path.join(recordingsDir, `${base}__seg${seg}.webm`);
        const normPath = path.join(tempDir, `norm_seg${seg}.mp4`);
        const hasAudio = readHasAudio(base, seg);

        const args = hasAudio
          ? [
              "-y",
              "-i",
              inputPath,
              "-c:v",
              "libx264",
              "-r",
              "15",
              "-vf",
              "scale=640:360",
              "-c:a",
              "aac",
              "-ar",
              "48000",
              "-ac",
              "2",
              normPath,
            ]
          : [
              "-y",
              "-i",
              inputPath,
              "-f",
              "lavfi",
              "-i",
              "anullsrc=channel_layout=stereo:sample_rate=48000",
              "-c:v",
              "libx264",
              "-r",
              "15",
              "-vf",
              "scale=640:360",
              "-c:a",
              "aac",
              "-shortest",
              normPath,
            ];

        try {
          await runFfmpeg(args, `${base} seg${seg} normalize`);
          normalizedByBase[base].files.push({ seg, path: normPath });
        } catch (err) {
          console.log(
            `[STITCH_SEGMENT_SKIPPED] ${base} seg${seg} failed and will be excluded: ${err.message}`,
          );
          // This participant's segment failed — note it, but don't throw.
          // Other participants' tasks continue unaffected.
        }
        completedSteps++;
        renderProgressBar(
          completedSteps,
          totalSteps,
          `${base} normalized seg${seg}`,
        );
      });
    });
  }

  await runWithConcurrencyLimit(normalizeTasks, concurrencyLimit);

  // --- Solution 2: every concat task is individually try/caught too ---
  const concatTasks = participantNames.map((base) => async () => {
    const { tempDir, files: normalizedFiles } = normalizedByBase[base];

    if (normalizedFiles.length === 0) {
      console.log(
        `[STITCH_PARTICIPANT_FAILED] ${base} — no valid segments survived, skipping this participant entirely`,
      );
      fs.rmSync(tempDir, { recursive: true, force: true });
      completedSteps++;
      renderProgressBar(
        completedSteps,
        totalSteps,
        `${base} skipped (no valid segments)`,
      );
      return;
    }

    normalizedFiles.sort((a, b) => a.seg - b.seg);
    const listPath = path.join(tempDir, "concat_list.txt");
    fs.writeFileSync(
      listPath,
      normalizedFiles
        .map((f) => `file '${f.path.replace(/'/g, "'\\''")}'`)
        .join("\n"),
    );

    const finalOutputPath = path.join(finalDir, `${base}.mp4`);
    try {
      await runFfmpeg(
        [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
          "-c",
          "copy",
          finalOutputPath,
        ],
        `${base} final concat`,
      );
      console.log(`[STITCH_COMPLETE] ${base} -> ${finalOutputPath}`);
    } catch (err) {
      console.log(
        `[STITCH_PARTICIPANT_FAILED] ${base} — concat failed: ${err.message}`,
      );
    }

    completedSteps++;
    renderProgressBar(completedSteps, totalSteps, `${base} complete`);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await runWithConcurrencyLimit(concatTasks, concurrencyLimit);

  console.log(
    "\n[STITCH_ALL_DONE] Stitching finished for all participants (see above for any that were skipped).",
  );
}

module.exports = { stitchAllRecordings, killAllActiveFfmpeg };
