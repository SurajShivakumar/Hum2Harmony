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

  return out;
}
