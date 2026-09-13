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

  function startRecordingForParticipant(
    participantId,
    videoTrackId,
    displayName,
    audioTrackId,
  ) {
    if (window.__recorders[participantId]) return;

    const videoTrack = window.__trackObjects[videoTrackId];
    const audioTrack = window.__trackObjects[audioTrackId];

    if (!videoTrack || !audioTrack) {
      console.log(
        `[RECORDER] Waiting — video=${!!videoTrack} audio=${!!audioTrack} for ${participantId}`,
      );
      return;
    }

    try {
      // --- Canvas setup (hidden, never attached to the DOM) ---
      const canvas = document.createElement("canvas");
      canvas.width = CANVAS_WIDTH;
      canvas.height = CANVAS_HEIGHT;
      const ctx = canvas.getContext("2d");

      // A hidden <video> element is what actually decodes the incoming track;
      // we draw from it onto the canvas each tick.
      const videoEl = document.createElement("video");
      videoEl.srcObject = new MediaStream([videoTrack]);
      videoEl.muted = true;
      videoEl.play().catch(() => {});

      // --- Combine canvas video + stable audio into one stream ---
      const canvasStream = canvas.captureStream(CANVAS_FPS);
      const combined = new MediaStream([
        canvasStream.getVideoTracks()[0],
        audioTrack,
      ]);

      const recorder = new MediaRecorder(combined, {
        mimeType: "video/webm;codecs=vp8,opus",
      });

      recorder.ondataavailable = async (event) => {
        console.log(
          `[CHUNK_EVENT] participantId=${participantId} size=${event.data ? event.data.size : 0}`,
        );
        if (event.data && event.data.size > 0) {
          try {
            const buffer = await event.data.arrayBuffer();
            await window.__saveChunk(
              participantId,
              Array.from(new Uint8Array(buffer)),
            );
            console.log(
              `[CHUNK_SENT] participantId=${participantId} bytes=${buffer.byteLength}`,
            );
          } catch (err) {
            console.log(
              `[CHUNK_ERROR] participantId=${participantId}: ${err.message}`,
            );
          }
        }
      };

      recorder.onerror = (e) =>
        console.log(`[RECORDER_ERROR] ${participantId}: ${e.error}`);

      recorder.start(2000);
      window.__recorders[participantId] = recorder;

      // Store everything this participant's render loop needs
      window.__recorderState[participantId] = {
        canvas,
        ctx,
        videoEl,
        displayName: displayName || "Unknown",
        lastFrameTime: 0,
        lastVideoTime: 0,
      };

      console.log(
        `[RECORDER_STARTED] participantId=${participantId} videoTrackId=${videoTrackId} audioTrackId=${audioTrackId} (canvas ${CANVAS_WIDTH}x${CANVAS_HEIGHT} @${CANVAS_FPS}fps)`,
      );
    } catch (err) {
      console.log(`[RECORDER_ERROR] ${participantId}: ${err.message}`);
    }
  }

  // Called when speaker-correlation identifies this participant's audio track.
  // Connects it into the ALREADY-RUNNING audio graph — no track swap, no restart.
  function attachAudioToRecording(participantId, audioTrackId) {
    const state = window.__recorderState[participantId];
    if (!state || state.audioConnected) return;

    const audioTrack = window.__trackObjects[audioTrackId];
    if (!audioTrack) return;

    try {
      const source = state.audioCtx.createMediaStreamSource(
        new MediaStream([audioTrack]),
      );
      source.connect(state.gainNode);
      state.audioConnected = true;
      state.audioSource = source;

      console.log(
        `[RECORDER_AUDIO_ATTACHED] participantId=${participantId} audioTrackId=${audioTrackId}`,
      );
    } catch (err) {
      console.log(
        `[RECORDER_ERROR] audio attach failed for ${participantId}: ${err.message}`,
      );
    }
  }

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
    delete window.__recorderState[participantId];
  }

  function stopAllRecorders() {
    Object.keys(window.__recorders).forEach((pid) => {
      const r = window.__recorders[pid];
      if (r && r.state !== "inactive") {
        r.stop();
        console.log(`[RECORDER_STOPPED] participantId=${pid}`);
      }
    });
    window.__recorders = {};
    window.__recorderState = {};
  }

  window.__startRecordingForParticipant = startRecordingForParticipant;
  window.__attachAudioToRecording = attachAudioToRecording;
  window.__stopRecordingForParticipant = stopRecordingForParticipant;
  window.__stopAllRecorders = stopAllRecorders;

  // ... entire existing contents of recorder.js go inside this block ...
}
