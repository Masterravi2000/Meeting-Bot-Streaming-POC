#!/usr/bin/env node
/**
 * analyze-track-reassignment.js
 *
 * Parses a saved bot log file (the full stdout you captured during a test
 * run, ending in Ctrl+C) and checks whether any audio trackId got attached
 * to more than one participant during the meeting.
 *
 * Usage:
 *   node analyze-track-reassignment.js path/to/log.txt
 *
 * Requires the log to contain a [FINAL_BINDING_HISTORY] block (printed on
 * shutdown) and, optionally, [SPEAKER_CLASS_CHANGE] lines for overlap
 * cross-checking.
 */

const fs = require('fs');

const logPath = process.argv[2];
if (!logPath) {
  console.error('Usage: node analyze-track-reassignment.js <log-file>');
  process.exit(1);
}

const raw = fs.readFileSync(logPath, 'utf8');

// ---------- helpers ----------

// Extract JSON blocks that start right after a marker, using brace/bracket
// matching (needed because these blocks are pretty-printed across many lines).
function extractJsonAfter(text, marker) {
  const results = [];
  let idx = text.indexOf(marker);
  while (idx !== -1) {
    const searchFrom = idx + marker.length;
    const braceStart = text.indexOf('{', searchFrom);
    const bracketStart = text.indexOf('[', searchFrom);
    let start;
    if (braceStart === -1) start = bracketStart;
    else if (bracketStart === -1) start = braceStart;
    else start = Math.min(braceStart, bracketStart);

    if (start === -1) break;

    const openChar = text[start];
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === openChar) depth++;
      else if (text[i] === closeChar) {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end !== -1) {
      const jsonStr = text.slice(start, end + 1);
      try {
        results.push(JSON.parse(jsonStr));
      } catch (e) {
        // malformed/truncated block (e.g. mid-print when Ctrl+C hit) — skip it
      }
      idx = text.indexOf(marker, end);
    } else {
      break;
    }
  }
  return results;
}

// ---------- parse binding history: authoritative per-participant [{kind, trackId, timestamp}] ----------

const bindingBlocks = extractJsonAfter(raw, '[FINAL_BINDING_HISTORY]');
const bindingHistory = bindingBlocks.length ? bindingBlocks[bindingBlocks.length - 1] : null;

if (!bindingHistory) {
  console.error(
    'No [FINAL_BINDING_HISTORY] block found. Make sure the run was stopped with ' +
    'Ctrl+C so the shutdown snapshot got printed, then re-run this script on that log.'
  );
  process.exit(1);
}

// ---------- parse SPEAKER_CLASS_CHANGE lines (for overlap cross-check) ----------

const speakerChanges = [];
const speakerRegex =
  /\[SPEAKER_CLASS_CHANGE\]\s*participantId=(\S+)\s*name=(.*?)\s*newClass="([^"]*)"\s*timestamp=(\d+)/g;
let m;
while ((m = speakerRegex.exec(raw)) !== null) {
  speakerChanges.push({
    participantId: m[1],
    name: m[2].trim(),
    newClass: m[3],
    timestamp: Number(m[4]),
  });
}
speakerChanges.sort((a, b) => a.timestamp - b.timestamp);

// ---------- invert binding history: trackId -> [{participantId, kind, timestamp}] ----------

const trackTimeline = new Map();

for (const [participantId, events] of Object.entries(bindingHistory)) {
  for (const ev of events) {
    if (!trackTimeline.has(ev.trackId)) trackTimeline.set(ev.trackId, []);
    trackTimeline.get(ev.trackId).push({
      participantId,
      kind: ev.kind,
      timestamp: ev.timestamp,
    });
  }
}

for (const arr of trackTimeline.values()) {
  arr.sort((a, b) => a.timestamp - b.timestamp);
}

// ---------- find trackIds shared by more than one participant (audio only) ----------

const OVERLAP_WINDOW_MS = 2000; // how close a speaker-class-change must be to count as "during overlap"
const findings = [];

for (const [trackId, events] of trackTimeline.entries()) {
  const audioEvents = events.filter((e) => e.kind === 'audio');
  const distinctParticipants = new Set(audioEvents.map((e) => e.participantId));

  if (distinctParticipants.size > 1) {
    const handoffs = [];
    for (let i = 1; i < audioEvents.length; i++) {
      if (audioEvents[i].participantId !== audioEvents[i - 1].participantId) {
        const t = audioEvents[i].timestamp;
        const nearby = speakerChanges.filter((sc) => Math.abs(sc.timestamp - t) <= OVERLAP_WINDOW_MS);
        const nearbyParticipants = new Set(nearby.map((sc) => sc.participantId));

        handoffs.push({
          from: audioEvents[i - 1].participantId,
          to: audioEvents[i].participantId,
          timestamp: t,
          overlapLikely: nearbyParticipants.size > 1,
          speakerChangesNearby: nearby.length,
        });
      }
    }
    findings.push({ trackId, participants: [...distinctParticipants], handoffs });
  }
}

// ---------- report ----------

console.log('\n=== Track Reassignment Report ===\n');

if (findings.length === 0) {
  console.log('No audio trackId was shared by more than one participant. No reassignment detected in this run.\n');
} else {
  for (const f of findings) {
    console.log(`Track ${f.trackId} was used by: ${f.participants.join(', ')}`);
    for (const h of f.handoffs) {
      const when = new Date(h.timestamp).toISOString();
      console.log(
        `  -> handoff ${h.from} => ${h.to} at ${when} ` +
          `[${h.overlapLikely ? 'DURING apparent overlap' : 'no overlap detected nearby'}] ` +
          `(${h.speakerChangesNearby} speaker-class-change(s) within ${OVERLAP_WINDOW_MS}ms)`
      );
    }
    console.log('');
  }
}

console.log(`Total distinct trackIds seen: ${trackTimeline.size}`);
console.log(`Total speaker-class-change events parsed: ${speakerChanges.length}`);