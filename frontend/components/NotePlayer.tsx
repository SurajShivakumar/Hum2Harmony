"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteEvent } from "@/lib/api";

interface NotePlayerProps {
  notes: NoteEvent[];
  tempo: number;
  onTimeUpdate?: (t: number) => void;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToTone(midi: number): string {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

// Salamander Grand Piano samples hosted by Tone.js.
// Each file is one recorded piano note; Tone.Sampler pitch-shifts and
// interpolates between them for every other MIDI note automatically.
// '#' → 's' in filenames (e.g. D#1 → Ds1).
const SALAMANDER_BASE = "https://tonejs.github.io/audio/salamander/";
const SALAMANDER_URLS: Record<string, string> = {
  A0: "A0.mp3",  C1: "C1.mp3",  "D#1": "Ds1.mp3", "F#1": "Fs1.mp3",
  A1: "A1.mp3",  C2: "C2.mp3",  "D#2": "Ds2.mp3", "F#2": "Fs2.mp3",
  A2: "A2.mp3",  C3: "C3.mp3",  "D#3": "Ds3.mp3", "F#3": "Fs3.mp3",
  A3: "A3.mp3",  C4: "C4.mp3",  "D#4": "Ds4.mp3", "F#4": "Fs4.mp3",
  A4: "A4.mp3",  C5: "C5.mp3",  "D#5": "Ds5.mp3", "F#5": "Fs5.mp3",
  A5: "A5.mp3",  C6: "C6.mp3",  "D#6": "Ds6.mp3", "F#6": "Fs6.mp3",
  A6: "A6.mp3",  C7: "C7.mp3",  "D#7": "Ds7.mp3", "F#7": "Fs7.mp3",
  A7: "A7.mp3",  C8: "C8.mp3",
};

export default function NotePlayer({ notes, tempo, onTimeUpdate }: NotePlayerProps) {
  const [samplerReady, setSamplerReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);

  const samplerRef = useRef<import("tone").Sampler | null>(null);
  const partRef    = useRef<import("tone").Part | null>(null);
  const toneRef    = useRef<typeof import("tone") | null>(null);
  const rafRef     = useRef<number | null>(null);

  const totalDuration = notes.length
    ? Math.max(...notes.map((n) => n.start_time + n.duration))
    : 0;

  // Load Tone.js + piano samples once on first interaction
  const ensureSampler = useCallback(async () => {
    if (samplerRef.current && samplerReady) return toneRef.current!;

    const Tone = await import("tone");
    toneRef.current = Tone;

    if (samplerRef.current) {
      samplerRef.current.dispose();
    }

    await new Promise<void>((resolve) => {
      const reverb = new Tone.Reverb({ decay: 2.5, wet: 0.2 });
      reverb.toDestination();

      const sampler = new Tone.Sampler({
        urls: SALAMANDER_URLS,
        baseUrl: SALAMANDER_BASE,
        release: 1.2,
        onload: () => {
          setSamplerReady(true);
          resolve();
        },
      }).connect(reverb);

      samplerRef.current = sampler;
    });

    return Tone;
  }, [samplerReady]);

  const stop = useCallback(async () => {
    const Tone = toneRef.current;
    if (!Tone) return;

    partRef.current?.stop();
    partRef.current?.dispose();
    partRef.current = null;
    await Tone.Transport.stop();
    Tone.Transport.cancel();
    samplerRef.current?.releaseAll();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setPlaying(false);
    onTimeUpdate?.(-1);
  }, [onTimeUpdate]);

  const play = useCallback(async () => {
    if (!notes.length) return;
    setLoading(true);

    const Tone = await ensureSampler();
    await Tone.start();
    await stop();

    Tone.Transport.bpm.value = tempo;

    // Schedule every note — Sampler handles unlimited simultaneous voices
    const events = notes.map((n) => ({
      time: n.start_time,
      note: midiToTone(n.pitch),
      duration: Math.max(0.1, n.duration),
    }));

    const part = new Tone.Part((time, ev) => {
      samplerRef.current?.triggerAttackRelease(ev.note, ev.duration, time);
    }, events);

    part.start(0);
    partRef.current = part;

    Tone.Transport.scheduleOnce(() => stop(), totalDuration + 1.5);
    Tone.Transport.start();
    setPlaying(true);
    setLoading(false);

    const tick = () => {
      if (!toneRef.current) return;
      onTimeUpdate?.(toneRef.current.Transport.seconds);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [notes, tempo, totalDuration, ensureSampler, stop, onTimeUpdate]);

  useEffect(() => {
    return () => {
      stop();
      samplerRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusLabel = loading
    ? "Loading piano samples…"
    : playing
    ? "⏹ Stop"
    : samplerReady
    ? "▶ Play as piano"
    : "▶ Play as piano";

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={playing ? stop : play}
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

      {!samplerReady && !loading && notes.length > 0 && (
        <span className="text-xs text-gray-400">
          Real piano · samples load on first play
        </span>
      )}
      {samplerReady && !playing && (
        <span className="text-xs text-gray-400">Salamander Grand Piano</span>
      )}
    </div>
  );
}
