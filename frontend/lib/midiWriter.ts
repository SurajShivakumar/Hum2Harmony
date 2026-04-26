import MidiWriter from "midi-writer-js";
import type { Note } from "./basicPitch";
import { cleanBpm, snapDuration, snapPitchToScale, parseKey, STANDARD_BEATS } from "./midiSimplify";

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToName(midi: number): string {
  const clamped = Math.max(0, Math.min(127, Math.round(midi)));
  const octave = Math.floor(clamped / 12) - 1;
  return `${NAMES[clamped % 12]}${octave}`;
}

/**
 * Same pipeline as simplifyForMidi (NoteEvent path) but for the basicPitch
 * Note type (different field names).
 */
function simplify(notes: Note[], bpm = 120, musicalKey?: string): Note[] {
  if (!notes.length) return [];

  const bpmClean  = cleanBpm(bpm);
  const beatSec   = 60 / bpmClean;
  const sixteenth = beatSec / 4;
  const eighth    = beatSec / 2;

  // 0. Monophonize — collapse any chords/overlaps to the loudest/highest note
  const mono = (() => {
    const sorted = [...notes].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
    const out: Note[] = [];
    for (const n of sorted) {
      const prev = out[out.length - 1];
      if (!prev || n.startTimeSeconds >= prev.startTimeSeconds + prev.durationSeconds - 0.001) {
        out.push({ ...n }); continue;
      }
      const newIsLead =
        n.amplitude > prev.amplitude + 0.05 ||
        (Math.abs(n.amplitude - prev.amplitude) <= 0.05 && n.pitchMidi > prev.pitchMidi);
      if (newIsLead) {
        const trimmed = n.startTimeSeconds - prev.startTimeSeconds;
        if (trimmed < 0.05) out.pop(); else prev.durationSeconds = trimmed;
        out.push({ ...n });
      }
    }
    return out;
  })();

  // 1. Remove pitch outliers (sliding median)
  const filtered = (() => {
    if (mono.length < 3) return mono;
    const pitches = mono.map(n => n.pitchMidi);
    const medianFiltered = mono.filter((_, i) => {
      const lo = Math.max(0, i - 4), hi = Math.min(mono.length, i + 5);
      const s = pitches.slice(lo, hi).slice().sort((a, b) => a - b);
      return Math.abs(pitches[i] - s[Math.floor(s.length / 2)]) <= 9;
    });
    if (medianFiltered.length < 3) return medianFiltered;
    return medianFiltered.filter((n, i, arr) => {
      if (i === 0 || i === arr.length - 1) return true;
      const prev = arr[i - 1], next = arr[i + 1];
      const isolatedSpike =
        Math.abs(n.pitchMidi - prev.pitchMidi) >= 12 &&
        Math.abs(n.pitchMidi - next.pitchMidi) >= 12 &&
        Math.abs(prev.pitchMidi - next.pitchMidi) <= 4;
      if (!isolatedSpike) return true;
      return n.durationSeconds >= 0.25;
    });
  })();

  // 2. Snap pitches + merge within 1 semitone
  const snapped = filtered.map(n => ({ ...n, pitchMidi: Math.round(n.pitchMidi) }));
  const merged: Note[] = [];
  for (const n of snapped) {
    const prev = merged[merged.length - 1];
    const gap  = prev ? n.startTimeSeconds - (prev.startTimeSeconds + prev.durationSeconds) : Infinity;
    if (prev && Math.abs(n.pitchMidi - prev.pitchMidi) <= 1 && gap < sixteenth) {
      const newEnd = Math.max(prev.startTimeSeconds + prev.durationSeconds, n.startTimeSeconds + n.durationSeconds);
      if (n.amplitude > prev.amplitude) prev.pitchMidi = n.pitchMidi;
      prev.durationSeconds = newEnd - prev.startTimeSeconds;
    } else {
      merged.push({ ...n });
    }
  }

  // 3. Quantize starts to 16th grid, durations to standard values only
  const quantized = merged.map(n => {
    const qStart = Math.round(n.startTimeSeconds / sixteenth) * sixteenth;
    const dur    = Math.max(sixteenth, snapDuration(n.durationSeconds, beatSec));
    return { ...n, startTimeSeconds: qStart, durationSeconds: dur };
  });

  // 4. Snap to scale (major key preference)
  const scalePCs = parseKey(musicalKey ?? "");
  const scaled = scalePCs
    ? quantized.map(n => ({ ...n, pitchMidi: snapPitchToScale(n.pitchMidi, scalePCs) }))
    : quantized;

  // 5. Merge same-pitch notes after scale snap
  const merged2: Note[] = [];
  for (const n of scaled) {
    const prev = merged2[merged2.length - 1];
    if (prev && prev.pitchMidi === n.pitchMidi) {
      const gap = n.startTimeSeconds - (prev.startTimeSeconds + prev.durationSeconds);
      if (gap < sixteenth * 0.5) {
        const combined = n.startTimeSeconds + n.durationSeconds - prev.startTimeSeconds;
        const snappedC = snapDuration(combined, beatSec);
        if (Math.abs(snappedC - combined) <= sixteenth * 0.55) { prev.durationSeconds = snappedC; continue; }
      }
    }
    merged2.push({ ...n });
  }

  // 7. Overlap fix + sub-16th filter
  const result: Note[] = [];
  for (const n of merged2) {
    if (n.durationSeconds < sixteenth * 0.5) continue;
    const prev = result[result.length - 1];
    if (prev) {
      const prevEnd = prev.startTimeSeconds + prev.durationSeconds;
      if (n.startTimeSeconds < prevEnd - 0.001) {
        const trimmed = snapDuration(n.startTimeSeconds - prev.startTimeSeconds, beatSec);
        if (trimmed < sixteenth * 0.5) result.pop(); else prev.durationSeconds = trimmed;
      }
    }
    result.push({ ...n });
  }

  // 8. Normalize dynamics
  const amps = result.map(n => n.amplitude);
  const mean = amps.reduce((s, a) => s + a, 0) / (amps.length || 1);
  return result.map(n => ({
    ...n,
    amplitude: Math.max(0.60, Math.min(0.88, n.amplitude * 0.3 + mean * 0.7)),
  }));
}

function toMidiUriFromNotes(notes: Note[], bpmClean: number, ticksPerSec: number): string {
  const track = new MidiWriter.Track();
  track.setTempo(bpmClean);

  for (const note of notes) {
    track.addEvent(
      new MidiWriter.NoteEvent({
        pitch: [midiToName(note.pitchMidi)],
        duration: `T${Math.max(1, Math.round(note.durationSeconds * ticksPerSec))}`,
        startTick: Math.max(0, Math.round(note.startTimeSeconds * ticksPerSec)),
        velocity: Math.max(1, Math.min(100, Math.round(note.amplitude * 100))),
      })
    );
  }
  return new MidiWriter.Writer(track).dataUri();
}

export function notesToMidiUri(notes: Note[], bpm = 120, musicalKey?: string): string {
  const bpmClean    = cleanBpm(bpm);
  const simplified  = simplify(notes, bpmClean, musicalKey);
  const ticksPerSec = (bpmClean / 60) * 128;
  return toMidiUriFromNotes(simplified, bpmClean, ticksPerSec);
}

/**
 * Raw MIDI export: preserves original note density/timing as much as possible.
 * Uses a higher tick resolution for denser timing detail.
 */
export function notesToRawMidiUri(notes: Note[], bpm = 120): string {
  const bpmClean = cleanBpm(bpm);
  const raw = [...notes]
    .map((n) => ({
      ...n,
      pitchMidi: Math.round(n.pitchMidi),
      durationSeconds: Math.max(0.02, n.durationSeconds),
      amplitude: Math.max(0.01, Math.min(1, n.amplitude)),
    }))
    .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

  // Higher temporal resolution than filtered export.
  const ticksPerSec = (bpmClean / 60) * 256;
  return toMidiUriFromNotes(raw, bpmClean, ticksPerSec);
}

export function downloadMidi(notes: Note[], filename = "output.mid") {
  const uri = notesToMidiUri(notes);
  const a = document.createElement("a");
  a.href = uri;
  a.download = filename;
  a.click();
}

