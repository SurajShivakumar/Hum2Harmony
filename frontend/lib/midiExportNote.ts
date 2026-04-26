/**
 * Note shape for browser-side raw MIDI export (midiWriter).
 * Field names match the legacy basic-pitch export pipeline.
 */
export interface MidiExportNote {
  pitchMidi: number;
  startTimeSeconds: number;
  durationSeconds: number;
  amplitude: number;
}
