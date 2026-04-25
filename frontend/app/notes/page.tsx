"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSession, harmonizeSession } from "@/lib/api";
import type { NoteEvent, SessionStatus } from "@/lib/api";
import AudioPlayer from "@/components/AudioPlayer";
import PianoRoll from "@/components/PianoRoll";
import NotePlayer from "@/components/NotePlayer";

function NotesContent() {
  const router = useRouter();
  const params = useSearchParams();
  const sessionId = params.get("id") ?? "";

  const [status, setStatus] = useState<SessionStatus>("transcribing");
  const [notes, setNotes] = useState<NoteEvent[]>([]);
  const [key, setKey] = useState("");
  const [tempo, setTempo] = useState(120);
  const [bpmLibrosa, setBpmLibrosa] = useState<number | null>(null);
  const [pianoTime, setPianoTime] = useState(-1);
  const [harmonizing, setHarmonizing] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // Retrieve the blob URL stored on the record page
  useEffect(() => {
    const stored = sessionStorage.getItem("recordingUrl");
    if (stored) setAudioUrl(stored);
  }, []);

  // Poll for notes
  useEffect(() => {
    if (!sessionId) { router.replace("/"); return; }

    const interval = setInterval(async () => {
      try {
        const data = await getSession(sessionId);
        setStatus(data.status);
        if (data.notes?.length) {
          setNotes(data.notes);
          setKey(data.key);
          setTempo(data.tempo);
          setBpmLibrosa(data.bpm_librosa ?? null);
        }
        if (data.status === "notes_ready" || data.status === "complete") {
          clearInterval(interval);
        }
        if (data.status === "failed") {
          clearInterval(interval);
        }
        // If harmonization finished (user pressed generate), go to result
        if (data.status === "complete") {
          router.push(`/result?id=${sessionId}`);
        }
      } catch {
        // network hiccup — keep polling
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [sessionId, router]);

  const handleGenerateHarmony = async () => {
    setHarmonizing(true);
    try {
      await harmonizeSession(sessionId);
      // Now poll for complete on processing page
      router.push(`/processing?id=${sessionId}`);
    } catch {
      setHarmonizing(false);
      alert("Failed to start harmonization. Please try again.");
    }
  };

  const transcribing = status === "transcribing";
  const notesReady = notes.length > 0 && (status === "notes_ready" || status === "complete");

  return (
    <div className="flex flex-col gap-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-extrabold text-gray-900">Your Melody</h1>
          <p className="text-gray-500 mt-1">
            Listen back, see the notes, then generate a full choral arrangement.
          </p>
        </div>
        <button
          onClick={() => router.push("/")}
          className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
        >
          ← Record again
        </button>
      </div>

      {/* Section 1: Audio playback */}
      {audioUrl && (
        <section className="bg-white rounded-3xl shadow-sm p-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
            Your Recording
          </h2>
          <AudioPlayer src={audioUrl} label="Original humming" />
        </section>
      )}

      {/* Section 2: Transcription status / notes */}
      <section className="bg-white rounded-3xl shadow-sm p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
            Notes (Basic Pitch)
          </h2>
          {notesReady && (
            <div className="flex gap-3 text-sm">
              <span className="px-2.5 py-1 rounded-full bg-violet-100 text-violet-700 font-semibold">
                {key}
              </span>
              <span
                className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-semibold"
                title="From note onsets (used for preview & arrangement)"
              >
                Melody {tempo} BPM
              </span>
              {bpmLibrosa != null && (
                <span
                  className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 font-semibold"
                  title="librosa beat_track on the recording"
                >
                  Librosa {bpmLibrosa} BPM
                </span>
              )}
              <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-semibold">
                {notes.length} notes
              </span>
            </div>
          )}
        </div>

        {transcribing && (
          <div className="flex items-center gap-3 py-6 justify-center text-violet-600">
            <span className="text-2xl animate-spin">⟳</span>
            <span className="font-medium">Basic Pitch is transcribing your melody…</span>
          </div>
        )}

        {status === "failed" && (
          <div className="text-center py-6 text-red-500">
            Transcription failed. <button onClick={() => router.push("/")} className="underline">Try again</button>
          </div>
        )}

        {notesReady && (
          <div className="space-y-4">
            {/* Piano roll */}
            <PianoRoll notes={notes} currentTime={pianoTime} />

            {/* Note player */}
            <div className="flex items-center justify-between flex-wrap gap-3">
              <NotePlayer
                notes={notes}
                tempo={tempo}
                onTimeUpdate={setPianoTime}
              />
              <p className="text-xs text-gray-400">
                Powered by Tone.js · triangle oscillator with reverb
              </p>
            </div>

            {/* Note list (scrollable) */}
            <details className="group">
              <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-700 select-none">
                Show raw note data ({notes.length} notes)
              </summary>
              <div className="mt-3 max-h-48 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50 p-3 font-mono text-xs text-gray-600 grid grid-cols-2 sm:grid-cols-3 gap-1">
                {notes.map((n, i) => (
                  <span key={i} className="px-1.5 py-0.5 rounded bg-white border border-gray-100">
                    {n.note_name} <span className="text-gray-400">@{n.start_time.toFixed(2)}s</span>
                  </span>
                ))}
              </div>
            </details>
          </div>
        )}
      </section>

      {/* Section 3: Generate harmony CTA */}
      {notesReady && (
        <section className="bg-gradient-to-br from-violet-600 to-violet-700 rounded-3xl shadow-lg p-8 text-white text-center space-y-4">
          <h2 className="text-2xl font-bold">Ready to arrange?</h2>
          <p className="text-violet-200 text-sm max-w-md mx-auto">
            We'll generate a 4-part SATB choral arrangement with Soprano, Alto,
            Tenor, and Bass from your melody — ready to open in MuseScore.
          </p>
          <button
            onClick={handleGenerateHarmony}
            disabled={harmonizing}
            className="inline-flex items-center gap-2 px-8 py-4 bg-white text-violet-700 font-bold rounded-2xl shadow hover:shadow-md hover:-translate-y-0.5 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {harmonizing ? (
              <><span className="animate-spin">⟳</span> Starting…</>
            ) : (
              "🎼 Generate Choral Harmony"
            )}
          </button>
        </section>
      )}
    </div>
  );
}

export default function NotesPage() {
  return (
    <Suspense fallback={<div className="text-center text-gray-400 mt-20 animate-pulse">Loading…</div>}>
      <NotesContent />
    </Suspense>
  );
}
