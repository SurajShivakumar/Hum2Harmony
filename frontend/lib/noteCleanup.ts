import type { NoteEvent } from "@/lib/api";

/**
 * Removes obvious sustain artifacts from transcription playback/display.
 *
 * Pattern handled:
 *   B --- [short jump note] --- B
 *
 * Audio-to-MIDI models can emit a tiny octave/harmonic blip in the middle of a
 * sustained sung note. For UI playback/piano-roll display, fold that blip into
 * the surrounding note when the surrounding notes clearly continue the same pitch.
 */
export function combineSustainArtifacts(notes: NoteEvent[]): NoteEvent[] {
  if (notes.length < 3) return notes;

  const sorted = [...notes].sort((a, b) => a.start_time - b.start_time);
  const out: NoteEvent[] = [];

  let i = 0;
  while (i < sorted.length) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    const next = sorted[i + 1];

    if (prev && next) {
      const prevEnd = prev.start_time + prev.duration;
      const curEnd = cur.start_time + cur.duration;
      const nextEnd = next.start_time + next.duration;

      const surroundingSamePitch = Math.abs(prev.pitch - next.pitch) <= 1;
      const strayJump = Math.abs(cur.pitch - prev.pitch) >= 3 && Math.abs(cur.pitch - next.pitch) >= 3;
      const closeTiming =
        cur.start_time - prevEnd <= 0.12 &&
        next.start_time - curEnd <= 0.12;
      const shortStray = cur.duration <= 0.22 || cur.duration < Math.min(prev.duration, next.duration) * 0.55;

      if (surroundingSamePitch && strayJump && closeTiming && shortStray) {
        // Merge prev across the stray and following continuation note.
        prev.duration = Math.max(prev.duration, nextEnd - prev.start_time);
        prev.pitch = Math.round((prev.pitch + next.pitch) / 2);
        prev.note_name = next.note_name;
        i += 2; // skip cur and next
        continue;
      }
    }

    out.push({ ...cur });
    i += 1;
  }

  return removeIsolatedHighPitchOutliers(out);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Delete obvious transcription spikes that are far above the local melody.
 *
 * Neural transcribers sometimes produce a lone upper harmonic several octaves
 * above the sung line. Keep real melodic high notes if nearby notes support
 * that register; remove only isolated notes that are much higher than both the
 * local neighborhood and the song's typical range.
 */
function removeIsolatedHighPitchOutliers(notes: NoteEvent[]): NoteEvent[] {
  if (notes.length < 4) return notes;

  const pitches = notes.map((n) => Math.round(n.pitch));
  const globalMedian = median(pitches);
  const upperQuartile = median([...pitches].sort((a, b) => a - b).slice(Math.floor(pitches.length / 2)));

  return notes.filter((note, i) => {
    const pitch = Math.round(note.pitch);
    const lo = Math.max(0, i - 4);
    const hi = Math.min(notes.length, i + 5);
    const neighborPitches = notes
      .slice(lo, hi)
      .filter((_, localIndex) => lo + localIndex !== i)
      .map((n) => Math.round(n.pitch));

    if (neighborPitches.length < 2) return true;

    const localMedian = median(neighborPitches);
    const nearestNeighborDistance = Math.min(...neighborPitches.map((p) => Math.abs(p - pitch)));
    const farAboveLocalLine = pitch - localMedian >= 12;
    const farAboveTypicalRange = pitch - globalMedian >= 18 || pitch - upperQuartile >= 12;
    const unsupportedByNeighbors = nearestNeighborDistance >= 9;
    const briefSpike = note.duration <= 0.55;

    return !(farAboveLocalLine && unsupportedByNeighbors && (farAboveTypicalRange || briefSpike));
  });
}
