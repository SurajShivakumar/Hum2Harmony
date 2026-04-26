"use client";

import { useEffect, useMemo, useRef } from "react";
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

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const PX_PER_SECOND = 110;
const KEYBOARD_WIDTH = 56;
const ROW_HEIGHT = 14;

function noteClass(noteName: string): string {
  const root = noteName.replace(/\d+/, "");
  return NOTE_COLOURS[root] ?? "bg-gray-400";
}

function pitchName(pitch: number): string {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

export default function PianoRoll({ notes, currentTime = -1 }: PianoRollProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  const { totalDuration, minPitch, maxPitch, pitches, width, height } = useMemo(() => {
    if (!notes.length) {
      const minPitch = 48;
      const maxPitch = 84;
      const pitches = Array.from({ length: maxPitch - minPitch + 1 }, (_, i) => maxPitch - i);
      return {
        totalDuration: 1,
        minPitch,
        maxPitch,
        pitches,
        width: 600,
        height: pitches.length * ROW_HEIGHT,
      };
    }
    const pitches = notes.map((n) => n.pitch);
    const minP = Math.max(0, Math.min(...pitches) - 2);
    const maxP = Math.min(127, Math.max(...pitches) + 2);
    const pitchRows = Array.from({ length: maxP - minP + 1 }, (_, i) => maxP - i);
    const end = Math.max(...notes.map((n) => n.start_time + n.duration));
    return {
      totalDuration: Math.max(end, 1),
      minPitch: minP,
      maxPitch: maxP,
      pitches: pitchRows,
      width: Math.max(640, end * PX_PER_SECOND + 80),
      height: Math.max(180, pitchRows.length * ROW_HEIGHT),
    };
  }, [notes]);

  useEffect(() => {
    if (currentTime < 0 || !scrollerRef.current) return;
    const target = Math.max(0, currentTime * PX_PER_SECOND - 180);
    scrollerRef.current.scrollTo({ left: target, behavior: "smooth" });
  }, [currentTime]);

  const seconds = Math.ceil(totalDuration);

  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-950 shadow-inner overflow-hidden select-none">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-900">
        <p className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
          Piano Roll
        </p>
        <p className="text-[11px] text-gray-500 font-mono">
          {notes.length} notes · {totalDuration.toFixed(1)}s
        </p>
      </div>

      <div ref={scrollerRef} className="relative w-full overflow-x-auto">
        <div className="relative" style={{ width: width + KEYBOARD_WIDTH, height }}>
          {/* Sticky piano keyboard */}
          <div
            className="sticky left-0 z-20 bg-gray-900 border-r border-gray-700"
            style={{ width: KEYBOARD_WIDTH, height }}
          >
            {pitches.map((pitch, row) => {
              const black = BLACK_KEYS.has(pitch % 12);
              const isC = pitch % 12 === 0;
              return (
                <div
                  key={pitch}
                  className={[
                    "absolute left-0 right-0 border-b text-[9px] font-mono flex items-center justify-end pr-1",
                    black ? "bg-gray-800 border-gray-900 text-gray-500" : "bg-gray-100 border-gray-300 text-gray-700",
                    isC ? "font-bold" : "",
                  ].join(" ")}
                  style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT }}
                >
                  {isC ? pitchName(pitch) : ""}
                </div>
              );
            })}
          </div>

          {/* Scrollable grid */}
          <div
            className="absolute top-0"
            style={{ left: KEYBOARD_WIDTH, width, height }}
          >
            {/* Horizontal pitch rows */}
            {pitches.map((pitch, row) => {
              const black = BLACK_KEYS.has(pitch % 12);
              const isC = pitch % 12 === 0;
              return (
                <div
                  key={pitch}
                  className={[
                    "absolute left-0 right-0 border-b",
                    black ? "bg-gray-900/70 border-gray-900" : "bg-gray-950 border-gray-900",
                    isC ? "border-gray-700" : "",
                  ].join(" ")}
                  style={{ top: row * ROW_HEIGHT, height: ROW_HEIGHT }}
                />
              );
            })}

            {/* Vertical time grid */}
            {Array.from({ length: seconds * 2 + 1 }, (_, i) => {
              const t = i * 0.5;
              const major = i % 2 === 0;
              return (
                <div
                  key={i}
                  className={[
                    "absolute top-0 bottom-0 border-l pointer-events-none",
                    major ? "border-gray-700" : "border-gray-800/70",
                  ].join(" ")}
                  style={{ left: t * PX_PER_SECOND }}
                >
                  {major && (
                    <span className="absolute top-1 left-1 text-[9px] text-gray-500 font-mono">
                      {t.toFixed(0)}s
                    </span>
                  )}
                </div>
              );
            })}

            {/* Playhead */}
            {currentTime >= 0 && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-yellow-300 shadow-[0_0_10px_rgba(250,204,21,0.8)] z-10 pointer-events-none"
                style={{ left: Math.min(width, currentTime * PX_PER_SECOND) }}
              />
            )}

            {/* Notes */}
            {notes.map((note, i) => {
              const row = maxPitch - note.pitch;
              const left = note.start_time * PX_PER_SECOND;
              const noteWidth = Math.max(6, note.duration * PX_PER_SECOND);
              const active = currentTime >= note.start_time && currentTime < note.start_time + note.duration;

              return (
                <div
                  key={`${note.pitch}-${note.start_time}-${i}`}
                  title={`${note.note_name} · ${note.start_time.toFixed(2)}s · ${note.duration.toFixed(2)}s`}
                  className={[
                    "absolute rounded-md border border-white/20 transition-all duration-75",
                    noteClass(note.note_name),
                    active
                      ? "opacity-100 scale-y-125 z-10 ring-2 ring-yellow-200 shadow-[0_0_14px_rgba(250,204,21,0.55)]"
                      : "opacity-75 hover:opacity-100",
                  ].join(" ")}
                  style={{
                    left,
                    top: row * ROW_HEIGHT + 2,
                    width: noteWidth,
                    height: ROW_HEIGHT - 4,
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
