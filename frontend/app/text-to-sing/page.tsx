"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { textSing } from "@/lib/api";

export default function TextToSingPage() {
  const router = useRouter();
  const [lyrics, setLyrics] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    const text = lyrics.trim();
    if (text.length < 2) {
      setError("Type at least a few words.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const { session_id } = await textSing(text);
      router.push(`/text-to-sing/melody?id=${session_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start");
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-fuchsia-50 to-violet-100 flex flex-col items-center p-8 gap-8">
      <div className="w-full max-w-lg flex items-center justify-between">
        <Link
          href="/"
          className="text-sm text-violet-600 hover:text-violet-800"
        >
          ← Home
        </Link>
        <span className="text-xs text-gray-500">Text → ElevenLabs Music → MIDI</span>
      </div>

      <div className="text-center space-y-2 max-w-lg">
        <h1 className="text-3xl font-extrabold text-gray-900">Text to singing</h1>
        <p className="text-gray-600 text-sm">
          This uses the <strong>ElevenLabs Music API</strong> to generate an actual
          short song with lead vocals from your lyrics, then transcribes the result into
          notes so you can edit pitch and export MIDI.
        </p>
      </div>

      {error && (
        <div className="w-full max-w-lg rounded-2xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
          {error}
        </div>
      )}

      <div className="w-full max-w-lg space-y-3">
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider">
          Lyrics or phrase
        </label>
        <textarea
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
          disabled={busy}
          rows={5}
          placeholder="e.g. Row row row your boat gently down the stream"
          className="w-full rounded-2xl border border-violet-200 bg-white px-4 py-3 text-gray-800 shadow-sm outline-none focus:ring-2 focus:ring-violet-200 disabled:opacity-60"
        />
        <p className="text-xs text-gray-500">
          Shorter lines work best for clear vocals and better MIDI extraction. Music generation
          requires a paid ElevenLabs plan.
        </p>
      </div>

      <button
        type="button"
        onClick={handleStart}
        disabled={busy || !lyrics.trim()}
        className="inline-flex items-center gap-2 px-8 py-4 rounded-2xl bg-violet-600 text-white font-bold shadow-lg hover:bg-violet-700 transition disabled:opacity-50"
      >
        {busy ? (
          <>
            <span className="animate-spin">⟳</span> Generating music &amp; transcribing…
          </>
        ) : (
          <>🎵 Generate song &amp; open melody editor</>
        )}
      </button>
    </main>
  );
}
