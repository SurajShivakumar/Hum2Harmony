import {
  BasicPitch,
  noteFramesToTime,
  addPitchBendsToNoteEvents,
  outputToNotesPoly,
} from "@spotify/basic-pitch";

export interface Note {
  pitchMidi: number;
  startTimeSeconds: number;
  durationSeconds: number;
  amplitude: number;
}

export async function transcribeAudio(
  audioBuffer: AudioBuffer,
  onProgress: (p: number) => void
): Promise<Note[]> {
  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];

  const basicPitch = new BasicPitch("/model/model.json");

  await basicPitch.evaluateModel(
    audioBuffer,
    (f, o, c) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    onProgress
  );

  const noteEvents = noteFramesToTime(
    addPitchBendsToNoteEvents(
      contours,
      outputToNotesPoly(frames, onsets, 0.25, 0.25, 5)
    )
  ) as unknown as Array<[number, number, number, number] | Record<string, unknown>>;

  return noteEvents
    .map((n) => {
      if (Array.isArray(n)) {
        const start = Number(n[0] ?? 0);
        const end = Number(n[1] ?? start);
        const pitch = Number(n[2] ?? 60);
        const amp = Number(n[3] ?? 0.8);
        return {
          pitchMidi: Math.round(pitch),
          startTimeSeconds: start,
          durationSeconds: Math.max(0.02, end - start),
          amplitude: Math.max(0.05, Math.min(1, amp)),
        };
      }

      const obj = n as Record<string, unknown>;
      const start = Number(obj.start_time_s ?? obj.startTimeSeconds ?? 0);
      const endRaw = Number(obj.end_time_s ?? 0);
      const durationRaw = Number(obj.duration_sec ?? obj.durationSeconds ?? 0);
      const duration = durationRaw > 0 ? durationRaw : Math.max(0.02, endRaw - start);
      const pitch = Number(obj.pitch_midi ?? obj.pitchMidi ?? 60);
      const amp = Number(obj.amplitude ?? 0.8);
      return {
        pitchMidi: Math.round(pitch),
        startTimeSeconds: start,
        durationSeconds: duration,
        amplitude: Math.max(0.05, Math.min(1, amp)),
      };
    })
    .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
}

export async function fileToAudioBuffer(file: File): Promise<AudioBuffer> {
  const audioContext = new AudioContext({ sampleRate: 22050 });
  const arrayBuffer = await file.arrayBuffer();
  const decoded = await audioContext.decodeAudioData(arrayBuffer);

  // Basic Pitch expects a mono buffer. Downmix stereo/multichannel input.
  if (decoded.numberOfChannels === 1) return decoded;

  const mono = audioContext.createBuffer(1, decoded.length, decoded.sampleRate);
  const monoData = mono.getChannelData(0);

  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < decoded.length; i++) {
      monoData[i] += data[i] / decoded.numberOfChannels;
    }
  }

  return mono;
}

