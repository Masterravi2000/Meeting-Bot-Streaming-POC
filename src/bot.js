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
  await context.addInitScript(() => {
    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    let pcCounter = 0;

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
            console.log(
              `[AUDIO_LEVEL] trackId~${trackId} level=${report.audioLevel}`,
            );
          }
        });
      }

      pc.addEventListener("track", (event) => {
        const track = event.track;
        console.log(
          `[WEBRTC_TRACK] pcId=${pcId} kind=${track.kind} trackId=${track.id} readyState=${track.readyState} muted=${track.muted} streams=${event.streams.map((s) => s.id).join(",")}`,
        );

        event.streams.forEach((stream) => {
          console.log(
            `[MEDIA_STREAM] streamId=${stream.id} attachedTo trackId=${track.id} kind=${track.kind} activeTracksInStream=${stream.getTracks().length}`,
          );

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

    // --- DOM observation: watch ONLY for the stable identity-linking attributes ---
    // data-participant-id: stable participant identity
    // data-ssrc: matches WebRTC MediaStream streamId
    // This is deliberately narrow (attributeFilter) to avoid the class-change noise flood.
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

      if (ssrcEl || participantEl) {
        console.log(
          `[TILE_INFO] participantId=${participantEl ? participantEl.getAttribute("data-participant-id") : "unknown"} ssrc=${ssrcEl ? ssrcEl.getAttribute("data-ssrc") : "unknown"} name=${nameEl ? nameEl.textContent : "unknown"}`,
        );
      }
    }

    function startDomObserver() {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          // Case 1: the watched attribute itself changed on an existing node
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

          // Case 2: a whole new tile subtree was added — scan it for these attributes
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

    if (document.body) {
      startDomObserver();
    } else {
      document.addEventListener("DOMContentLoaded", startDomObserver);
    }
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
      text.includes("VIDEO_RESUMED") ||
      text.includes("PC_CREATED") ||
      text.includes("TRACK_MUTED") ||
      text.includes("TRACK_UNMUTED") ||
      text.includes("TILE_INFO") ||
      text.includes("SSRC_CHANGE") ||
      text.includes("TILE_ATTR_CHANGE") ||
      text.includes("DOM_OBSERVER")
    ) {
      console.log("BROWSER LOG:", text);
    }
  });

  page.on("close", () => console.log("PAGE CLOSED EVENT FIRED"));
  context.on("close", () => console.log("CONTEXT CLOSED EVENT FIRED"));

  await page.goto("https://meet.google.com/doj-uavh-tvv");

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
})();
