"use client";

import type { NoteEvent, ChordEvent } from "@/lib/api";

interface PartPreviewProps {
  keyName: string;
  tempo: number;
  chords: ChordEvent[];
  parts: {
    soprano: NoteEvent[];
    alto: NoteEvent[];
    tenor: NoteEvent[];
    bass: NoteEvent[];
  };
}

const VOICES = ["soprano", "alto", "tenor", "bass"] as const;
export default function PartPreview({ keyName, tempo, chords, parts }: PartPreviewProps) {
  const chordNames = chords.map((c) => c.chord_name);
  const voiceAtTime = (voice: (typeof VOICES)[number], t: number) => {
    const n = parts[voice].find((x) => x.start_time <= t && (x.start_time + x.duration) > t);
    return n?.note_name ?? "—";
  };

  return (
    <div className="w-full space-y-6">
      {/* Key / Tempo / Chords */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="px-3 py-1 rounded-full bg-violet-600 text-white text-sm font-semibold">
          {keyName}
        </span>
        <span className="px-3 py-1 rounded-full bg-gray-800 text-white text-sm font-semibold">
          {tempo} BPM
        </span>
        <div className="flex items-center gap-1">
          {chordNames.map((c, i) => (
            <span key={i} className="px-2 py-1 rounded bg-gray-100 text-gray-700 text-sm font-mono">
              {c}
              {i < chordNames.length - 1 && (
                <span className="ml-1 text-gray-400">→</span>
              )}
            </span>
          ))}
        </div>
      </div>

      {/* Chord-aligned SATB table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
        <table className="min-w-full text-sm font-mono">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Measure
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Chord
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">S</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">A</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">T</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">B</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {chords.slice(0, 16).map((c, i) => (
              <tr key={i} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 text-gray-500">{i + 1}</td>
                <td className="px-4 py-3 text-gray-700">{c.chord_name}</td>
                <td className="px-4 py-3 text-violet-700">{voiceAtTime("soprano", c.start_time)}</td>
                <td className="px-4 py-3 text-pink-700">{voiceAtTime("alto", c.start_time)}</td>
                <td className="px-4 py-3 text-blue-700">{voiceAtTime("tenor", c.start_time)}</td>
                <td className="px-4 py-3 text-emerald-700">{voiceAtTime("bass", c.start_time)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
