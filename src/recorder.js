// Only run in the top-level frame — addInitScript injects into every iframe,
// and separate frames have separate window objects, so state would be fragmented.
if (window.self !== window.top) {
  console.log("[RECORDER_SKIP] Not the top frame, skipping recorder setup");
} else {
  // recorder.js — runs in the BROWSER context.
  //
  // Canvas + Web Audio compositor approach:
  //   - A hidden canvas per participant is drawn to continuously (video frames when
  //     available, black + name when not), so MediaRecorder never sees a gap.
  //   - A Web Audio graph provides a STABLE audio track from the start; the real
  //     audio source is connected into it later, once speaker-correlation binds it.
  //   - Both tracks go to one MediaRecorder, so the browser handles A/V sync natively.

  window.__recorders = window.__recorders || {};
  window.__recorderState = window.__recorderState || {}; // participantId -> state bundle
  window.__segmentCounters = window.__segmentCounters || {};
  window.__lastRenegotiationAt = window.__lastRenegotiationAt || {};
  window.__shuttingDown = window.__shuttingDown || false;

  const CANVAS_FPS = 15;
  const CANVAS_WIDTH = 640;
  const CANVAS_HEIGHT = 360;
  const FRAME_STALE_MS = 500; // if no new frame within this, treat as camera-off

  // Single shared AudioContext for all participants
  window.__audioContext = window.__audioContext || new AudioContext();

  console.log("[AUDIO_CONTEXT] initial state=" + window.__audioContext.state);
  if (window.__audioContext.state === "suspended") {
    window.__audioContext
      .resume()
      .then(() =>
        console.log(
          "[AUDIO_CONTEXT] resumed, state=" + window.__audioContext.state,
        ),
      )
      .catch((e) => console.log("[AUDIO_CONTEXT_ERROR] " + e.message));
  }

  // function arrayBufferToBase64(buffer) {
  //   let binary = "";
  //   const bytes = new Uint8Array(buffer);
  //   const chunkSize = 0x8000;
  //   for (let i = 0; i < bytes.length; i += chunkSize) {
  //     binary += String.fromCharCode.apply(
  //       null,
  //       bytes.subarray(i, i + chunkSize),
  //     );
  //   }
  //   return btoa(binary);
  // }

  function nextSegment(participantId) {
    window.__segmentCounters[participantId] =
      (window.__segmentCounters[participantId] || 0) + 1;
    return window.__segmentCounters[participantId];
  }

  function startRecordingForParticipant(
    participantId,
    videoTrackId,
    displayName,
    audioTrackId, // now optional — null/undefined means video-only mode
  ) {
    if (window.__shuttingDown) return;
    if (window.__presentationParticipants[participantId]) {
      console.log(
        `[RECORDER_SKIP_SCREEN_SHARE] participantId=${participantId} — screen-share recording not implemented yet`,
      );
      return;
    }
    if (window.__recorders[participantId]) return;

    const videoTrack = window.__trackObjects[videoTrackId];
    const audioTrack = audioTrackId
      ? window.__trackObjects[audioTrackId]
      : null;

    if (!videoTrack) {
      console.log(`[RECORDER] Waiting — video not ready for ${participantId}`);
      return;
    }
    if (audioTrackId && !audioTrack) {
      console.log(`[RECORDER] Waiting — audio not ready for ${participantId}`);
      return;
    }

    try {
      const segmentIndex = nextSegment(participantId);
      const segKey = `${participantId}::seg${segmentIndex}`;

      let ws = new WebSocket(
        `ws://127.0.0.1:8765?participantId=${encodeURIComponent(segKey)}&hasAudio=${audioTrack ? "1" : "0"}`,
      );
      ws.binaryType = "arraybuffer";

      const chunkQueue = [];
      let wsOpen = false;
      let connectionSettled = false;

      ws.onopen = () => {
        connectionSettled = true;
        wsOpen = true;
        console.log(`[WS_OPEN] participantId=${segKey}`);
        while (chunkQueue.length > 0) {
          ws.send(chunkQueue.shift());
        }
      };

      ws.onerror = () => {
        console.log(
          `[WS_CLIENT_ERROR] participantId=${segKey} origin=${location.origin} url=${location.href}`,
        );
      };

      ws.onclose = (event) => {
        console.log(
          `[WS_CLIENT_CLOSED] participantId=${segKey} code=${event.code} reason="${event.reason}" wasClean=${event.wasClean}`,
        );
      };

      setTimeout(() => {
        if (connectionSettled) return;
        console.log(
          `[WS_CONNECT_TIMEOUT] participantId=${segKey} — retrying once`,
        );
        try {
          ws.close();
        } catch (e) {}

        const retryWs = new WebSocket(
          `ws://127.0.0.1:8765?participantId=${encodeURIComponent(segKey)}&hasAudio=${audioTrack ? "1" : "0"}`,
        );
        retryWs.binaryType = "arraybuffer";

        retryWs.onopen = () => {
          connectionSettled = true;
          wsOpen = true;
          ws = retryWs;
          if (window.__recorderState[participantId]) {
            window.__recorderState[participantId].ws = retryWs;
          }
          console.log(`[WS_OPEN_AFTER_RETRY] participantId=${segKey}`);
          while (chunkQueue.length > 0) {
            retryWs.send(chunkQueue.shift());
          }
        };
        retryWs.onerror = () => {
          console.log(`[WS_RETRY_FAILED] participantId=${segKey}`);
        };
        retryWs.onclose = (event) => {
          console.log(
            `[WS_RETRY_CLOSED] participantId=${segKey} code=${event.code} reason="${event.reason}"`,
          );
        };
      }, 5000);

      const canvas = document.createElement("canvas");
      canvas.width = CANVAS_WIDTH;
      canvas.height = CANVAS_HEIGHT;
      const ctx = canvas.getContext("2d");

      const videoEl = document.createElement("video");
      videoEl.srcObject = new MediaStream([videoTrack]);
      videoEl.muted = true;
      videoEl.play().catch(() => {});

      const canvasStream = canvas.captureStream(CANVAS_FPS);
      const tracks = [canvasStream.getVideoTracks()[0]];
      if (audioTrack) tracks.push(audioTrack);
      const combined = new MediaStream(tracks);

      const mimeType = audioTrack
        ? "video/webm;codecs=vp8,opus"
        : "video/webm;codecs=vp8";
      const recorder = new MediaRecorder(combined, { mimeType });

      recorder.ondataavailable = async (event) => {
        // console.log(
        //   `[CHUNK_EVENT] participantId=${segKey} size=${event.data ? event.data.size : 0}`,
        // );
        if (event.data && event.data.size > 0) {
          try {
            const buffer = await event.data.arrayBuffer();
            if (wsOpen && ws.readyState === WebSocket.OPEN) {
              ws.send(buffer);
              // console.log(
              //   `[CHUNK_SENT] participantId=${segKey} bytes=${buffer.byteLength}`,
              // );
            } else {
              chunkQueue.push(buffer);
              console.log(
                `[CHUNK_QUEUED] participantId=${segKey} bytes=${buffer.byteLength} — socket not open yet`,
              );
            }
          } catch (err) {
            console.log(
              `[CHUNK_ERROR] participantId=${segKey}: ${err.message}`,
            );
          }
        }
      };

      recorder.onerror = (e) =>
        console.log(`[RECORDER_ERROR] ${segKey}: ${e.error}`);

      recorder.start(2000);
      window.__recorders[participantId] = recorder;

      window.__recorderState[participantId] = {
        canvas,
        ctx,
        videoEl,
        displayName: displayName || "Unknown",
        lastFrameTime: 0,
        lastVideoTime: 0,
        ws,
        mode: audioTrack ? "full" : "video-only",
        segmentIndex,
        videoTrackId,
        audioTrackId: audioTrackId || null,
      };

      console.log(
        `[RECORDER_STARTED] participantId=${participantId} segment=${segmentIndex} mode=${audioTrack ? "full" : "video-only"} videoTrackId=${videoTrackId} audioTrackId=${audioTrackId || "none"} (canvas ${CANVAS_WIDTH}x${CANVAS_HEIGHT} @${CANVAS_FPS}fps)`,
      );
    } catch (err) {
      console.log(`[RECORDER_ERROR] ${participantId}: ${err.message}`);
    }
  }

  function handleAudioIdentified(
    participantId,
    videoTrackId,
    displayName,
    audioTrackId,
  ) {
    if (window.__shuttingDown) return;
    if (window.__presentationParticipants[participantId]) return;

    const state = window.__recorderState[participantId];

    if (!state) {
      startRecordingForParticipant(
        participantId,
        videoTrackId,
        displayName,
        audioTrackId,
      );
      return;
    }

    if (state.mode === "video-only") {
      console.log(
        `[RECORDER_HANDOFF] participantId=${participantId} video-only -> full at ${Date.now()}`,
      );
      stopRecordingForParticipant(participantId);
      startRecordingForParticipant(
        participantId,
        videoTrackId,
        displayName,
        audioTrackId,
      );
      return;
    }

    // Already fully recording — is this a genuinely different audio track
    // than what's currently in use? If so, that's a renegotiation.
    // Already fully recording — is this a genuinely different audio track
    // than what's currently in use?
    if (state.audioTrackId && state.audioTrackId !== audioTrackId) {
      const oldPcId = window.__trackToPcId
        ? window.__trackToPcId[state.audioTrackId]
        : undefined;
      const newPcId = window.__trackToPcId
        ? window.__trackToPcId[audioTrackId]
        : undefined;

      // Same connection, just the SFU reassigning which track carries this
      // person's voice — NOT a real renegotiation. Update bookkeeping only,
      // do not touch the running recorder.
      if (newPcId === oldPcId) {
        console.log(
          `[AUDIO_SLOT_REASSIGNED_SAME_PC] participantId=${participantId} oldAudioTrackId=${state.audioTrackId} newAudioTrackId=${audioTrackId} pcId=${newPcId} — ignoring, not a real renegotiation`,
        );
        return;
      }

      const RENEGOTIATION_COOLDOWN_MS = 2000;
      const lastReneg = window.__lastRenegotiationAt[participantId] || 0;
      if (Date.now() - lastReneg < RENEGOTIATION_COOLDOWN_MS) {
        console.log(
          `[RENEGOTIATION_DEBOUNCED] participantId=${participantId} — too soon after last restart, skipping`,
        );
        return;
      }
      window.__lastRenegotiationAt[participantId] = Date.now();

      const pairedVideoTrackId =
        (newPcId &&
          window.__pcIdTracks[newPcId] &&
          window.__pcIdTracks[newPcId].video) ||
        state.videoTrackId;

      console.log(
        `[RECORDER_RENEGOTIATION_DETECTED] participantId=${participantId} oldAudioTrackId=${state.audioTrackId} newAudioTrackId=${audioTrackId} oldPcId=${oldPcId} newPcId=${newPcId} (via audio correlation)`,
      );
      stopRecordingForParticipant(participantId);
      startRecordingForParticipant(
        participantId,
        pairedVideoTrackId,
        displayName,
        audioTrackId,
      );
      console.log(
        `[RECORDER_RENEGOTIATION_RESTART] participantId=${participantId} newVideoTrackId=${pairedVideoTrackId} newAudioTrackId=${audioTrackId}`,
      );
    }
  }

  function handleVideoIdentified(participantId, videoTrackId, displayName) {
    if (window.__shuttingDown) return;
    if (window.__presentationParticipants[participantId]) return;

    const state = window.__recorderState[participantId];
    if (!state) return; // not recording yet — the audio path or initial join handles first start

    if (state.videoTrackId && state.videoTrackId !== videoTrackId) {
      const RENEGOTIATION_COOLDOWN_MS = 2000;
      const lastReneg = window.__lastRenegotiationAt[participantId] || 0;
      if (Date.now() - lastReneg < RENEGOTIATION_COOLDOWN_MS) {
        console.log(
          `[RENEGOTIATION_DEBOUNCED] participantId=${participantId} — too soon after last restart, skipping`,
        );
        return;
      }
      window.__lastRenegotiationAt[participantId] = Date.now();

      const newPcId = window.__trackToPcId
        ? window.__trackToPcId[videoTrackId]
        : undefined;
      const pairedAudioTrackId =
        (newPcId &&
          window.__pcIdTracks[newPcId] &&
          window.__pcIdTracks[newPcId].audio) ||
        null;
      const finalAudioTrackId = pairedAudioTrackId || state.audioTrackId;

      console.log(
        `[RECORDER_RENEGOTIATION_DETECTED] participantId=${participantId} oldVideoTrackId=${state.videoTrackId} newVideoTrackId=${videoTrackId} (via srcObject video identification)`,
      );
      stopRecordingForParticipant(participantId);
      startRecordingForParticipant(
        participantId,
        videoTrackId,
        displayName,
        finalAudioTrackId,
      );
      console.log(
        `[RECORDER_RENEGOTIATION_RESTART] participantId=${participantId} newVideoTrackId=${videoTrackId} newAudioTrackId=${finalAudioTrackId || "pending"}`,
      );
    }
  }

  window.__handleAudioIdentified = handleAudioIdentified;
  window.__handleVideoIdentified = handleVideoIdentified;

  // --- Single shared render loop for ALL participants ---
  function renderTick() {
    try {
      const now = performance.now();

      window.__tickCount = (window.__tickCount || 0) + 1;
      if (window.__tickCount % 30 === 0) {
        console.log(
          `[RENDER_TICK] count=${window.__tickCount} participants=${Object.keys(window.__recorderState).length}`,
        );
      }

      Object.keys(window.__recorderState).forEach((participantId) => {
        const s = window.__recorderState[participantId];
        if (!s) return;

        const v = s.videoEl;
        const hasLiveFrame =
          v.readyState >= 2 && v.videoWidth > 0 && !v.paused && !v.ended;

        if (hasLiveFrame && v.currentTime !== s.lastVideoTime) {
          // Fresh frame → draw it, letterboxed to fit the fixed canvas size
          s.lastVideoTime = v.currentTime;
          s.lastFrameTime = now;

          s.ctx.fillStyle = "#000";
          s.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

          const scale = Math.min(
            CANVAS_WIDTH / v.videoWidth,
            CANVAS_HEIGHT / v.videoHeight,
          );
          const dw = v.videoWidth * scale;
          const dh = v.videoHeight * scale;
          s.ctx.drawImage(
            v,
            (CANVAS_WIDTH - dw) / 2,
            (CANVAS_HEIGHT - dh) / 2,
            dw,
            dh,
          );
        } else if (now - s.lastFrameTime > FRAME_STALE_MS) {
          // Camera off / no frames → black screen with name.
          // Must repaint EVERY tick — captureStream() only emits frames while the
          // canvas is actively being drawn to.
          s.ctx.fillStyle = "#202124";
          s.ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

          s.ctx.fillStyle = "#ffffff";
          s.ctx.font = "24px sans-serif";
          s.ctx.textAlign = "center";
          s.ctx.textBaseline = "middle";
          s.ctx.fillText(s.displayName, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
        }
      });
    } catch (err) {
      console.log(`[RENDER_TICK_ERROR] ${err.message} | ${err.stack}`);
    }
  }

  // Start the shared loop once.
  // setInterval is used instead of requestAnimationFrame because rAF is throttled
  // or suspended entirely in headless Chrome, which would stop the canvas being
  // drawn to — and captureStream() only emits frames while drawing happens.
  if (!window.__renderLoopStarted) {
    window.__renderLoopStarted = true;
    setInterval(renderTick, Math.floor(1000 / CANVAS_FPS));
    console.log(
      "[RENDER_LOOP] Started shared canvas render loop (setInterval)",
    );
  }

  function stopRecordingForParticipant(participantId) {
    const r = window.__recorders[participantId];
    if (r && r.state !== "inactive") {
      r.stop();
      delete window.__recorders[participantId];
      console.log(`[RECORDER_STOPPED] participantId=${participantId}`);
    }
    const state = window.__recorderState[participantId];
    if (state && state.ws) {
      setTimeout(() => state.ws.close(), 500);
    }
    delete window.__recorderState[participantId];
  }

  function stopAllRecorders() {
    const pids = Object.keys(window.__recorders);

    pids.forEach((pid) => {
      const r = window.__recorders[pid];
      if (r && r.state !== "inactive") {
        r.stop();
        console.log(`[RECORDER_STOPPED] participantId=${pid}`);
      }
    });

    // Give MediaRecorder's final async dataavailable event time to fire and
    // send before we close the sockets out from under it.
    setTimeout(() => {
      pids.forEach((pid) => {
        const state = window.__recorderState[pid];
        if (state && state.ws) {
          try {
            state.ws.close();
          } catch (e) {}
          console.log(`[WS_CLOSED_ON_SHUTDOWN] participantId=${pid}`);
        }
      });

      window.__recorders = {};
      window.__recorderState = {};
      console.log("[STOP_ALL_RECORDERS_COMPLETE]");
    }, 2000);
  }

  window.__startRecordingForParticipant = startRecordingForParticipant;
  // window.__upgradeToFullRecording = upgradeToFullRecording;
  // window.__attachAudioToRecording = attachAudioToRecording;
  window.__stopRecordingForParticipant = stopRecordingForParticipant;
  window.__stopAllRecorders = stopAllRecorders;

  // ... entire existing contents of recorder.js go inside this block ...
}
