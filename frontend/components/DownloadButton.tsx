"use client";

import { useState } from "react";
import { downloadArrangement } from "@/lib/api";

interface DownloadButtonProps {
  sessionId: string;
}

export default function DownloadButton({ sessionId }: DownloadButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setLoading(true);
    setError(null);
    try {
      await downloadArrangement(sessionId);
    } catch {
      setError("Download failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={handleClick}
        disabled={loading}
        className="flex items-center gap-3 px-8 py-4 rounded-2xl bg-violet-600 hover:bg-violet-500 disabled:bg-violet-300 text-white font-semibold text-lg shadow-lg transition-all duration-200 hover:shadow-xl hover:-translate-y-0.5 focus:outline-none focus:ring-4 focus:ring-violet-300 focus:ring-offset-2"
      >
        {loading ? (
          <>
            <span className="animate-spin">⟳</span>
            Preparing file…
          </>
        ) : (
          <>
            <span className="text-xl">⬇</span>
            Download MuseScore File
          </>
        )}
      </button>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <p className="text-xs text-gray-400 mt-1">
        Opens directly in MuseScore · MusicXML 3.1
      </p>
    </div>
  );
}
