"use client";

import { useMemo } from "react";
import type { NoteEvent } from "@/lib/api";

interface PianoRollProps {
  notes: NoteEvent[];
  currentTime?: number;
}

// Colour note names (C is red, following the colour-music circle)
const NOTE_COLOURS: Record<string, string> = {
  C:   "bg-red-400",
  "C#": "bg-orange-400",
  D:   "bg-yellow-400",
  "D#": "bg-lime-400",
  E:   "bg-green-400",
  F:   "bg-teal-400",
  "F#": "bg-cyan-400",
  G:   "bg-blue-400",
  "G#": "bg-indigo-400",
  A:   "bg-violet-400",
  "A#": "bg-purple-400",
  B:   "bg-pink-400",
};

function noteClass(noteName: string): string {
  const root = noteName.replace(/\d+/, "");
  return NOTE_COLOURS[root] ?? "bg-gray-400";
}

export default function PianoRoll({ notes, currentTime = -1 }: PianoRollProps) {
  const { totalDuration, minPitch, maxPitch } = useMemo(() => {
    if (!notes.length) return { totalDuration: 1, minPitch: 48, maxPitch: 84 };
    const pitches = notes.map((n) => n.pitch);
    const minP = Math.min(...pitches) - 2;
    const maxP = Math.max(...pitches) + 2;
    const end = Math.max(...notes.map((n) => n.start_time + n.duration));
    return { totalDuration: end, minPitch: minP, maxPitch: maxP };
  }, [notes]);

  const pitchRange = maxPitch - minPitch || 1;

  return (
    <div className="relative w-full overflow-x-auto rounded-xl border border-gray-200 bg-gray-950 select-none">
      <div
        className="relative"
        style={{ height: Math.max(120, pitchRange * 6), minWidth: Math.max(400, totalDuration * 80) }}
      >
        {/* Horizontal grid lines */}
        {Array.from({ length: pitchRange + 1 }, (_, i) => {
          const pitch = minPitch + i;
          const isC = pitch % 12 === 0;
          const top = ((maxPitch - pitch) / pitchRange) * 100;
          return (
            <div
              key={pitch}
              className={`absolute w-full border-t ${isC ? "border-gray-600" : "border-gray-800"}`}
              style={{ top: `${top}%` }}
            >
              {isC && (
                <span className="absolute left-1 text-[9px] text-gray-500 font-mono -translate-y-1/2">
                  C{(pitch / 12) - 1 | 0}
                </span>
              )}
            </div>
          );
        })}

        {/* Playhead */}
        {currentTime >= 0 && (
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-yellow-400 opacity-80 z-10 pointer-events-none"
            style={{ left: `${(currentTime / totalDuration) * 100}%` }}
          />
        )}

        {/* Notes */}
        {notes.map((note, i) => {
          const left = (note.start_time / totalDuration) * 100;
          const width = Math.max(0.5, (note.duration / totalDuration) * 100);
          const top = ((maxPitch - note.pitch) / pitchRange) * 100;
          const height = (1 / pitchRange) * 100;
          const active = currentTime >= note.start_time && currentTime < note.start_time + note.duration;

          return (
            <div
              key={i}
              title={`${note.note_name} — ${note.duration.toFixed(2)}s`}
              className={[
                "absolute rounded-sm transition-opacity duration-75",
                noteClass(note.note_name),
                active ? "opacity-100 ring-1 ring-white" : "opacity-75",
              ].join(" ")}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                top: `${top}%`,
                height: `${Math.max(height, 2)}%`,
                minHeight: 4,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
