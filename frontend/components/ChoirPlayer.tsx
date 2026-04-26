"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startChoir, getChoirStatus, choirAudioUrl } from "@/lib/api";
import type { ChoirStatus } from "@/lib/api";

interface Props {
  sessionId: string;
}

const PART_META: Record<string, { label: string; range: string; color: string }> = {
  soprano: { label: "Soprano",  range: "C4 – G5", color: "bg-pink-50 border-pink-200 text-pink-700"   },
  alto:    { label: "Alto",     range: "G3 – D5", color: "bg-purple-50 border-purple-200 text-purple-700" },
  tenor:   { label: "Tenor",    range: "C3 – A4", color: "bg-blue-50 border-blue-200 text-blue-700"   },
  bass:    { label: "Bass",     range: "E2 – E4", color: "bg-emerald-50 border-emerald-200 text-emerald-700" },
};

const ORDERED_PARTS = ["mixed", "soprano", "alto", "tenor", "bass"] as const;

export default function ChoirPlayer({ sessionId }: Props) {
  const [status, setStatus]   = useState<ChoirStatus>("idle");
  const [parts,  setParts]    = useState<string[]>([]);
  const [error,  setError]    = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  // On mount, check if audio is already ready from a previous generation.
  useEffect(() => {
    (async () => {
      try {
        const s = await getChoirStatus(sessionId);
        setStatus(s.status);
        setParts(s.parts);
        if (s.status === "generating") startPolling();
        if (s.status === "failed") setError(s.error ?? "Generation failed");
      } catch { /* ignore — server may not know this session yet */ }
    })();
    return stopPolling;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const s = await getChoirStatus(sessionId);
        setStatus(s.status);
        setParts(s.parts);
        if (s.status === "ready" || s.status === "failed") {
          stopPolling();
          if (s.status === "failed") setError(s.error ?? "Generation failed");
        }
      } catch { /* keep polling on network hiccup */ }
    }, 3000);
  }, [sessionId]);

  const handleGenerate = async () => {
    setError(null);
    setStatus("generating");
    try {
      await startChoir(sessionId);
      startPolling();
    } catch (e) {
      setStatus("failed");
      setError(e instanceof Error ? e.message : "Failed to start choir synthesis");
    }
  };

  return (
    <div className="space-y-5">
      {/* Header + generate button */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Choir Audio</h2>
          <p className="text-sm text-gray-500">
            Each part sung by an AI voice via ElevenLabs — hear the full ensemble or solo parts.
          </p>
        </div>

        {status !== "ready" && (
          <button
            onClick={handleGenerate}
            disabled={status === "generating"}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 text-white text-sm font-semibold shadow hover:bg-violet-700 hover:-translate-y-0.5 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {status === "generating" ? (
              <><span className="animate-spin inline-block">⟳</span> Singing… (~30 s)</>
            ) : (
              <>🎤 Generate Choir Audio</>
            )}
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <p className="text-sm text-red-500 bg-red-50 rounded-xl px-4 py-2">{error}</p>
      )}

      {/* Generating hint */}
      {status === "generating" && (
        <div className="flex items-center gap-3 text-violet-600 text-sm bg-violet-50 rounded-2xl px-4 py-3">
          <span className="text-xl animate-pulse">♪</span>
          <span>
            ElevenLabs is generating each vocal part — pitch-shifting "aaah" vowels to your
            melody. This usually takes 20–40 seconds.
          </span>
        </div>
      )}

      {/* Audio players */}
      {status === "ready" && parts.length > 0 && (
        <div className="space-y-3">
          {ORDERED_PARTS.filter(p => parts.includes(p)).map(part => {
            const meta = PART_META[part];
            const url  = choirAudioUrl(sessionId, part);

            if (part === "mixed") {
              return (
                <div
                  key="mixed"
                  className="rounded-2xl border border-violet-200 bg-gradient-to-r from-violet-50 to-indigo-50 p-4 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-violet-600 text-lg">🎼</span>
                    <span className="font-bold text-violet-800">Full Choir</span>
                    <span className="text-xs text-violet-400 ml-auto">All 4 parts mixed</span>
                  </div>
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <audio controls src={url} className="w-full h-9" />
                </div>
              );
            }

            return (
              <div
                key={part}
                className={`rounded-2xl border p-4 space-y-2 ${meta.color}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{meta.label}</span>
                  <span className="text-xs opacity-60 ml-auto">{meta.range}</span>
                </div>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio controls src={url} className="w-full h-9" />
              </div>
            );
          })}

          <button
            onClick={handleGenerate}
            className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2 transition-colors"
          >
            Re-generate
          </button>
        </div>
      )}
    </div>
  );
}
