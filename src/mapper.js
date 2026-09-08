// mapper.js
// Core identity-binding data structure + separate event history,
// built from validated findings:
// - data-ssrc on a tile matches the WebRTC VIDEO MediaStream's streamId (reliable, ~86%+ direct match)
// - audio has no DOM data-attribute; binding requires active-speaker correlation
//   (tile's .DYfzY.cYKTje class-change timestamp vs. AUDIO_LEVEL spike timestamp, within a small tolerance)

// ---- Mapper: identity binding, keyed by participantId ----
// Kept small and fast — read/written constantly during live correlation.
const mapper = new Map();

function ensureParticipant(participantId, name) {
  if (!mapper.has(participantId)) {
    mapper.set(participantId, {
      participantId,
      name,
      videoStreamId: null, // == data-ssrc == WebRTC video streamId
      currentVideoTrackId: null,
      currentAudioTrackId: null,
      currentState: {
        videoActive: false,
        audioActive: false,
      },
    });
  } else {
    // keep name fresh in case it was "unknown" earlier
    const record = mapper.get(participantId);
    if (name && name !== "unknown") record.name = name;
  }
  return mapper.get(participantId);
}

// Called when a tile's data-ssrc appears/changes (video binding).
function bindVideo(participantId, name, ssrc, trackId) {
  const record = ensureParticipant(participantId, name);
  record.videoStreamId = ssrc;
  record.currentVideoTrackId = trackId;
  record.currentState.videoActive = true;
  logEvent(participantId, "video_on", trackId);
}

function unbindVideo(participantId) {
  const record = mapper.get(participantId);
  if (!record) return;
  record.currentState.videoActive = false;
  logEvent(participantId, "video_off", record.currentVideoTrackId);
}

// Called when active-speaker correlation confirms a match
// (audio spike timestamp closely matches speaker-class-change timestamp for this tile).
function bindAudio(participantId, name, trackId) {
  const record = ensureParticipant(participantId, name);
  const isNewBinding = record.currentAudioTrackId !== trackId;
  record.currentAudioTrackId = trackId;
  record.currentState.audioActive = true;
  console.log("[DEBUG_BIND_AUDIO_STATE]", {
    mapperSize: mapper.size,
    record,
  });
  if (isNewBinding) {
    logEvent(participantId, "audio_on", trackId);
  }
}

function unbindAudio(participantId) {
  const record = mapper.get(participantId);
  if (!record) return;
  record.currentState.audioActive = false;
  logEvent(participantId, "audio_off", record.currentAudioTrackId);
}

function getMapperSnapshot() {
  console.log("[DEBUG_SNAPSHOT_STATE]", {
    mapperSize: mapper.size,
    entries: Array.from(mapper.entries()),
  });
  return Array.from(mapper.values());
}

// ---- Event History: separate structure, keyed by participantId ----
// Append-only during the meeting. Only read once at the end, when merging
// with ASR output — never touched by the live correlation hot path.
const eventHistory = new Map();

function logEvent(participantId, eventType, trackId) {
  if (!eventHistory.has(participantId)) {
    eventHistory.set(participantId, []);
  }
  eventHistory.get(participantId).push({
    timestamp: Date.now(),
    event: eventType,
    trackId: trackId || null,
  });
  console.log("[DEBUG_EVENT_HISTORY_STATE]", {
    eventHistorySize: eventHistory.size,
  });
}

function getEventHistorySnapshot() {
  const result = {};
  eventHistory.forEach((events, participantId) => {
    result[participantId] = events;
  });
  return result;
}

module.exports = {
  bindVideo,
  unbindVideo,
  bindAudio,
  unbindAudio,
  getMapperSnapshot,
  getEventHistorySnapshot,
};
