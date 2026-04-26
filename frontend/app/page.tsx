"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { uploadAudio } from "@/lib/api";
import RecordButton from "@/components/RecordButton";
import UploadZone from "@/components/UploadZone";

type Stage = "idle" | "uploading" | "error";

export default function Home() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleBlob(blob: Blob) {
    setError(null);
    setStage("uploading");
    try {
      const localUrl = URL.createObjectURL(blob);
      sessionStorage.setItem("recordingUrl", localUrl);

      const { session_id } = await uploadAudio(blob);
      router.push(`/notes?id=${session_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Is the server running?");
      setStage("idle");
    }
  }

  async function handleFile(file: File) {
    const blob = new Blob([await file.arrayBuffer()], { type: file.type });
    await handleBlob(blob);
  }

  return (
    <div className="flex min-h-[min(70vh,52rem)] flex-col items-center justify-center gap-12 py-4">
      <div className="text-center space-y-4 max-w-md">
        <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">
          From hum to a full score
        </h1>
        <p className="text-slate-500 text-base sm:text-lg leading-relaxed">
          Record or upload audio — we transcribe your line and build a choral arrangement
          you can open in MuseScore or your DAW.
        </p>
      </div>

      {error && (
        <div className="w-full max-w-md rounded-2xl border border-red-200/80 bg-red-50 text-red-800 px-5 py-3 text-sm text-center">
          {error}
        </div>
      )}

      {stage === "uploading" ? (
        <div className="flex flex-col items-center gap-4 text-violet-600">
          <span className="text-4xl animate-spin" aria-hidden>
            ⟳
          </span>
          <p className="font-medium">Uploading and starting transcription…</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-8 w-full max-w-md">
          <RecordButton onRecordingComplete={handleBlob} />

          <div className="flex items-center gap-3 w-full text-slate-400">
            <div className="flex-1 h-px bg-slate-200" />
            <span className="text-sm">or upload a file</span>
            <div className="flex-1 h-px bg-slate-200" />
          </div>

          <UploadZone onFile={handleFile} />
<<<<<<< HEAD

          <div className="w-full rounded-2xl border border-fuchsia-200 bg-white/80 p-5 shadow-sm text-left space-y-2">
            <p className="text-sm font-semibold text-gray-800">Text → singing AI</p>
            <p className="text-xs text-gray-500">
              Type a line, hear it from the voice API, then fix the melody in a piano roll and
              export MIDI — separate from humming a tune.
            </p>
            <Link
              href="/text-to-sing"
              className="inline-flex items-center gap-2 text-sm font-semibold text-fuchsia-700 hover:text-fuchsia-900"
            >
              Open text-to-sing workspace →
            </Link>
          </div>
=======
>>>>>>> 821b525cbf15088ddce180abea142d9f9ad51dc3
        </div>
      )}

      <p className="text-xs text-slate-400 text-center">WAV · MP3 · M4A · OGG · WebM</p>
    </div>
  );
}
