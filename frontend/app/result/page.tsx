"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSession } from "@/lib/api";
import type { SessionData } from "@/lib/api";
import PartPreview from "@/components/PartPreview";
import DownloadButton from "@/components/DownloadButton";

function ResultContent() {
  const router = useRouter();
  const params = useSearchParams();
  const sessionId = params.get("id") ?? "";

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      router.replace("/");
      return;
    }

    (async () => {
      try {
        const session = await getSession(sessionId);
        if (session.status !== "complete") {
          router.replace(`/processing?id=${sessionId}`);
          return;
        }
        setData(session);
      } catch {
        setError("Could not load results. Please try again.");
      } finally {
        setLoading(false);
      }
    })();
  }, [sessionId, router]);

  if (loading) {
    return (
      <div className="text-center mt-24 text-gray-400 text-lg animate-pulse">
        Loading arrangement…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center gap-6 mt-24">
        <p className="text-red-500">{error ?? "No data found."}</p>
        <button
          onClick={() => router.push("/")}
          className="px-6 py-3 rounded-xl bg-violet-600 text-white font-semibold hover:bg-violet-500"
        >
          Try Another Melody
        </button>
      </div>
    );
  }

  const hasParts =
    data.parts &&
    data.parts.soprano?.length > 0;

  return (
    <div className="flex flex-col gap-10">
      {/* Hero banner */}
      <div className="bg-white rounded-3xl shadow-lg p-8 flex flex-col sm:flex-row items-center justify-between gap-6">
        <div className="space-y-1">
          <h1 className="text-3xl font-extrabold text-gray-900">Your Arrangement</h1>
          <p className="text-gray-500 text-sm">
            Lead + Piano + SATB chord arrangement
          </p>
        </div>
        <div className="flex gap-4 text-center">
          <div className="px-4 py-3 bg-violet-50 rounded-2xl">
            <p className="text-xs text-violet-500 font-semibold uppercase tracking-wider">Key</p>
            <p className="text-lg font-bold text-violet-700">{data.key || "—"}</p>
          </div>
          <div
            className="px-4 py-3 bg-violet-50 rounded-2xl"
            title="Used for MusicXML and MIDI export"
          >
            <p className="text-xs text-violet-500 font-semibold uppercase tracking-wider">Tempo</p>
            <p className="text-lg font-bold text-violet-700">{data.tempo} BPM</p>
          </div>
        </div>
      </div>

      {/* Part preview */}
      {hasParts ? (
        <div className="bg-white rounded-3xl shadow-lg p-8">
          <h2 className="text-lg font-semibold text-gray-800 mb-6">Part Preview</h2>
          <PartPreview
            keyName={data.key}
            tempo={data.tempo}
            chords={data.chords}
            parts={data.parts}
          />
        </div>
      ) : (
        <div className="bg-white rounded-3xl shadow-lg p-8 text-center text-gray-400">
          No part data available.
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
        <DownloadButton sessionId={sessionId} />
        <button
          onClick={() => router.push("/")}
          className="px-6 py-3 rounded-2xl border border-gray-300 text-gray-700 font-semibold hover:bg-gray-50 transition-colors"
        >
          Try Another Melody
        </button>
      </div>
    </div>
  );
}

export default function ResultPage() {
  return (
    <Suspense fallback={<div className="text-center text-gray-400 mt-20">Loading…</div>}>
      <ResultContent />
    </Suspense>
  );
}
