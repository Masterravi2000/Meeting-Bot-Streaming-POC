const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

chromium.use(stealth);

(async () => {
  // Persistent profile folder — first run: log in manually here.
  // Future runs will reuse this same authenticated session.
  const userDataDir = "C:\\Bot_Streaming_Poc\\chrome-profile";

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: "chrome", // use real installed Chrome instead of bundled Chromium
    slowMo: 300,
  });

  await context.grantPermissions(["camera", "microphone"], {
    origin: "https://meet.google.com",
  });

  // Inject WebRTC hook BEFORE Meet's own scripts run.
  // Patches RTCPeerConnection so every new track (audio/video) gets logged
  // with its id and kind, polls REAL audio level via getStats(),
  // AND now also logs the parent MediaStream's lifecycle (addtrack/removetrack)
  // so we can see the full picture: stream creation on join, and track
  // addition/removal within that stream over time.
  await context.addInitScript(() => {
    const OriginalRTCPeerConnection = window.RTCPeerConnection;

    window.RTCPeerConnection = function (...args) {
      const pc = new OriginalRTCPeerConnection(...args);

      // Poll actual audio level via getStats() — the reliable signal,
      // since track.muted only reflects whether packets are arriving at all,
      // not whether the sender is actually speaking/unmuted.
      async function checkAudioLevel(pcInstance, trackId) {
        const stats = await pcInstance.getStats();
        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "audio") {
            console.log(
              `[AUDIO_LEVEL] trackId~${trackId} level=${report.audioLevel}`,
            );
          }
        });
      }

      pc.addEventListener("track", (event) => {
        const track = event.track;
        console.log(
          `[WEBRTC_TRACK] kind=${track.kind} id=${track.id} muted=${track.muted}`,
        );

        // Log the parent MediaStream(s) this track belongs to.
        // event.streams is an array — usually one stream per participant.
        event.streams.forEach((stream) => {
          console.log(
            `[MEDIA_STREAM] streamId=${stream.id} attachedTo trackId=${track.id} kind=${track.kind} activeTracksInStream=${stream.getTracks().length}`,
          );

          // Watch this specific stream for future track additions/removals
          stream.addEventListener("addtrack", (e) => {
            console.log(
              `[STREAM_ADDTRACK] streamId=${stream.id} newTrackId=${e.track.id} kind=${e.track.kind}`,
            );
          });

          stream.addEventListener("removetrack", (e) => {
            console.log(
              `[STREAM_REMOVETRACK] streamId=${stream.id} removedTrackId=${e.track.id} kind=${e.track.kind}`,
            );
          });
        });

        // Log when THIS track itself ends (removed/stopped at the track level)
        track.addEventListener("ended", () => {
          console.log(
            `[TRACK_ENDED] kind=${track.kind} id=${track.id} — track has ended`,
          );
        });

        if (track.kind === "audio") {
          // Poll audio level every 1 second for this specific track's connection
          const levelInterval = setInterval(() => {
            checkAudioLevel(pc, track.id);
            if (track.readyState === "ended") clearInterval(levelInterval);
          }, 1000);
        }

        if (track.kind === "video") {
          const videoEl = document.createElement("video");
          videoEl.srcObject = new MediaStream([track]);
          videoEl.muted = true;
          videoEl.play().catch(() => {});

          let frameCount = 0;
          let lastFrameTime = Date.now();
          let isCurrentlyActive = false;

          function onFrame(now, metadata) {
            frameCount++;
            const currentTime = Date.now();
            lastFrameTime = currentTime;

            if (!isCurrentlyActive) {
              isCurrentlyActive = true;
              console.log(
                `[VIDEO_RESUMED] trackId=${track.id} — frames flowing again`,
              );
            }

            if (frameCount % 30 === 0) {
              console.log(
                `[VIDEO_FRAME] trackId=${track.id} frameCount=${frameCount} width=${metadata.width} height=${metadata.height}`,
              );
            }
            if (track.readyState !== "ended") {
              videoEl.requestVideoFrameCallback(onFrame);
            }
          }

          // Watchdog: check every 1 second if frames have stopped arriving
          const gapCheckInterval = setInterval(() => {
            const gap = Date.now() - lastFrameTime;
            if (gap > 1500 && isCurrentlyActive) {
              isCurrentlyActive = false;
              console.log(
                `[VIDEO_STOPPED] trackId=${track.id} — no frames for ${gap}ms`,
              );
            }
            if (track.readyState === "ended") clearInterval(gapCheckInterval);
          }, 1000);

          if (videoEl.requestVideoFrameCallback) {
            videoEl.requestVideoFrameCallback(onFrame);
          }
        }

        window.__capturedTracks = window.__capturedTracks || [];
        window.__capturedTracks.push({
          kind: track.kind,
          id: track.id,
          label: track.label,
          timestamp: Date.now(),
        });
      });

      return pc;
    };

    window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  });

  const page = context.pages()[0] || (await context.newPage());

  page.on("console", (msg) => {
    const text = msg.text();
    if (
      text.includes("WEBRTC_TRACK") ||
      text.includes("AUDIO_LEVEL") ||
      text.includes("MEDIA_STREAM") ||
      text.includes("STREAM_ADDTRACK") ||
      text.includes("STREAM_REMOVETRACK") ||
      text.includes("TRACK_ENDED") ||
      text.includes("VIDEO_FRAME") ||
      text.includes("VIDEO_STOPPED") ||
      text.includes("VIDEO_RESUMED")
    ) {
      console.log("BROWSER LOG:", text);
    }
  });

  page.on("close", () => console.log("PAGE CLOSED EVENT FIRED"));
  context.on("close", () => console.log("CONTEXT CLOSED EVENT FIRED"));

  await page.goto("https://meet.google.com/rxn-qeiz-spw");

  console.log("Page loaded, taking screenshot...");
  await page.screenshot({ path: "debug_screenshot.png" });
  console.log("Screenshot saved.");

  // Instead of a blind fixed wait, wait for something concrete to load
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500); // small buffer for Meet's JS to finish rendering buttons

  // Try turning off camera/mic (best-effort)
  await page
    .getByRole("button", { name: /turn off camera/i })
    .click()
    .catch(() => console.log("Camera toggle not found"));

  await page
    .getByRole("button", { name: /turn off microphone/i })
    .click()
    .catch(() => console.log("Microphone toggle not found"));

  // Fill name if a guest name field appears (only relevant if not logged in)
  const nameInput = page.getByRole("textbox");
  if (await nameInput.isVisible().catch(() => false)) {
    await nameInput.fill("Meeting Bot");
    console.log("Filled in bot name");
  }

  // Click join
  try {
    await page.getByRole("button", { name: /ask to join|join now/i }).click();
    console.log("Clicked join button");
  } catch (e) {
    console.log("Join button not found:", e.message);
  }

  // Keep open to observe result
  await page.waitForTimeout(120000);
})();
