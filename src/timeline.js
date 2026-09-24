// timeline.js — records when each participant's recording started, so the
// player knows when each tile should appear. Pure Node, no browser work.
// Writes <sessionDir>/timeline.json (a few tiny sync writes per meeting).

const fs = require("fs");
const path = require("path");

const state = { sessionId: null, meetingStart: null, participants: {} };
const knownNames = {}; // names can arrive (from the DOM) before a participant's recording starts
let outFile = null;

function init(sessionDir, sessionId) {
  fs.mkdirSync(sessionDir, { recursive: true });
  outFile = path.join(sessionDir, "timeline.json");
  state.sessionId = sessionId || path.basename(sessionDir);
  flush();
}

// Call once when a participant's FIRST segment (seg1) connects.
// Repeated calls for the same participant are ignored.
function markStart(participantId, name) {
  if (!participantId || state.participants[participantId]) return;
  const now = Date.now();
  if (state.meetingStart == null) state.meetingStart = now;
  state.participants[participantId] = { id: participantId, name: name || knownNames[participantId] || null, startedAt: now, file: null };
  flush();
}

// Optional: fill in / fix a name later (e.g. from mapper once it's resolved).
function setName(participantId, name) {
  if (!participantId || !name || name === "unknown") return;
  knownNames[participantId] = name;
  const p = state.participants[participantId];
  if (p && name && p.name !== name) { p.name = name; flush(); }
}

// Call from stitch.js when a participant's final .mp4 is written.
function setOutput(participantId, filePath) {
  const p = state.participants[participantId];
  if (p) { p.file = path.basename(filePath); flush(); }
}

function flush() {
  if (!outFile) return;
  try { fs.writeFileSync(outFile, JSON.stringify(state, null, 2)); }
  catch (e) { console.error("[TIMELINE] write failed:", e.message); } // never throw into the bot
}

module.exports = { init, markStart, setName, setOutput };