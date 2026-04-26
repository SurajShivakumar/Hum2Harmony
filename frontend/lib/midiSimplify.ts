import type { NoteEvent } from "@/lib/api";

// ── Constants ────────────────────────────────────────────────────────────────

const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"] as const;

/**
 * Allowed note durations, expressed as multiples of one beat (quarter note).
 * Dotted notes, triplets, etc. are intentionally excluded — the goal is the
 * simplest possible readable melody sheet.
 */
const STANDARD_BEATS = [4, 2, 1, 0.5, 0.25] as const; // whole → 16th

// ── Small helpers ────────────────────────────────────────────────────────────

function midiToName(midi: number): string {
  const m = Math.max(0, Math.min(127, Math.round(midi)));
  return `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
}

/**
 * Round BPM to the nearest multiple of 5 (e.g. 117 → 115, 118 → 120).
 * Keeps tempo "human-readable" on a sheet.
 */
function cleanBpm(bpm: number): number {
  return Math.max(60, Math.min(200, Math.round(bpm / 5) * 5));
}

/**
 * Snap a duration in seconds to the closest standard note value at the
 * current BPM. Returns seconds.
 */
function snapDuration(durSec: number, beatSec: number): number {
  const durBeats = durSec / beatSec;
  let best = STANDARD_BEATS[0] as number;
  let bestDist = Infinity;
  for (const d of STANDARD_BEATS) {
    const dist = Math.abs(durBeats - d);
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  return best * beatSec;
}

// ── Scale / key helpers ───────────────────────────────────────────────────────

const MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_INTERVALS = [0, 2, 3, 5, 7, 8, 10];

const ROOT_MAP: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3,
  E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8,
  Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};

/**
 * Parse a key string like "C major" or "F# minor" into scale pitch-class set.
 * Returns null if the string is unrecognisable.
 */
function parseKey(keyStr: string): number[] | null {
  if (!keyStr) return null;
  const parts = keyStr.trim().split(/\s+/);
  if (parts.length < 1) return null;
  const root = ROOT_MAP[parts[0]];
  if (root === undefined) return null;
  const mode = (parts[1] ?? "major").toLowerCase();
  const intervals = mode.startsWith("min") ? MINOR_INTERVALS : MAJOR_INTERVALS;
  return intervals.map(i => (root + i) % 12);
}

/**
 * Snap a MIDI pitch to the nearest degree of the given scale pitch-class set.
 * Preserves octave as closely as possible.
 */
function snapPitchToScale(pitch: number, scalePCs: number[]): number {
  const pc = pitch % 12;
  let bestPC = scalePCs[0];
  let bestDist = Infinity;
  for (const s of scalePCs) {
    const dist = Math.min(Math.abs(s - pc), 12 - Math.abs(s - pc));
    if (dist < bestDist) { bestDist = dist; bestPC = s; }
  }
  let diff = bestPC - pc;
  if (diff > 6)  diff -= 12;
  if (diff < -6) diff += 12;
  return pitch + diff;
}

// ── Pipeline stages ──────────────────────────────────────────────────────────

/**
 * Stage 0 — Monophonize (chord → lead extraction).
 *
 * At any point in time only one note should sound (humming = single voice).
 * If multiple notes overlap, the one with the highest amplitude is kept as
 * the lead; pitch is a secondary tiebreaker (higher pitch preferred since
 * melody typically sits on top). The losing note is discarded entirely — it
 * is most likely a drum transient, bass harmonic, or background artefact.
 *
 * Notes are processed in onset order. When a new note starts before the
 * current lead ends, we compare them:
 *  - if the new note is louder (or same amplitude but higher pitch), it
 *    replaces the current lead from its own start time.
 *  - otherwise the new note is dropped.
 */
function monophonize(notes: NoteEvent[]): NoteEvent[] {
  if (!notes.length) return [];
  type WithAmp = NoteEvent & { amplitude?: number };

  const sorted = [...notes].sort((a, b) => a.start_time - b.start_time);
  const out: NoteEvent[] = [];

  for (const note of sorted) {
    const prev = out[out.length - 1] as WithAmp | undefined;
    const noteAmp = (note as WithAmp).amplitude ?? 0.75;

    if (!prev) {
      out.push({ ...note });
      continue;
    }

    const prevEnd = prev.start_time + prev.duration;
    if (note.start_time >= prevEnd - 0.001) {
      // No overlap — just append.
      out.push({ ...note });
      continue;
    }

    // Overlap: keep the louder note; use higher pitch as tiebreaker.
    const prevAmp = prev.amplitude ?? 0.75;
    const newIsLead =
      noteAmp > prevAmp + 0.05 ||
      (Math.abs(noteAmp - prevAmp) <= 0.05 && note.pitch > prev.pitch);

    if (newIsLead) {
      // Trim the previous note to end where the new lead begins,
      // or remove it entirely if it would become too short.
      const trimmed = note.start_time - prev.start_time;
      if (trimmed < 0.05) {
        out.pop();
      } else {
        prev.duration = trimmed;
      }
      out.push({ ...note });
    }
    // else: discard the new note — the current lead stays.
  }

  return out;
}

/**
 * Stage 1 — Pitch outlier removal.
 * Uses a sliding-window median: any note whose pitch deviates more than
 * `maxDev` semitones from its local median is dropped.
 */
function removePitchOutliers(
  notes: NoteEvent[],
  windowHalf = 4,
  maxDev = 9,
): NoteEvent[] {
  if (notes.length < 3) return notes;
  const pitches = notes.map(n => n.pitch);
  const medianFiltered = notes.filter((_, i) => {
    const lo = Math.max(0, i - windowHalf);
    const hi = Math.min(notes.length, i + windowHalf + 1);
    const slice = pitches.slice(lo, hi).slice().sort((a, b) => a - b);
    const median = slice[Math.floor(slice.length / 2)];
    return Math.abs(pitches[i] - median) <= maxDev;
  });

  // Second pass: remove isolated octave spikes between stable neighbours.
  if (medianFiltered.length < 3) return medianFiltered;
  return medianFiltered.filter((n, i, arr) => {
    if (i === 0 || i === arr.length - 1) return true;
    const prev = arr[i - 1];
    const next = arr[i + 1];
    const jumpPrev = Math.abs(n.pitch - prev.pitch);
    const jumpNext = Math.abs(n.pitch - next.pitch);
    const neighGap = Math.abs(prev.pitch - next.pitch);
    const isolatedSpike = jumpPrev >= 12 && jumpNext >= 12 && neighGap <= 4;
    if (!isolatedSpike) return true;
    return n.duration >= 0.25; // keep only if it's a clearly sustained leap
  });
}

/**
 * Stage 2 — Pitch snap + semitone merge.
 * Round every pitch to the nearest integer semitone, then merge consecutive
 * notes that are ≤ 1 semitone apart and close in time (< one 8th note gap).
 * The louder note's pitch wins; duration spans both notes.
 */
function snapAndMergePitch(notes: NoteEvent[], eighthSec: number, sixteenthSec: number): NoteEvent[] {
  const snapped = notes.map(n => ({
    ...n,
    pitch: Math.round(n.pitch),
    note_name: midiToName(Math.round(n.pitch)),
  }));

  const out: NoteEvent[] = [];
  for (const n of snapped) {
    const prev = out[out.length - 1];
    const gap = prev ? n.start_time - (prev.start_time + prev.duration) : Infinity;
    if (prev && Math.abs(n.pitch - prev.pitch) <= 1 && gap < sixteenthSec) {
      const newEnd = Math.max(prev.start_time + prev.duration, n.start_time + n.duration);
      const pa = (prev as NoteEvent & { amplitude?: number }).amplitude ?? 0;
      const na = (n    as NoteEvent & { amplitude?: number }).amplitude ?? 0;
      if (na > pa) { prev.pitch = n.pitch; prev.note_name = n.note_name; }
      prev.duration = newEnd - prev.start_time;
    } else {
      out.push({ ...n });
    }
  }
  return out;
}

/**
 * Stage 3 — Quantize start times to 16th-note grid.
 */
function quantizeStarts(notes: NoteEvent[], sixteenthSec: number): NoteEvent[] {
  return notes.map(n => ({
    ...n,
    start_time: Math.round(n.start_time / sixteenthSec) * sixteenthSec,
  }));
}

/**
 * Stage 4 — Snap durations to standard note values only.
 * Each note's duration is rounded to the nearest value in
 * { whole, half, quarter, 8th, 16th } at the current BPM.
 * Minimum is one 16th note.
 */
function quantizeDurations(notes: NoteEvent[], beatSec: number, sixteenthSec: number): NoteEvent[] {
  return notes.map(n => ({
    ...n,
    duration: Math.max(sixteenthSec, snapDuration(n.duration, beatSec)),
  }));
}

/**
 * Stage 5 — Merge consecutive same-pitch notes.
 * If two adjacent notes have the same pitch and their combined span (including
 * the gap) would snap cleanly to a single standard note value, fuse them.
 */
function mergeSamePitch(notes: NoteEvent[], beatSec: number, sixteenthSec: number): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const n of notes) {
    const prev = out[out.length - 1];
    if (prev && prev.pitch === n.pitch) {
      const gap = n.start_time - (prev.start_time + prev.duration);
      if (gap < sixteenthSec * 0.5) {
        const combined = n.start_time + n.duration - prev.start_time;
        const snapped  = snapDuration(combined, beatSec);
        if (Math.abs(snapped - combined) <= sixteenthSec * 0.55) {
          prev.duration = snapped;
          continue;
        }
      }
    }
    out.push({ ...n });
  }
  return out;
}

/**
 * Stage 6 — Overlap resolution + sub-16th removal.
 * Any note shorter than 75 % of a 16th is dropped.
 * If two notes overlap after quantization, the earlier note is trimmed to the
 * nearest standard value that ends before the next note starts.
 */
function resolveOverlaps(notes: NoteEvent[], beatSec: number, sixteenthSec: number): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const n of notes) {
    if (n.duration < sixteenthSec * 0.5) continue;
    const prev = out[out.length - 1];
    if (prev) {
      const prevEnd = prev.start_time + prev.duration;
      if (n.start_time < prevEnd - 0.001) {
        const trimmed = snapDuration(n.start_time - prev.start_time, beatSec);
        if (trimmed < sixteenthSec * 0.5) { out.pop(); }
        else { prev.duration = trimmed; }
      }
    }
    out.push({ ...n });
  }
  return out;
}

/**
 * Stage 7 — Scale quantization (major key preference).
 * Snaps every pitch to the nearest degree of the detected key's major scale.
 * Non-diatonic notes (accidentals) are pulled to the closest in-key note.
 * Falls back to no-op when key is unknown.
 */
function snapToScale(notes: NoteEvent[], scalePCs: number[] | null): NoteEvent[] {
  if (!scalePCs) return notes;
  return notes.map(n => {
    const snapped = snapPitchToScale(n.pitch, scalePCs);
    return snapped === n.pitch
      ? n
      : { ...n, pitch: snapped, note_name: midiToName(snapped) };
  });
}

/**
 * Stage 8 — Dynamics normalisation.
 * Compresses the amplitude range so all notes play at roughly the same
 * loudness. The mean amplitude is computed, then each note is blended 70 %
 * toward that mean, and the result is clamped to [0.60, 0.88].
 * This removes wild velocity swings while keeping a little natural expression.
 */
function normalizeDynamics(notes: NoteEvent[]): NoteEvent[] {
  if (!notes.length) return notes;
  type WithAmp = NoteEvent & { amplitude?: number };
  const amps = (notes as WithAmp[]).map(n => n.amplitude ?? 0.75);
  const mean = amps.reduce((s, a) => s + a, 0) / amps.length;
  return (notes as WithAmp[]).map((n, i) => {
    const blended = amps[i] * 0.3 + mean * 0.7;      // 70 % pull to mean
    const clamped = Math.max(0.60, Math.min(0.88, blended));
    return { ...n, amplitude: clamped };
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Full MIDI simplification pipeline.
 *
 * Produces a lead melody where every note is one of:
 *   whole · half · quarter · 8th · 16th
 * at a clean rounded BPM, with pitch outliers removed and sub-16th
 * artefacts discarded.
 *
 * @param notes  Raw notes from the backend.
 * @param bpm    Detected tempo (will be rounded to nearest multiple of 5).
 * @returns      Simplified notes ready for MIDI export or Tone.js playback.
 */
/**
 * Full MIDI simplification pipeline.
 *
 * Produces a lead melody where:
 *  - Every note is one of: whole · half · quarter · 8th · 16th
 *  - Pitches are snapped to the detected major key (no stray accidentals)
 *  - Dynamics are compressed to a consistent loudness band
 *  - Pitch outliers and sub-16th artefacts are removed
 *
 * @param notes       Raw notes from the backend.
 * @param bpm         Detected tempo (rounded to nearest multiple of 5).
 * @param musicalKey  Key string, e.g. "C major" or "F# minor" (optional).
 */
export function simplifyForMidi(
  notes: NoteEvent[],
  bpm = 120,
  musicalKey?: string,
): NoteEvent[] {
  if (!notes.length) return [];

  const bpmClean     = cleanBpm(bpm);
  const beatSec      = 60 / bpmClean;
  const sixteenthSec = beatSec / 4;
  const eighthSec    = beatSec / 2;
  const scalePCs     = parseKey(musicalKey ?? "");

  let out = monophonize(notes);          // collapse chords → single lead note
  out = removePitchOutliers(out);
  out = snapAndMergePitch(out, eighthSec, sixteenthSec);
  out = snapToScale(out, scalePCs);          // snap accidentals to key
  out = quantizeStarts(out, sixteenthSec);
  out = quantizeDurations(out, beatSec, sixteenthSec);
  out = mergeSamePitch(out, beatSec, sixteenthSec);
  out = resolveOverlaps(out, beatSec, sixteenthSec);
  out = normalizeDynamics(out);              // even out velocities

  return out;
}

/** Exported for use in the MIDI writer (MidiExportNote uses different field names than NoteEvent). */
export { cleanBpm, snapDuration, snapPitchToScale, parseKey, STANDARD_BEATS };
