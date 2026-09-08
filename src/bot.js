const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const mapper = require("./mapper.js");

chromium.use(stealth);

(async () => {
  const userDataDir = "C:\\Bot_Streaming_Poc\\chrome-profile";

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: "chrome",
    slowMo: 300,
  });

  await context.grantPermissions(["camera", "microphone"], {
    origin: "https://meet.google.com",
  });

  const page = context.pages()[0] || (await context.newPage());

  let snapshotTimer = null;
  function scheduleSnapshotPrint() {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      console.log(
        "[MAPPER_SNAPSHOT]",
        JSON.stringify(mapper.getMapperSnapshot(), null, 2),
      );
      console.log(
        "[EVENT_HISTORY_SNAPSHOT]",
        JSON.stringify(mapper.getEventHistorySnapshot(), null, 2),
      );
    }, 5000);
  }

  await page.exposeFunction(
    "__bindVideo",
    (participantId, name, ssrc, trackId) => {
      mapper.bindVideo(participantId, name, ssrc, trackId);
      console.log(
        `[MAPPER_BIND_VIDEO] participantId=${participantId} name=${name} ssrc=${ssrc} trackId=${trackId}`,
      );
      scheduleSnapshotPrint();
    },
  );

  await page.exposeFunction("__bindAudio", (participantId, name, trackId) => {
    mapper.bindAudio(participantId, name, trackId);
    console.log(
      `[MAPPER_BIND_AUDIO] participantId=${participantId} name=${name} trackId=${trackId}`,
    );
    scheduleSnapshotPrint();
  });

  await page.exposeFunction("__markVideoOn", (participantId, trackId) => {
    mapper.markVideoOn(participantId, trackId);
    console.log(
      `[EVENT_VIDEO_ON] participantId=${participantId} trackId=${trackId}`,
    );
    scheduleSnapshotPrint();
  });

  await page.exposeFunction("__markVideoOff", (participantId, trackId) => {
    mapper.markVideoOff(participantId, trackId);
    console.log(
      `[EVENT_VIDEO_OFF] participantId=${participantId} trackId=${trackId}`,
    );
    scheduleSnapshotPrint();
  });

  await page.exposeFunction("__markAudioOn", (participantId, trackId) => {
    mapper.markAudioOn(participantId, trackId);
    console.log(
      `[EVENT_AUDIO_ON] participantId=${participantId} trackId=${trackId}`,
    );
    scheduleSnapshotPrint();
  });

  await page.exposeFunction("__markAudioOff", (participantId, trackId) => {
    mapper.markAudioOff(participantId, trackId);
    console.log(
      `[EVENT_AUDIO_OFF] participantId=${participantId} trackId=${trackId}`,
    );
    scheduleSnapshotPrint();
  });

  await context.addInitScript({
    path: require("path").join(__dirname, "frameProcessor.js"),
  });

  await context.addInitScript(() => {
    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    let pcCounter = 0;

    window.__streamToTrack = window.__streamToTrack || {};
    window.__recentAudioSpikes = window.__recentAudioSpikes || {};
    window.__videoTrackToParticipant = window.__videoTrackToParticipant || {};
    window.__audioTrackToParticipant = window.__audioTrackToParticipant || {};
    window.__lastAudioActivity = window.__lastAudioActivity || {};
    window.__audioActiveParticipants = window.__audioActiveParticipants || {};
    window.__ssrcToParticipant = window.__ssrcToParticipant || {};
    const AUDIO_SPIKE_THRESHOLD = 0.02;
    const CORRELATION_WINDOW_MS = 400;
    const AUDIO_SILENCE_TIMEOUT_MS = 1500;

    window.RTCPeerConnection = function (...args) {
      const pc = new OriginalRTCPeerConnection(...args);
      const pcId = ++pcCounter;

      console.log(`[PC_CREATED] pcId=${pcId}`);

      async function checkAudioLevel(pcInstance, trackId) {
        const stats = await pcInstance.getStats();
        stats.forEach((report) => {
          if (
            report.type === "inbound-rtp" &&
            report.kind === "audio" &&
            report.trackIdentifier === trackId
          ) {
            const now = Date.now();
            console.log(
              `[AUDIO_LEVEL] trackId~${trackId} level=${report.audioLevel} timestamp=${now}`,
            );
            if (report.audioLevel > AUDIO_SPIKE_THRESHOLD) {
              window.__recentAudioSpikes[trackId] = {
                level: report.audioLevel,
                timestamp: now,
              };
            }
          }
        });
      }

      pc.addEventListener("track", (event) => {
        const track = event.track;
        window.__trackObjects[track.id] = track;
        console.log(
          `[WEBRTC_TRACK] pcId=${pcId} kind=${track.kind} trackId=${track.id} readyState=${track.readyState} muted=${track.muted} streams=${event.streams.map((s) => s.id).join(",")}`,
        );

        event.streams.forEach((stream) => {
          console.log(
            `[MEDIA_STREAM] streamId=${stream.id} attachedTo trackId=${track.id} kind=${track.kind} activeTracksInStream=${stream.getTracks().length}`,
          );

          if (track.kind === "video") {
            window.__streamToTrack[stream.id] = track.id;

            const pending = window.__ssrcToParticipant[stream.id];
            if (pending) {
              window.__bindVideo(
                pending.participantId,
                pending.name,
                stream.id,
                track.id,
              );
              window.__demonstrateFrameAccess(track.id, "video");
              window.__videoTrackToParticipant[track.id] =
                pending.participantId;
            }
          }

          stream.addEventListener("addtrack", (e) => {
            console.log(
              `[STREAM_ADDTRACK] streamId=${stream.id} newTrackId=${e.track.id} kind=${e.track.kind}`,
            );
            if (e.track.kind === "video") {
              window.__streamToTrack[stream.id] = e.track.id;

              const pending = window.__ssrcToParticipant[stream.id];
              if (pending) {
                window.__bindVideo(
                  pending.participantId,
                  pending.name,
                  stream.id,
                  e.track.id,
                );
                window.__videoTrackToParticipant[e.track.id] =
                  pending.participantId;
              }
            }
          });

          stream.addEventListener("removetrack", (e) => {
            console.log(
              `[STREAM_REMOVETRACK] streamId=${stream.id} removedTrackId=${e.track.id} kind=${e.track.kind}`,
            );
          });
        });

        track.addEventListener("ended", () => {
          console.log(
            `[TRACK_ENDED] kind=${track.kind} id=${track.id} — track has ended`,
          );
        });

        track.addEventListener("mute", () => {
          console.log(
            `[TRACK_MUTED] pcId=${pcId} kind=${track.kind} trackId=${track.id}`,
          );
        });

        track.addEventListener("unmute", () => {
          console.log(
            `[TRACK_UNMUTED] pcId=${pcId} kind=${track.kind} trackId=${track.id}`,
          );
        });

        if (track.kind === "audio") {
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
            lastFrameTime = Date.now();

            if (!isCurrentlyActive) {
              isCurrentlyActive = true;
              console.log(
                `[VIDEO_RESUMED] trackId=${track.id} — frames flowing again`,
              );
              const pid = window.__videoTrackToParticipant[track.id];
              if (pid) window.__markVideoOn(pid, track.id);
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

          const gapCheckInterval = setInterval(() => {
            const gap = Date.now() - lastFrameTime;
            if (gap > 1500 && isCurrentlyActive) {
              isCurrentlyActive = false;
              console.log(
                `[VIDEO_STOPPED] trackId=${track.id} — no frames for ${gap}ms`,
              );
              const pid = window.__videoTrackToParticipant[track.id];
              if (pid) window.__markVideoOff(pid, track.id);
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

    function extractTileInfo(el) {
      const ssrcEl =
        el.hasAttribute && el.hasAttribute("data-ssrc")
          ? el
          : el.querySelector && el.querySelector("[data-ssrc]");
      const participantEl =
        el.hasAttribute && el.hasAttribute("data-participant-id")
          ? el
          : (el.closest && el.closest("[data-participant-id]")) ||
            (el.querySelector && el.querySelector("[data-participant-id]"));
      const nameEl =
        participantEl && participantEl.querySelector
          ? participantEl.querySelector("span.notranslate")
          : null;

      const participantId = participantEl
        ? participantEl.getAttribute("data-participant-id")
        : "unknown";
      const ssrc = ssrcEl ? ssrcEl.getAttribute("data-ssrc") : null;
      const name = nameEl ? nameEl.textContent : "unknown";

      if (ssrcEl || participantEl) {
        console.log(
          `[TILE_INFO] participantId=${participantId} ssrc=${ssrc || "unknown"} name=${name}`,
        );
      }

      if (ssrc && participantId !== "unknown") {
        window.__ssrcToParticipant[ssrc] = { participantId, name };

        const trackId = window.__streamToTrack[ssrc];
        if (trackId) {
          window.__bindVideo(participantId, name, ssrc, trackId);
          window.__demonstrateFrameAccess(trackId, "video");
          window.__videoTrackToParticipant[trackId] = participantId;
        }
      }
    }

    function startDomObserver() {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === "attributes") {
            if (mutation.attributeName === "data-ssrc") {
              console.log(
                `[SSRC_CHANGE] oldValue=${mutation.oldValue} newValue=${mutation.target.getAttribute("data-ssrc")} timestamp=${Date.now()}`,
              );
            } else {
              console.log(
                `[TILE_ATTR_CHANGE] attr=${mutation.attributeName} newValue=${mutation.target.getAttribute(mutation.attributeName)}`,
              );
            }
            extractTileInfo(mutation.target);
          }

          if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === 1) {
                if (
                  node.hasAttribute &&
                  (node.hasAttribute("data-ssrc") ||
                    node.hasAttribute("data-participant-id"))
                ) {
                  extractTileInfo(node);
                }
                if (node.querySelectorAll) {
                  node
                    .querySelectorAll("[data-ssrc], [data-participant-id]")
                    .forEach(extractTileInfo);
                }
              }
            });
          }
        });
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["data-ssrc", "data-participant-id"],
      });

      console.log(
        "[DOM_OBSERVER] Started watching for data-ssrc / data-participant-id",
      );
    }

    function startSpeakerObserver() {
      const speakerObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (
            mutation.type === "attributes" &&
            mutation.attributeName === "class"
          ) {
            const el = mutation.target;
            if (
              el.classList &&
              el.classList.contains("DYfzY") &&
              el.classList.contains("cYKTje")
            ) {
              const now = Date.now();
              const tile = el.closest("[data-participant-id]");
              const participantId = tile
                ? tile.getAttribute("data-participant-id")
                : "unknown";
              const nameEl = tile
                ? tile.querySelector("span.notranslate")
                : null;
              const name = nameEl ? nameEl.textContent : "unknown";

              console.log(
                `[SPEAKER_CLASS_CHANGE] participantId=${participantId} name=${name} newClass="${el.className}" timestamp=${now}`,
              );

              if (participantId === "unknown") return;

              let bestTrackId = null;
              let bestGap = Infinity;
              Object.keys(window.__recentAudioSpikes).forEach((trackId) => {
                const spike = window.__recentAudioSpikes[trackId];
                const gap = Math.abs(now - spike.timestamp);
                if (gap <= CORRELATION_WINDOW_MS && gap < bestGap) {
                  bestGap = gap;
                  bestTrackId = trackId;
                }
              });

              if (bestTrackId) {
                window.__bindAudio(participantId, name, bestTrackId);
                window.__audioTrackToParticipant[bestTrackId] = participantId;
                window.__lastAudioActivity[participantId] = now;

                if (!window.__audioActiveParticipants[participantId]) {
                  window.__audioActiveParticipants[participantId] = true;
                  window.__markAudioOn(participantId, bestTrackId);
                  window.__demonstrateFrameAccess(bestTrackId, "audio");
                }
              }
            }
          }
        });
      });

      speakerObserver.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });

      console.log(
        "[SPEAKER_OBSERVER] Started watching .DYfzY.cYKTje for speaking activity",
      );
    }

    function startAudioSilenceWatchdog() {
      setInterval(() => {
        const now = Date.now();
        Object.keys(window.__lastAudioActivity).forEach((participantId) => {
          const gap = now - window.__lastAudioActivity[participantId];
          if (gap > AUDIO_SILENCE_TIMEOUT_MS) {
            const trackId = Object.keys(window.__audioTrackToParticipant).find(
              (t) => window.__audioTrackToParticipant[t] === participantId,
            );
            window.__markAudioOff(participantId, trackId || null);
            delete window.__lastAudioActivity[participantId];
            delete window.__audioActiveParticipants[participantId];
          }
        });
      }, 500);
    }

    if (document.body) {
      startDomObserver();
      startSpeakerObserver();
      startAudioSilenceWatchdog();
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        startDomObserver();
        startSpeakerObserver();
        startAudioSilenceWatchdog();
      });
    }
  });

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
      text.includes("VIDEO_RESUMED") ||
      text.includes("PC_CREATED") ||
      text.includes("TRACK_MUTED") ||
      text.includes("TRACK_UNMUTED") ||
      text.includes("TILE_INFO") ||
      text.includes("SSRC_CHANGE") ||
      text.includes("TILE_ATTR_CHANGE") ||
      text.includes("DOM_OBSERVER") ||
      text.includes("SPEAKER_CLASS_CHANGE") ||
      text.includes("SPEAKER_OBSERVER") ||
      text.includes("EVENT_VIDEO_ON") ||
      text.includes("EVENT_VIDEO_OFF") ||
      text.includes("EVENT_AUDIO_ON") ||
      text.includes("EVENT_AUDIO_OFF") ||
      text.includes("PCM_FRAME") ||
      text.includes("YUV_FRAME") ||
      text.includes("FRAME_DEMO")
    ) {
      console.log("BROWSER LOG:", text);
    }
  });

  page.on("close", () => console.log("PAGE CLOSED EVENT FIRED"));
  context.on("close", () => console.log("CONTEXT CLOSED EVENT FIRED"));

  await page.goto("https://meet.google.com/ego-bwuf-ims");

  console.log("Page loaded, taking screenshot...");
  await page.screenshot({ path: "debug_screenshot.png" });
  console.log("Screenshot saved.");

  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);

  await page
    .getByRole("button", { name: /turn off camera/i })
    .click()
    .catch(() => console.log("Camera toggle not found"));
  await page
    .getByRole("button", { name: /turn off microphone/i })
    .click()
    .catch(() => console.log("Microphone toggle not found"));

  const nameInput = page.getByRole("textbox");
  if (await nameInput.isVisible().catch(() => false)) {
    await nameInput.fill("Meeting Bot");
    console.log("Filled in bot name");
  }

  try {
    await page.getByRole("button", { name: /ask to join|join now/i }).click();
    console.log("Clicked join button");
  } catch (e) {
    console.log("Join button not found:", e.message);
  }

  console.log("=== READY: say something now, wait 3s, then stay silent ===");

  await page.waitForTimeout(120000);

  if (snapshotTimer) clearTimeout(snapshotTimer);
  console.log(
    "[FINAL_MAPPER]",
    JSON.stringify(mapper.getMapperSnapshot(), null, 2),
  );
  console.log(
    "[FINAL_EVENT_HISTORY]",
    JSON.stringify(mapper.getEventHistorySnapshot(), null, 2),
  );
})();
