"use client";

import { useState } from "react";
import { downloadArrangementMidi } from "@/lib/api";

interface DownloadButtonProps {
  sessionId: string;
}

export default function DownloadButton({ sessionId }: DownloadButtonProps) {
  const [loadingMidi, setLoadingMidi] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleMidiClick = async () => {
    setLoadingMidi(true);
    setError(null);
    try {
      await downloadArrangementMidi(sessionId);
    } catch {
      setError("MIDI download failed. Please try again.");
    } finally {
      setLoadingMidi(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3 w-full max-w-md">
        <button
          onClick={handleMidiClick}
          disabled={loadingMidi}
          className="flex items-center gap-3 px-6 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-300 text-white font-semibold shadow-lg transition-all duration-200 hover:shadow-xl hover:-translate-y-0.5 focus:outline-none focus:ring-4 focus:ring-indigo-300 focus:ring-offset-2"
        >
          {loadingMidi ? (
            <>
              <span className="animate-spin">⟳</span>
              Preparing MIDI…
            </>
          ) : (
            <>
              <span className="text-lg">⬇</span>
              Download Arrangement MIDI
            </>
          )}
        </button>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <p className="text-xs text-gray-400 mt-1">
        Includes Lead + Piano + SATB chord parts
      </p>
    </div>
  );
}
