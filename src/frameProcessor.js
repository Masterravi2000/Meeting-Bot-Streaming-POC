// frameProcessor.js
// Runs in the BROWSER context (injected via context.addInitScript({ path: ... })).
// Demonstrates that the mapper's trackId values connect all the way through
// to real PCM (audio) / YUV (video) data frames via MediaStreamTrackProcessor.

window.__trackObjects = window.__trackObjects || {}; // trackId -> actual MediaStreamTrack object

async function demonstrateFrameAccess(trackId, kind) {
  const track = window.__trackObjects[trackId];
  if (!track) {
    console.log(`[FRAME_DEMO] No track object found for trackId=${trackId}`);
    return;
  }

  if (!window.MediaStreamTrackProcessor) {
    console.log(`[FRAME_DEMO] MediaStreamTrackProcessor not supported in this browser`);
    return;
  }

  try {
    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();

    for (let i = 0; i < 3; i++) {
      const { value: frame, done } = await reader.read();
      if (done) break;

      if (kind === "audio") {
        console.log(
          `[PCM_FRAME] trackId=${trackId} sampleRate=${frame.sampleRate} numberOfFrames=${frame.numberOfFrames} numberOfChannels=${frame.numberOfChannels} format=${frame.format}`,
        );
      } else if (kind === "video") {
        console.log(
          `[YUV_FRAME] trackId=${trackId} format=${frame.format} codedWidth=${frame.codedWidth} codedHeight=${frame.codedHeight} timestamp=${frame.timestamp}`,
        );
      }

      frame.close();
    }

    reader.releaseLock();
  } catch (err) {
    console.log(`[FRAME_DEMO_ERROR] trackId=${trackId} kind=${kind} error=${err.message}`);
  }
}

window.__demonstrateFrameAccess = demonstrateFrameAccess;