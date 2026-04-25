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
const VOICE_COLORS: Record<(typeof VOICES)[number], string> = {
  soprano: "bg-violet-100 text-violet-800",
  alto: "bg-pink-100 text-pink-800",
  tenor: "bg-blue-100 text-blue-800",
  bass: "bg-emerald-100 text-emerald-800",
};

export default function PartPreview({ keyName, tempo, chords, parts }: PartPreviewProps) {
  const chordNames = chords.map((c) => c.chord_name);

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

      {/* Part table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
        <table className="min-w-full text-sm font-mono">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider w-24">
                Voice
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Notes (first 16)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {VOICES.map((voice) => {
              const notes = parts[voice].slice(0, 16);
              return (
                <tr key={voice} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-semibold uppercase ${VOICE_COLORS[voice]}`}
                    >
                      {voice}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                    {notes.map((n, i) => (
                      <span key={i} className="mr-2">
                        {n.note_name}
                      </span>
                    ))}
                    {parts[voice].length > 16 && (
                      <span className="text-gray-400">…</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
