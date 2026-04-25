"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSession } from "@/lib/api";
import ProcessingStatus from "@/components/ProcessingStatus";

type Status = "transcribing" | "notes_ready" | "harmonizing" | "complete" | "failed";

function ProcessingContent() {
  const router = useRouter();
  const params = useSearchParams();
  const sessionId = params.get("id") ?? "";
  const [status, setStatus] = useState<Status>("harmonizing");

  useEffect(() => {
    if (!sessionId) { router.replace("/"); return; }

    const interval = setInterval(async () => {
      try {
        const data = await getSession(sessionId);
        setStatus(data.status as Status);

        if (data.status === "complete") {
          clearInterval(interval);
          router.push(`/result?id=${sessionId}`);
        }
        if (data.status === "failed") clearInterval(interval);
      } catch {
        // keep polling on network hiccup
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [sessionId, router]);

  return (
    <div className="flex flex-col items-center gap-12">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-extrabold text-gray-900">Building your arrangement…</h1>
        <p className="text-gray-500">Chord detection, voice leading, and MusicXML generation.</p>
      </div>

      <div className="bg-white rounded-3xl shadow-lg p-10 w-full max-w-md flex flex-col items-center gap-8">
        <ProcessingStatus status={status} />
      </div>

      {status === "failed" && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-red-500 text-sm">Harmonization failed.</p>
          <button
            onClick={() => router.push(`/notes?id=${sessionId}`)}
            className="px-6 py-3 rounded-xl bg-violet-600 text-white font-semibold hover:bg-violet-500 transition-colors"
          >
            ← Back to Notes
          </button>
        </div>
      )}
    </div>
  );
}

export default function ProcessingPage() {
  return (
    <Suspense fallback={<div className="text-center text-gray-400 mt-20">Loading…</div>}>
      <ProcessingContent />
    </Suspense>
  );
}
