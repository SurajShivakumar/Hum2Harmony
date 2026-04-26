"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteEvent } from "@/lib/api";

interface NotePlayerProps {
  notes: NoteEvent[];
  tempo: number;
  musicalKey?: string;
  onTimeUpdate?: (t: number) => void;
  seekTime?: number;
  playRequest?: number;
  toggleRequest?: number;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToName(midi: number): string {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

export default function NotePlayer({
  notes,
  tempo: _tempo,
  musicalKey: _musicalKey,
  onTimeUpdate,
  seekTime = 0,
  playRequest = 0,
  toggleRequest = 0,
}: NotePlayerProps) {
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);

  const toneRef = useRef<typeof import("tone") | null>(null);
  const synthRef = useRef<import("tone").PolySynth | null>(null);
  const scheduledIdsRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const playingRef = useRef(false);
  const lastPlayRequestRef = useRef(0);
  const lastToggleRequestRef = useRef(0);
  const notesRef = useRef<NoteEvent[]>(notes);
  const onTimeUpdateRef = useRef<((t: number) => void) | undefined>(onTimeUpdate);
  notesRef.current = notes;
  onTimeUpdateRef.current = onTimeUpdate;

  const ensureEngine = useCallback(async () => {
    if (synthRef.current && toneRef.current) return;

    const Tone = await import("tone");
    toneRef.current = Tone;

    const volume = new Tone.Volume(-8);
    const reverb = new Tone.Reverb({ decay: 1.4, wet: 0.12 });
    const synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: {
        attack: 0.008,
        decay: 0.08,
        sustain: 0.55,
        release: 0.35,
      },
    });

    synth.chain(volume, reverb, Tone.Destination);
    synthRef.current = synth;
  }, []);

  const stop = useCallback(async () => {
    const Tone = toneRef.current;
    if (Tone) {
      for (const id of scheduledIdsRef.current) {
        Tone.Transport.clear(id);
      }
      scheduledIdsRef.current = [];
      Tone.Transport.stop();
      Tone.Transport.cancel();
      synthRef.current?.releaseAll();
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    playingRef.current = false;
    setPlaying(false);
    onTimeUpdateRef.current?.(-1);
  }, []);

  const play = useCallback(async (startAt = 0) => {
    const n = notesRef.current;
    if (!n.length) return;
    const totalDuration = n.length
      ? Math.max(...n.map((x) => x.start_time + x.duration))
      : 0;
    setLoading(true);
    await ensureEngine();
    const Tone = toneRef.current;
    const synth = synthRef.current;
    if (!Tone || !synth) return;
    await Tone.start();
    await stop();

    const offset = Math.max(0, Math.min(startAt, totalDuration));
    // Play raw transcription from the requested offset.
    const sorted = [...n].sort((a, b) => a.start_time - b.start_time);
    for (const n of sorted) {
      const noteStart = Math.max(0, n.start_time);
      const noteEnd = noteStart + Math.max(0.03, n.duration);
      if (noteEnd <= offset) continue;
      const scheduledAt = Math.max(0, noteStart - offset);
      const duration = Math.max(0.03, noteEnd - Math.max(noteStart, offset));
      const id = Tone.Transport.schedule((time) => {
        synth.triggerAttackRelease(
          midiToName(Math.round(n.pitch)),
          duration,
          time,
          0.7
        );
      }, scheduledAt);
      scheduledIdsRef.current.push(id);
    }

    Tone.Transport.start("+0.03");
    startedAtRef.current = performance.now() - offset * 1000;
    playingRef.current = true;
    setPlaying(true);
    setLoading(false);

    const tick = () => {
      if (!playingRef.current) return;
      const elapsed = (performance.now() - startedAtRef.current) / 1000;
      onTimeUpdateRef.current?.(elapsed);
      if (elapsed >= totalDuration + 0.5) {
        void stop();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [ensureEngine, stop]);

  const playRef = useRef(play);
  playRef.current = play;
  const stopRef = useRef(stop);
  stopRef.current = stop;

  useEffect(() => {
    if (playRequest === 0 || playRequest === lastPlayRequestRef.current) return;
    lastPlayRequestRef.current = playRequest;
    void playRef.current(seekTime);
  }, [playRequest, seekTime]);

  useEffect(() => {
    if (toggleRequest === 0 || toggleRequest === lastToggleRequestRef.current) return;
    lastToggleRequestRef.current = toggleRequest;
    if (playingRef.current) {
      void stopRef.current();
    } else {
      void playRef.current(seekTime);
    }
  }, [seekTime, toggleRequest]);

  useEffect(() => {
    return () => {
      void stop();
      synthRef.current?.dispose();
    };
  }, [stop]);

  const statusLabel = loading
    ? "Loading instrument…"
    : playing
    ? "⏹ Stop"
    : "▶ Play transcription";

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <button
        onClick={playing ? stop : () => play(seekTime)}
        disabled={loading || !notes.length}
        className={[
          "flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm shadow transition-all focus:outline-none focus:ring-2 focus:ring-offset-2",
          playing
            ? "bg-red-500 hover:bg-red-400 text-white focus:ring-red-400"
            : "bg-violet-600 hover:bg-violet-500 text-white focus:ring-violet-400",
          (loading || !notes.length) ? "opacity-50 cursor-not-allowed" : "",
        ].join(" ")}
      >
        {loading && <span className="animate-spin">⟳</span>}
        {statusLabel}
      </button>
    </div>
  );
}
