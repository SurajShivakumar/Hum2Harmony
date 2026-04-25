"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  startMelodyVoice,
  getMelodyVoiceStatus,
  melodyVoiceAudioUrl,
} from "@/lib/api";
import type { MelodyVoiceStatus } from "@/lib/api";

interface Props {
  sessionId: string;
}

export default function MelodyVoicePlayer({ sessionId }: Props) {
  const [status, setStatus] = useState<MelodyVoiceStatus>("idle");
  const [error,  setError]  = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  // On mount check if audio is already available
  useEffect(() => {
    (async () => {
      try {
        const s = await getMelodyVoiceStatus(sessionId);
        setStatus(s.status);
        if (s.status === "generating") startPolling();
        if (s.status === "failed") setError(s.error ?? "Generation failed");
      } catch { /* not yet known */ }
    })();
    return stopPolling;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const s = await getMelodyVoiceStatus(sessionId);
        setStatus(s.status);
        if (s.status !== "generating") {
          stopPolling();
          if (s.status === "failed") setError(s.error ?? "Generation failed");
        }
      } catch { /* keep polling */ }
    }, 3000);
  }, [sessionId]);

  const handleGenerate = async () => {
    setError(null);
    setStatus("generating");
    try {
      await startMelodyVoice(sessionId);
      startPolling();
    } catch (e) {
      setStatus("failed");
      setError(e instanceof Error ? e.message : "Failed to start");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-sm font-medium text-gray-700">
            AI Voice Preview
          </p>
          <p className="text-xs text-gray-400">
            ElevenLabs sings your melody back in "dom" syllables
          </p>
        </div>

        {status !== "ready" && (
          <button
            onClick={handleGenerate}
            disabled={status === "generating"}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-600 text-white text-sm font-semibold shadow hover:bg-violet-700 hover:-translate-y-0.5 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {status === "generating" ? (
              <><span className="animate-spin inline-block">⟳</span> Generating…</>
            ) : (
              <>🎤 Hear it sung</>
            )}
          </button>
        )}
      </div>

      {status === "generating" && (
        <div className="flex items-center gap-2 text-xs text-violet-600 bg-violet-50 rounded-xl px-3 py-2">
          <span className="animate-pulse text-base">♪</span>
          Pitch-shifting your melody with ElevenLabs — usually ~20 seconds…
        </div>
      )}

      {error && (
        <p className="text-xs text-red-500 bg-red-50 rounded-xl px-3 py-2">{error}</p>
      )}

      {status === "ready" && (
        <div className="rounded-2xl border border-violet-200 bg-violet-50 p-3 space-y-1.5">
          <p className="text-xs font-semibold text-violet-600 uppercase tracking-wider">
            🎵 ElevenLabs — Melody Voice
          </p>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls src={melodyVoiceAudioUrl(sessionId)} className="w-full h-9" />
          <button
            onClick={handleGenerate}
            className="text-xs text-violet-400 hover:text-violet-600 underline underline-offset-2 transition-colors"
          >
            Re-generate
          </button>
        </div>
      )}
    </div>
  );
}
