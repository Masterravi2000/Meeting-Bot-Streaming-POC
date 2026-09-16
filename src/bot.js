const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const mapper = require("./mapper.js");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const chunkStreams = {}; // participantId -> fs.WriteStream
const outputDir = path.join(__dirname, "recordings");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

chromium.use(stealth);

(async () => {
  const userDataDir = "C:\\Bot_Streaming_Poc\\chrome-profile";

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: "chrome",
    slowMo: 300,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });

  await context.grantPermissions(["camera", "microphone"], {
    origin: "https://meet.google.com",
  });

  const page = context.pages()[0] || (await context.newPage());

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 8765 });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const participantId = url.searchParams.get("participantId");
    if (!participantId) {
      ws.close();
      return;
    }

    if (!chunkStreams[participantId]) {
      const safeName = participantId.replace(/[^a-zA-Z0-9]/g, "_");
      const filePath = path.join(outputDir, `${safeName}.webm`);
      chunkStreams[participantId] = fs.createWriteStream(filePath, {
        flags: "a",
      });
      console.log(
        `[WS_STREAM_OPEN] participantId=${participantId} -> ${filePath}`,
      );
    }

    const stream = chunkStreams[participantId];

    ws.on("message", (data) => {
      stream.write(data);
      console.log(
        `[WS_CHUNK_WRITTEN] participantId=${participantId} bytes=${data.length}`,
      );
    });

    ws.on("close", () => {
      console.log(`[WS_CLOSED] participantId=${participantId}`);
    });

    ws.on("error", (err) => {
      console.log(`[WS_ERROR] participantId=${participantId}: ${err.message}`);
    });
  });

  function closeAllChunkStreams() {
    Object.keys(chunkStreams).forEach((pid) => {
      chunkStreams[pid].end();
      console.log(`[WS_STREAM_CLOSED] participantId=${pid}`);
    });
    wss.close();
  }

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
      // console.log(
      //   `[MAPPER_BIND_VIDEO] participantId=${participantId} name=${name} ssrc=${ssrc} trackId=${trackId}`,
      // );
      scheduleSnapshotPrint();
    },
  );

  await page.exposeFunction("__bindAudio", (participantId, name, trackId) => {
    mapper.bindAudio(participantId, name, trackId);
    // console.log(
    //   `[MAPPER_BIND_AUDIO] participantId=${participantId} name=${name} trackId=${trackId}`,
    // );
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

  await page.exposeFunction("__updateName", (participantId, name) => {
    mapper.updateName(participantId, name);
  });

  await context.addInitScript({
    path: require("path").join(__dirname, "frameProcessor.js"),
  });

  await context.addInitScript({
    path: require("path").join(__dirname, "recorder.js"),
  });

  await page.exposeFunction("__markScreenShareOn", (participantId, trackId) => {
    mapper.markScreenShareOn(participantId, trackId);
    console.log(
      `[EVENT_SCREEN_SHARE_ON] participantId=${participantId} trackId=${trackId}`,
    );
    scheduleSnapshotPrint();
  });

  await page.exposeFunction(
    "__markScreenShareOff",
    (participantId, trackId) => {
      mapper.markScreenShareOff(participantId, trackId);
      console.log(
        `[EVENT_SCREEN_SHARE_OFF] participantId=${participantId} trackId=${trackId}`,
      );
      scheduleSnapshotPrint();
    },
  );

  await page.exposeFunction("__markAsPresentation", (participantId) => {
    mapper.markAsPresentation(participantId);
  });

  // await page.exposeFunction("__saveChunk", (participantId, base64Data) => {
  //   const safeName = participantId.replace(/[^a-zA-Z0-9]/g, "_");
  //   const filePath = path.join(outputDir, `${safeName}.webm`);
  //   const buffer = Buffer.from(base64Data, "base64");
  //   fs.appendFileSync(filePath, buffer);
  //   console.log(`[CHUNK_WRITTEN] ${safeName} bytes=${buffer.length}`);
  // });

  await context.addInitScript(() => {
    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    let pcCounter = 0;

    document.addEventListener("securitypolicyviolation", (e) => {
      console.log(
        `[CSP_VIOLATION] directive=${e.violatedDirective} blockedURI=${e.blockedURI}`,
      );
    });

    window.__streamToTrack = window.__streamToTrack || {};
    window.__recentAudioSpikes = window.__recentAudioSpikes || {};
    window.__videoTrackToParticipant = window.__videoTrackToParticipant || {};
    window.__audioTrackToParticipant = window.__audioTrackToParticipant || {};
    window.__lastAudioActivity = window.__lastAudioActivity || {};
    window.__audioActiveParticipants = window.__audioActiveParticipants || {};
    window.__ssrcToParticipant = window.__ssrcToParticipant || {};
    window.__presentationParticipants = window.__presentationParticipants || {};
    const AUDIO_SPIKE_THRESHOLD = 0.06;
    const CORRELATION_WINDOW_MS = 200;
    const AUDIO_SILENCE_TIMEOUT_MS = 4000;

    // --- Block A (moved here from inside window.RTCPeerConnection) ---

    // --- Block B (moved here from inside window.RTCPeerConnection) ---

    async function attachEventDrivenSpikeDetection(track) {
      if (!window.__audioSpikeCtx) {
        window.__audioSpikeCtx = new AudioContext();
      }
      if (!window.__spikeWorkletModuleLoaded) {
        const SPIKE_WORKLET_CODE = `
  class SpikeProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.sampleCounter = 0;
    }
    process(inputs) {
      const input = inputs[0];
      if (input.length > 0) {
        const channel = input[0];
        let sumSquares = 0;
        for (let i = 0; i < channel.length; i++) {
          sumSquares += channel[i] * channel[i];
        }
        const rms = Math.sqrt(sumSquares / channel.length);

        this.sampleCounter++;
        if (this.sampleCounter % 10 === 0) {
          this.port.postMessage({ level: rms, timestamp: currentTime });
        }
      }
      return true;
    }
  }
  registerProcessor('spike-processor', SpikeProcessor);
`;
        window.__spikeWorkletModuleLoaded =
          window.__audioSpikeCtx.audioWorklet.addModule(
            URL.createObjectURL(
              new Blob([SPIKE_WORKLET_CODE], {
                type: "application/javascript",
              }),
            ),
          );
      }

      await window.__spikeWorkletModuleLoaded;

      const source = window.__audioSpikeCtx.createMediaStreamSource(
        new MediaStream([track]),
      );
      const workletNode = new AudioWorkletNode(
        window.__audioSpikeCtx,
        "spike-processor",
      );

      workletNode.port.onmessage = (event) => {
        const { level } = event.data;
        const now = Date.now();

        if (level > AUDIO_SPIKE_THRESHOLD) {
          console.log(
            `[AUDIO_LEVEL] trackId~${track.id} level=${level} timestamp=${now}`,
          );
          window.__recentAudioSpikes[track.id] = { level, timestamp: now };
        }
      };

      source.connect(workletNode);

      track.addEventListener("ended", () => {
        workletNode.port.onmessage = null;
        source.disconnect();
        workletNode.disconnect();
      });
    }

    window.RTCPeerConnection = function (...args) {
      const pc = new OriginalRTCPeerConnection(...args);
      const pcId = ++pcCounter;

      console.log(`[PC_CREATED] pcId=${pcId}`);

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

          if (track.kind === "video") {
            const pid = window.__videoTrackToParticipant[track.id];
            if (pid) {
              if (window.__presentationParticipants[pid]) {
                window.__markScreenShareOff(pid, track.id);
              } else {
                window.__markVideoOff(pid, track.id);
              }
            }
          }
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

        // --- Block C (moved here from directly inside window.RTCPeerConnection,
        // where `track` did not exist yet — this is the only scope that has it) ---
        if (track.kind === "audio") {
          attachEventDrivenSpikeDetection(track);
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

            // In onFrame:
            if (!isCurrentlyActive) {
              isCurrentlyActive = true;
              console.log(
                `[VIDEO_RESUMED] trackId=${track.id} — frames flowing again`,
              );
              const pid = window.__videoTrackToParticipant[track.id];
              if (pid) {
                if (window.__presentationParticipants[pid]) {
                  window.__markScreenShareOn(pid, track.id);
                } else {
                  window.__markVideoOn(pid, track.id);
                }
              }
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
            // In gapCheckInterval:
            if (gap > 1500 && isCurrentlyActive) {
              isCurrentlyActive = false;
              console.log(
                `[VIDEO_STOPPED] trackId=${track.id} — no frames for ${gap}ms`,
              );
              const pid = window.__videoTrackToParticipant[track.id];
              if (pid) {
                if (window.__presentationParticipants[pid]) {
                  window.__markScreenShareOff(pid, track.id);
                } else {
                  window.__markVideoOff(pid, track.id);
                }
              }
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

        // Detect presentation tiles immediately at bind time, before frames arrive
        const labelled =
          participantEl && participantEl.querySelector
            ? participantEl.querySelector('[aria-label*="presentation"]')
            : null;
        if (labelled && !window.__presentationParticipants[participantId]) {
          window.__presentationParticipants[participantId] = true;
          window.__markAsPresentation(participantId);
        }

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
                window.__correlationAttempts =
                  window.__correlationAttempts || {};
                window.__correlationAttempts[participantId] = window
                  .__correlationAttempts[participantId] || {
                  count: 0,
                  firstSeen: now,
                };
                window.__correlationAttempts[participantId].count++;
                console.log(
                  `[CORRELATION_MATCH] name="${name}" participantId=${participantId} matched audio trackId=${bestTrackId} gap=${bestGap}ms`,
                );
                window.__bindAudio(participantId, name, bestTrackId);
                window.__audioTrackToParticipant[bestTrackId] = participantId;
                window.__lastAudioActivity[participantId] = now;

                // Don't start a recorder while more than one track is spiking —
                // the recorder locks its audio track permanently, so a wrong pick
                // here would corrupt the entire recording. Wait for a clean moment.
                const competingSpikes = Object.keys(
                  window.__recentAudioSpikes,
                ).filter(
                  (tid) =>
                    tid !== bestTrackId &&
                    Math.abs(now - window.__recentAudioSpikes[tid].timestamp) <=
                      CORRELATION_WINDOW_MS,
                );

                if (competingSpikes.length === 0) {
                  const spikeLevel =
                    window.__recentAudioSpikes[bestTrackId].level;
                  const isStrongMatch = bestGap <= 150 && spikeLevel >= 0.1;

                  if (isStrongMatch) {
                    const attempt = window.__correlationAttempts[participantId];
                    console.log(
                      `[RECORDER_LOCKED] ${name} after ${attempt.count} attempt(s), first-seen-to-locked: ${now - attempt.firstSeen}ms`,
                    );
                    const vTrackId = Object.keys(
                      window.__videoTrackToParticipant,
                    ).find(
                      (t) =>
                        window.__videoTrackToParticipant[t] === participantId,
                    );
                    if (vTrackId) {
                      window.__startRecordingForParticipant(
                        participantId,
                        vTrackId,
                        name,
                        bestTrackId,
                      );
                    }
                  } else {
                    console.log(
                      `[RECORDER_WEAK_MATCH] ${name} gap=${bestGap}ms level=${spikeLevel.toFixed(4)} — not confident enough to claim yet`,
                    );
                  }
                } else {
                  console.log(
                    `[RECORDER_DEFERRED] ${name} (gap=${bestGap}ms, level=${window.__recentAudioSpikes[bestTrackId].level.toFixed(4)}) — competing: ${competingSpikes
                      .map((tid) => {
                        const competitorName =
                          window.__audioTrackToParticipant[tid] &&
                          window.__recorderState &&
                          window.__recorderState[
                            window.__audioTrackToParticipant[tid]
                          ]
                            ? window.__recorderState[
                                window.__audioTrackToParticipant[tid]
                              ].displayName
                            : window.__audioTrackToParticipant[tid] ||
                              "unbound";
                        const age =
                          now - window.__recentAudioSpikes[tid].timestamp;
                        return `${competitorName}@${window.__recentAudioSpikes[tid].level.toFixed(4)} (${age}ms ago)`;
                      })
                      .join(", ")}`,
                  );
                }

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

    // Periodically re-read names from the live DOM and update any mapper record
    // still holding "unknown" — catches tiles (especially screen shares) whose
    // label renders after the stream was already bound.
    function startNameResolutionSweep() {
      let knownTiles = new Set();

      setInterval(() => {
        const currentTiles = new Set();

        document.querySelectorAll("[data-participant-id]").forEach((tile) => {
          const pid = tile.getAttribute("data-participant-id");
          if (!pid) return;
          currentTiles.add(pid);

          const nameEl = tile.querySelector("span.notranslate");
          if (nameEl && nameEl.textContent) {
            window.__updateName(pid, nameEl.textContent);
            return;
          }

          const labelled = tile.querySelector('[aria-label*="presentation"]');
          if (labelled) {
            const label = labelled.getAttribute("aria-label");
            const match = label.match(/(?:Pin|Unpin)\s+(.+?)'s presentation/i);
            if (match && match[1]) {
              window.__updateName(pid, `${match[1]} (Presentation)`);
              if (!window.__presentationParticipants[pid]) {
                window.__presentationParticipants[pid] = true;
                window.__markAsPresentation(pid);
              }
            }
          }
        });

        // Tiles that existed last pass but are gone now → participant left
        knownTiles.forEach((pid) => {
          if (!currentTiles.has(pid)) {
            console.log(`[PARTICIPANT_LEFT] participantId=${pid}`);
            window.__stopRecordingForParticipant(pid);
          }
        });

        knownTiles = currentTiles;
      }, 2000);

      console.log("[NAME_SWEEP] Started periodic name resolution");
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

    // Remove spike entries older than the correlation window — without this they
    // linger and look like competing speakers long after the sound ended.
    function startSpikeCleanup() {
      setInterval(() => {
        const now = Date.now();
        Object.keys(window.__recentAudioSpikes).forEach((tid) => {
          if (
            now - window.__recentAudioSpikes[tid].timestamp >
            CORRELATION_WINDOW_MS
          ) {
            delete window.__recentAudioSpikes[tid];
          }
        });
      }, 200);
    }

    if (document.body) {
      startDomObserver();
      startSpeakerObserver();
      startAudioSilenceWatchdog();
      startNameResolutionSweep();
      startSpikeCleanup();
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        startDomObserver();
        startSpeakerObserver();
        startAudioSilenceWatchdog();
        startNameResolutionSweep();
        startSpikeCleanup();
      });
    }
  });

  page.on("console", (msg) => {
    const text = msg.text();
    if (
      text.includes("WEBRTC_TRACK") ||
      text.includes("MEDIA_STREAM") ||
      text.includes("TRACK_ENDED") ||
      // text.includes("VIDEO_STOPPED") ||
      // text.includes("VIDEO_RESUMED") ||
      text.includes("PC_CREATED") ||
      // text.includes("TRACK_MUTED") ||
      // text.includes("TRACK_UNMUTED") ||
      // text.includes("DOM_OBSERVER") ||
      // text.includes("SPEAKER_OBSERVER") ||
      text.includes("EVENT_VIDEO_ON") ||
      text.includes("EVENT_VIDEO_OFF") ||
      text.includes("EVENT_AUDIO_ON") ||
      text.includes("EVENT_AUDIO_OFF") ||
      // text.includes("NAME_SWEEP") ||
      // text.includes("EVENT_SCREEN_SHARE_ON") ||
      // text.includes("EVENT_SCREEN_SHARE_OFF") ||
      text.includes("RECORDER_STARTED") ||
      text.includes("CHUNK_EVENT") ||
      text.includes("CHUNK_SENT") ||
      text.includes("RECORDER_LOCKED") ||
      text.includes("RECORDER_ERROR") ||
      text.includes("RECORDER_STOPPED") ||
      // text.includes("PARTICIPANT_LEFT") ||
      // text.includes("RENDER_LOOP") ||
      text.includes("RENDER_TICK_ERROR") ||
      text.includes("RECORDER_DEFERRED") ||
      text.includes("CHUNK_ERROR") ||
      // text.includes("AUDIO_LEVEL") ||
      text.includes("RECORDER_WEAK_MATCH") ||
      text.includes("CORRELATION_MATCH") ||
      text.includes("WS_OPEN") ||
      text.includes("WS_CLIENT_ERROR") ||
      text.includes("WS_CLIENT_CLOSED") ||
      text.includes("CHUNK_QUEUED") ||
      text.includes("SPEAKER_CLASS_CHANGE")
    ) {
      console.log("BROWSER LOG:", text);
    }
  });

  page.on("close", () => console.log("PAGE CLOSED EVENT FIRED"));
  context.on("close", () => console.log("CONTEXT CLOSED EVENT FIRED"));


  await page.goto("https://meet.google.com/yhi-ausb-sgt");

  
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

  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log("Shutting down — stopping recorders...");
    try {
      await Promise.race([
        page.evaluate(() => window.__stopAllRecorders()),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("stopAllRecorders timed out")),
            5000,
          ),
        ),
      ]);
      await new Promise((r) => setTimeout(r, 3000));
    } catch (e) {
      console.log("Shutdown error:", e.message);
    }

    console.log(
      "[FINAL_MAPPER]",
      JSON.stringify(mapper.getMapperSnapshot(), null, 2),
    );
    console.log(
      "[FINAL_EVENT_HISTORY]",
      JSON.stringify(mapper.getEventHistorySnapshot(), null, 2),
    );
    console.log(
      "[FINAL_BINDING_HISTORY]",
      JSON.stringify(mapper.getBindingHistorySnapshot(), null, 2),
    );

    // Give browser-side sockets a moment to flush their last chunk before
    // closing streams — recorder.js already waits ~500ms after recorder.stop()
    // before calling ws.close(), so wait a bit longer than that here.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    closeAllChunkStreams();

    try {
      await context.close();
    } catch (e) {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);

  await new Promise(() => {});

  if (snapshotTimer) clearTimeout(snapshotTimer);
  console.log(
    "[FINAL_MAPPER]",
    JSON.stringify(mapper.getMapperSnapshot(), null, 2),
  );
  console.log(
    "[FINAL_EVENT_HISTORY]",
    JSON.stringify(mapper.getEventHistorySnapshot(), null, 2),
  );
  console.log(
    "[FINAL_BINDING_HISTORY]",
    JSON.stringify(mapper.getBindingHistorySnapshot(), null, 2),
  );
})();
