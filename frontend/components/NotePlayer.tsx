"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteEvent } from "@/lib/api";

interface NotePlayerProps {
  notes: NoteEvent[];
  tempo: number;
  musicalKey?: string;
  onTimeUpdate?: (t: number) => void;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToName(midi: number): string {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

export default function NotePlayer({ notes, tempo: _tempo, musicalKey: _musicalKey, onTimeUpdate }: NotePlayerProps) {
  const [engineReady, setEngineReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);

  const toneRef = useRef<typeof import("tone") | null>(null);
  const synthRef = useRef<import("tone").PolySynth | null>(null);
  const analyserRef = useRef<import("tone").Analyser | null>(null);
  const scheduledIdsRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playingRef = useRef(false);

  const totalDuration = notes.length
    ? Math.max(...notes.map((n) => n.start_time + n.duration))
    : 0;

  const drawWaveform = useCallback(() => {
    const analyser = analyserRef.current;
    const canvas = canvasRef.current;
    if (!analyser || !canvas) return;

    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const width = canvas.width;
    const height = canvas.height;

    const values = analyser.getValue() as Float32Array;
    const bufferLength = values.length;

    ctx2d.fillStyle = "#f5f3ff";
    ctx2d.fillRect(0, 0, width, height);
    ctx2d.lineWidth = 2;
    ctx2d.strokeStyle = "#6d28d9";
    ctx2d.beginPath();

    const sliceWidth = width / bufferLength;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = values[i] || 0;
      const y = (0.5 + v * 0.45) * height;
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
      x += sliceWidth;
    }
    ctx2d.lineTo(width, height / 2);
    ctx2d.stroke();
  }, []);

  const drawIdleWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx2d.fillStyle = "#f5f3ff";
    ctx2d.fillRect(0, 0, width, height);
    ctx2d.strokeStyle = "#c4b5fd";
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, height / 2);
    ctx2d.lineTo(width, height / 2);
    ctx2d.stroke();
  }, []);

  const ensureEngine = useCallback(async () => {
    if (synthRef.current && toneRef.current) return;

    const Tone = await import("tone");
    toneRef.current = Tone;

    const analyser = new Tone.Analyser("waveform", 1024);
    analyserRef.current = analyser;

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

    synth.chain(volume, reverb, analyser, Tone.Destination);
    synthRef.current = synth;
    setEngineReady(true);
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
    drawIdleWaveform();
    onTimeUpdate?.(-1);
  }, [onTimeUpdate, drawIdleWaveform]);

  const play = useCallback(async () => {
    if (!notes.length) return;
    setLoading(true);
    await ensureEngine();
    const Tone = toneRef.current;
    const synth = synthRef.current;
    if (!Tone || !synth) return;
    await Tone.start();
    await stop();

    // Play raw transcription polyphonically: overlapping notes are allowed.
    const sorted = [...notes].sort((a, b) => a.start_time - b.start_time);
    for (const n of sorted) {
      const id = Tone.Transport.schedule((time) => {
        synth.triggerAttackRelease(
          midiToName(Math.round(n.pitch)),
          Math.max(0.03, n.duration),
          time,
          0.7
        );
      }, Math.max(0, n.start_time));
      scheduledIdsRef.current.push(id);
    }

    Tone.Transport.start("+0.03");
    startedAtRef.current = performance.now();
    playingRef.current = true;
    setPlaying(true);
    setLoading(false);

    const tick = () => {
      if (!playingRef.current) return;
      const elapsed = (performance.now() - startedAtRef.current) / 1000;
      onTimeUpdate?.(elapsed);
      drawWaveform();
      if (elapsed >= totalDuration + 0.5) {
        stop();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [notes, totalDuration, ensureEngine, stop, onTimeUpdate, drawWaveform]);

  useEffect(() => {
    drawIdleWaveform();
    return () => {
      stop();
      synthRef.current?.dispose();
      analyserRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawIdleWaveform]);

  const statusLabel = loading
    ? "Loading instrument…"
    : playing
    ? "⏹ Stop"
    : "▶ Play transcription";

  return (
    <div className="flex items-center gap-3 flex-wrap">
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

      {engineReady && !playing && (
        <span className="text-xs text-gray-400">Polyphonic synth playback</span>
      )}

      <canvas
        ref={canvasRef}
        width={300}
        height={56}
        className="rounded-lg border border-violet-100 bg-violet-50"
      />
    </div>
  );
}
