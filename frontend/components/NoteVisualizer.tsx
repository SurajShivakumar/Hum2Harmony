"use client";

import type { Note } from "@/lib/basicPitch";

export default function NoteVisualizer({ notes }: { notes: Note[] }) {
  if (!notes.length) {
    return (
      <div className="w-full rounded-xl border border-zinc-700 bg-zinc-900 p-8 text-center text-zinc-400">
        No notes detected.
      </div>
    );
  }

  const minPitch = Math.min(...notes.map((n) => n.pitchMidi));
  const maxPitch = Math.max(...notes.map((n) => n.pitchMidi));
  const pitchSpan = Math.max(1, maxPitch - minPitch + 1);
  const totalTime = Math.max(...notes.map((n) => n.startTimeSeconds + n.durationSeconds));

  return (
    <div className="w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 overflow-x-auto">
      <div className="relative min-w-[900px] h-[320px]">
        {notes.map((n, idx) => {
          const left = (n.startTimeSeconds / totalTime) * 100;
          const width = Math.max(0.3, (n.durationSeconds / totalTime) * 100);
          const row = maxPitch - n.pitchMidi;
          const top = (row / pitchSpan) * 100;
          const hue = ((n.pitchMidi % 12) / 12) * 360;
          return (
            <div
              key={`${n.pitchMidi}-${n.startTimeSeconds}-${idx}`}
              className="absolute rounded-sm"
              title={`${n.pitchMidi} @ ${n.startTimeSeconds.toFixed(2)}s`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                top: `${top}%`,
                height: `${Math.max(3, 96 / pitchSpan)}%`,
                backgroundColor: `hsla(${hue}, 85%, 65%, ${Math.max(0.35, n.amplitude)})`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

