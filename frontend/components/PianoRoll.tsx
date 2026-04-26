"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { NoteEvent } from "@/lib/api";

interface PianoRollProps {
  notes: NoteEvent[];
  currentTime?: number;
  selectedIndex?: number | null;
  selectedIndices?: number[];
  onSelectNote?: (index: number) => void;
  onSelectNotes?: (indices: number[]) => void;
  onChangeNote?: (index: number, patch: Partial<NoteEvent>) => void;
  onSplitNote?: (index: number, splitTime: number) => void;
  onSeek?: (time: number) => void;
  onHoverPosition?: (position: { time: number; pitch: number } | null) => void;
}

/** Body: move in time + pitch. Left/right edges: trim start or end. */
type DragMode = "move" | "left" | "right";

interface DragState {
  index: number;
  mode: DragMode;
  startX: number;
  startY: number;
  original: NoteEvent;
}

interface MarqueeState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  originLeft: number;
  originTop: number;
  moved: boolean;
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

export default function PianoRoll({
  notes,
  currentTime = -1,
  selectedIndex = null,
  selectedIndices = selectedIndex == null ? [] : [selectedIndex],
  onSelectNote,
  onSelectNotes,
  onChangeNote,
  onSplitNote,
  onSeek,
  onHoverPosition,
}: PianoRollProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);

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

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      const marqueeState = marqueeRef.current;
      if (marqueeState) {
        const next = {
          ...marqueeState,
          currentX: event.clientX - marqueeState.originLeft,
          currentY: event.clientY - marqueeState.originTop,
          moved: marqueeState.moved
            || Math.abs(event.clientX - marqueeState.originLeft - marqueeState.startX) > 4
            || Math.abs(event.clientY - marqueeState.originTop - marqueeState.startY) > 4,
        };
        marqueeRef.current = next;
        setMarquee(next);

        if (next.moved) {
          const x1 = Math.min(next.startX, next.currentX);
          const x2 = Math.max(next.startX, next.currentX);
          const y1 = Math.min(next.startY, next.currentY);
          const y2 = Math.max(next.startY, next.currentY);
          const selected = notes.flatMap((note, index) => {
            const noteX1 = note.start_time * PX_PER_SECOND;
            const noteX2 = noteX1 + Math.max(6, note.duration * PX_PER_SECOND);
            const noteY1 = (maxPitch - note.pitch) * ROW_HEIGHT + 2;
            const noteY2 = noteY1 + ROW_HEIGHT - 4;
            const intersects = noteX1 <= x2 && noteX2 >= x1 && noteY1 <= y2 && noteY2 >= y1;
            return intersects ? [index] : [];
          });
          onSelectNotes?.(selected);
        }
        return;
      }

      const drag = dragRef.current;
      if (!drag || !onChangeNote) return;

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const timeDelta = Math.round((dx / PX_PER_SECOND) / 0.05) * 0.05;

      if (drag.mode === "move") {
        const semitones = Math.round(-dy / ROW_HEIGHT);
        const newPitch = Math.max(0, Math.min(127, drag.original.pitch + semitones));
        const newStart = Math.max(0, drag.original.start_time + timeDelta);
        onChangeNote(drag.index, {
          pitch: newPitch,
          start_time: Number(newStart.toFixed(4)),
        });
        return;
      }

      if (drag.mode === "left") {
        const originalEnd = drag.original.start_time + drag.original.duration;
        const start = Math.max(0, Math.min(originalEnd - 0.03, drag.original.start_time + timeDelta));
        onChangeNote(drag.index, {
          start_time: Number(start.toFixed(4)),
          duration: Number((originalEnd - start).toFixed(4)),
        });
        return;
      }

      const duration = Math.max(0.03, drag.original.duration + timeDelta);
      onChangeNote(drag.index, { duration: Number(duration.toFixed(4)) });
    };

    const handleUp = () => {
      const marqueeState = marqueeRef.current;
      if (marqueeState) {
        marqueeRef.current = null;
        setMarquee(null);
        if (!marqueeState.moved) {
          const time = Math.max(0, Math.min(totalDuration, marqueeState.startX / PX_PER_SECOND));
          onSeek?.(Number(time.toFixed(3)));
        }
      }
      dragRef.current = null;
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [maxPitch, notes, onChangeNote, onSeek, onSelectNotes, totalDuration]);

  const startDrag = (
    event: ReactMouseEvent,
    index: number,
    mode: DragMode,
    original: NoteEvent
  ) => {
    event.preventDefault();
    event.stopPropagation();
    onSelectNote?.(index);
    dragRef.current = {
      index,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      original,
    };
  };

  const splitNoteAtPointer = (
    event: ReactMouseEvent,
    index: number,
    original: NoteEvent
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, event.clientX - rect.left);
    const splitOffset = x / PX_PER_SECOND;
    const splitTime = original.start_time + splitOffset;
    onSplitNote?.(index, Number(splitTime.toFixed(4)));
  };

  const handleGridMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-note]")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, event.clientX - rect.left);
    const y = Math.max(0, event.clientY - rect.top);
    marqueeRef.current = {
      startX: x,
      startY: y,
      currentX: x,
      currentY: y,
      originLeft: rect.left,
      originTop: rect.top,
      moved: false,
    };
    setMarquee(marqueeRef.current);
  };

  const handleGridMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, event.clientX - rect.left);
    const y = Math.max(0, event.clientY - rect.top);
    const time = Math.max(0, Math.min(totalDuration, x / PX_PER_SECOND));
    const pitch = Math.max(minPitch, Math.min(maxPitch, maxPitch - Math.floor(y / ROW_HEIGHT)));
    onHoverPosition?.({
      time: Number(time.toFixed(3)),
      pitch,
    });
  };

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
            onMouseDown={handleGridMouseDown}
            onMouseMove={handleGridMouseMove}
            onMouseLeave={() => onHoverPosition?.(null)}
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
              const selected = selectedIndices.includes(i);

              return (
                <button
                  type="button"
                  data-note="true"
                  key={`${note.pitch}-${note.start_time}-${i}`}
                  onClick={() => onSelectNote?.(i)}
                  onMouseDown={(event) => startDrag(event, i, "move", note)}
                  onDoubleClick={(event) => splitNoteAtPointer(event, i, note)}
                  title={`${note.note_name} · ${note.start_time.toFixed(2)}s · ${note.duration.toFixed(2)}s`}
                  className={[
                    "absolute rounded-md border transition-all duration-75 focus:outline-none cursor-move",
                    selected ? "border-white ring-2 ring-white/80 z-20" : "border-white/20",
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
                >
                  <span
                    className="absolute left-0 top-0 h-full w-2 cursor-ew-resize rounded-l-md bg-white/20 hover:bg-white/45 z-10"
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      startDrag(event, i, "left", note);
                    }}
                  />
                  <span
                    className="absolute right-0 top-0 h-full w-2 cursor-ew-resize rounded-r-md bg-white/20 hover:bg-white/45 z-10"
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      startDrag(event, i, "right", note);
                    }}
                  />
                </button>
              );
            })}

            {marquee && (
              <div
                className="absolute z-30 border border-violet-300 bg-violet-400/20 pointer-events-none"
                style={{
                  left: Math.min(marquee.startX, marquee.currentX),
                  top: Math.min(marquee.startY, marquee.currentY),
                  width: Math.abs(marquee.currentX - marquee.startX),
                  height: Math.abs(marquee.currentY - marquee.startY),
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
