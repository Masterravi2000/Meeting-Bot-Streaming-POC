// mapper.js
// Mapper = identity/negotiation binding ONLY (participant <-> track/stream IDs).
// It does NOT track live on/off state — that's the Event History's job.
// Event History = the single source of truth for REAL on/off transitions of actual media.

const mapper = new Map();

function ensureParticipant(participantId, name) {
  if (!mapper.has(participantId)) {
    mapper.set(participantId, {
      participantId,
      name,
      videoStreamId: null,       // == data-ssrc == WebRTC video streamId
      currentVideoTrackId: null,
      currentAudioTrackId: null,
      videoBound: false,         // negotiation/binding succeeded (stream exists, may still be off)
      audioBound: false,         // negotiation/binding succeeded
    });
  } else {
    const record = mapper.get(participantId);
    if (name && name !== "unknown") record.name = name;
  }
  return mapper.get(participantId);
}

// --- Negotiation/binding only. Pure identity <-> track mapping. ---
function bindVideo(participantId, name, ssrc, trackId) {
  const record = ensureParticipant(participantId, name);
  record.videoStreamId = ssrc;
  record.currentVideoTrackId = trackId;
  record.videoBound = true;
}

function bindAudio(participantId, name, trackId) {
  const record = ensureParticipant(participantId, name);
  record.currentAudioTrackId = trackId;
  record.audioBound = true;
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

function markAudioOn(participantId, trackId) {
  logEvent(participantId, "audio_on", trackId);
}

function markAudioOff(participantId, trackId) {
  logEvent(participantId, "audio_off", trackId);
}

function getMapperSnapshot() {
  return Array.from(mapper.values());
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
  markVideoOff,
  markAudioOn,
  markAudioOff,
  getMapperSnapshot,
  getEventHistorySnapshot,
};