"use client";

import { useEffect, useRef, useState } from "react";

interface WaveformProps {
  audioUrl: string;
  /** Height of the canvas in px (default 72). */
  height?: number;
}

/**
 * Decodes the audio at `audioUrl` with the Web Audio API and draws a
 * peak-envelope waveform on a canvas element.
 */
export default function Waveform({ audioUrl, height = 72 }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [failed,  setFailed]  = useState(false);

  useEffect(() => {
    if (!audioUrl) return;
    let cancelled = false;

    setLoading(true);
    setFailed(false);

    (async () => {
      try {
        const res = await fetch(audioUrl);
        const buf = await res.arrayBuffer();

        const ctx = new AudioContext();
        const decoded = await ctx.decodeAudioData(buf);
        ctx.close();

        if (cancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;

        const { width } = canvas.getBoundingClientRect();
        // Use device pixel ratio for crisp rendering
        const dpr = window.devicePixelRatio || 1;
        canvas.width  = Math.round(width  * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.height = `${height}px`;

        const gfx  = canvas.getContext("2d")!;
        gfx.scale(dpr, dpr);

        const data      = decoded.getChannelData(0);
        const cols      = Math.round(width);
        const step      = Math.ceil(data.length / cols);
        const midY      = height / 2;
        const amplitude = height / 2 - 2;

        // Gradient fill: violet-500 → indigo-400
        const grad = gfx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0,   "#8b5cf6");
        grad.addColorStop(0.5, "#6d28d9");
        grad.addColorStop(1,   "#8b5cf6");

        // Background
        gfx.fillStyle = "#f5f3ff";
        gfx.fillRect(0, 0, width, height);

        // Peak-envelope bars
        gfx.fillStyle = grad;
        for (let i = 0; i < cols; i++) {
          let min = 1, max = -1;
          const base = i * step;
          for (let j = 0; j < step; j++) {
            const v = data[base + j] ?? 0;
            if (v < min) min = v;
            if (v > max) max = v;
          }
          const barH = Math.max(1, (max - min) * amplitude);
          gfx.fillRect(i, midY - barH / 2, 1, barH);
        }

        // Centre line
        gfx.strokeStyle = "#c4b5fd";
        gfx.lineWidth = 0.5;
        gfx.beginPath();
        gfx.moveTo(0, midY);
        gfx.lineTo(width, midY);
        gfx.stroke();

        setLoading(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => { cancelled = true; };
  }, [audioUrl, height]);

  if (failed) return null;

  return (
    <div className="relative w-full rounded-xl overflow-hidden bg-violet-50" style={{ height }}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs text-violet-400 animate-pulse">Drawing waveform…</span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="w-full"
        style={{ display: loading ? "none" : "block", height }}
      />
    </div>
  );
}
