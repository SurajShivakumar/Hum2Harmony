import Soundfont from "soundfont-player";
import type { Note } from "./basicPitch";

let player: any = null;
let currentAudioContext: AudioContext | null = null;
const activeNodes: any[] = [];

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToName(midi: number): string {
  const clamped = Math.max(0, Math.min(127, Math.round(midi)));
  const octave = Math.floor(clamped / 12) - 1;
  return `${NAMES[clamped % 12]}${octave}`;
}

export async function loadInstrument() {
  const audioContext = new AudioContext();
  currentAudioContext = audioContext;
  player = await Soundfont.instrument(audioContext, "acoustic_grand_piano", {
    gain: 2.0,
    soundfont: "MusyngKite",
  });
  return audioContext;
}

export function playNotes(notes: Note[], audioContext: AudioContext) {
  if (!player) return;
  const now = audioContext.currentTime + 0.05;

  for (const note of notes) {
    const node = player.play(midiToName(note.pitchMidi), now + note.startTimeSeconds, {
      duration: Math.max(0.03, note.durationSeconds),
      gain: Math.max(0.05, Math.min(1.2, note.amplitude)),
    });
    activeNodes.push(node);
  }
}

export function stopPlayback() {
  for (const n of activeNodes.splice(0, activeNodes.length)) {
    try {
      n.stop();
    } catch {}
  }
  if (player) player.stop();
}

export function getPlaybackContext() {
  return currentAudioContext;
}

