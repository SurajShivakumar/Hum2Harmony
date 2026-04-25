import MidiWriter from "midi-writer-js";
import type { Note } from "./basicPitch";

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToName(midi: number): string {
  const clamped = Math.max(0, Math.min(127, Math.round(midi)));
  const octave = Math.floor(clamped / 12) - 1;
  return `${NAMES[clamped % 12]}${octave}`;
}

export function notesToMidiUri(notes: Note[]): string {
  const track = new MidiWriter.Track();
  track.setTempo(120);

  for (const note of notes) {
    track.addEvent(
      new MidiWriter.NoteEvent({
        pitch: [midiToName(note.pitchMidi)],
        duration: `T${Math.max(1, Math.round(note.durationSeconds * 128))}`,
        startTick: Math.max(0, Math.round(note.startTimeSeconds * 128)),
        velocity: Math.max(1, Math.min(100, Math.round(note.amplitude * 100))),
      })
    );
  }
  return new MidiWriter.Writer(track).dataUri();
}

export function downloadMidi(notes: Note[], filename = "output.mid") {
  const uri = notesToMidiUri(notes);
  const a = document.createElement("a");
  a.href = uri;
  a.download = filename;
  a.click();
}

