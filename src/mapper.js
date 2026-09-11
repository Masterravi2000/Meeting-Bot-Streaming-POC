// mapper.js
// Mapper = identity/negotiation binding ONLY (participant <-> track/stream IDs, CURRENT state).
// It does NOT track live on/off state — that's the Event History's job.
// Binding History = timestamped record of WHICH trackId was valid for a participant, WHEN
//   (only appends a new entry when the trackId actually changes — not on every repeated bind call).
// Event History = the single source of truth for REAL on/off transitions of actual media.
//
// Reconciliation (done once, after the meeting, not live) uses Binding History to verify
// each Event History entry's trackId was genuinely correct for that participant at that timestamp —
// correcting any transient misattribution caused by overlapping-speech correlation errors.

const mapper = new Map();
const bindingHistory = new Map(); // participantId -> [{ kind, trackId, timestamp }]

function ensureParticipant(participantId, name) {
  if (!mapper.has(participantId)) {
    mapper.set(participantId, {
      participantId,
      name,
      videoStreamId: null, // == data-ssrc == WebRTC video streamId
      currentVideoTrackId: null,
      currentAudioTrackId: null,
      videoBound: false, // negotiation/binding succeeded (stream exists, may still be off)
      audioBound: false, // negotiation/binding succeeded
    });
  } else {
    const record = mapper.get(participantId);
    if (name && name !== "unknown") record.name = name;
  }
  return mapper.get(participantId);
}

// Re-resolve a name that was captured as "unknown" at bind time.
// Meet sometimes renders the tile's label AFTER the stream binds (common for
// screen-share tiles), leaving the record stuck with "unknown".
function updateName(participantId, name) {
  const record = mapper.get(participantId);
  if (!record) return;
  if (name && name !== "unknown" && record.name !== name) {
    record.name = name;
  }
}

function logBindingChange(participantId, kind, trackId) {
  if (!bindingHistory.has(participantId)) {
    bindingHistory.set(participantId, []);
  }
  bindingHistory.get(participantId).push({
    kind, // "audio" or "video"
    trackId,
    timestamp: Date.now(),
  });
}

// --- Negotiation/binding. Only logs to binding history when the trackId actually changes. ---
function bindVideo(participantId, name, ssrc, trackId) {
  const record = ensureParticipant(participantId, name);
  const isNewTrack = record.currentVideoTrackId !== trackId;

  record.videoStreamId = ssrc;
  record.currentVideoTrackId = trackId;
  record.videoBound = true;

  if (isNewTrack) {
    logBindingChange(participantId, "video", trackId);
  }
}

function bindAudio(participantId, name, trackId) {
  const record = ensureParticipant(participantId, name);
  const isNewTrack = record.currentAudioTrackId !== trackId;

  record.currentAudioTrackId = trackId;
  record.audioBound = true;

  if (isNewTrack) {
    logBindingChange(participantId, "audio", trackId);
  }
}

// --- Real activity transitions. These ONLY log to event history — no mapper state to update. ---
// Dedup (only logging genuine on->off / off->on transitions) is the caller's (bot.js) responsibility,
// since the mapper no longer holds "current state" to check against.
function markVideoOn(participantId, trackId) {
  logEvent(participantId, "video_on", trackId);
}

function markVideoOff(participantId, trackId) {
  logEvent(participantId, "video_off", trackId);
}

// Add these alongside markVideoOn/markVideoOff:

function markScreenShareOn(participantId, trackId) {
  logEvent(participantId, "screen_share_on", trackId);
}

function markScreenShareOff(participantId, trackId) {
  logEvent(participantId, "screen_share_off", trackId);
}

// Mark a record as a presentation tile (so downstream knows it's not a camera)
function markAsPresentation(participantId) {
  const record = mapper.get(participantId);
  if (record) record.isPresentation = true;
}

function markAudioOn(participantId, trackId) {
  logEvent(participantId, "audio_on", trackId);
}

function markAudioOff(participantId, trackId) {
  logEvent(participantId, "audio_off", trackId);
}

function getMapperSnapshot() {
  return Array.from(mapper.values());
}

function getBindingHistorySnapshot() {
  const result = {};
  bindingHistory.forEach((entries, participantId) => {
    result[participantId] = entries;
  });
  return result;
}

// ---- Event History: separate structure, the only place real on/off state lives ----
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
  bindAudio,
  markVideoOn,
  updateName,
  markVideoOff,
  markAudioOn,
  markScreenShareOn,
  markScreenShareOff,
  markAsPresentation,
  markAudioOff,
  getMapperSnapshot,
  getEventHistorySnapshot,
  getBindingHistorySnapshot,
};
