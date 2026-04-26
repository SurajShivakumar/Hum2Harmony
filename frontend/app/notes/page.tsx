"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSession, harmonizeSession, refineAndDownloadMidi } from "@/lib/api";
import type { NoteEvent, SessionStatus } from "@/lib/api";
import type { Note } from "@/lib/basicPitch";
import { notesToRawMidiUri } from "@/lib/midiWriter";
import { combineSustainArtifacts } from "@/lib/noteCleanup";
import AudioPlayer from "@/components/AudioPlayer";
import Waveform from "@/components/Waveform";
import PianoRoll from "@/components/PianoRoll";
import NotePlayer from "@/components/NotePlayer";
import MelodyVoicePlayer from "@/components/MelodyVoicePlayer";

function NotesContent() {
  const router    = useRouter();
  const params    = useSearchParams();
  const sessionId = params.get("id") ?? "";

  const [status,      setStatus]      = useState<SessionStatus>("transcribing");
  const [notes,       setNotes]       = useState<NoteEvent[]>([]);
  const [key,         setKey]         = useState("");
  const [tempo,       setTempo]       = useState(120);
  const [bpmLibrosa,  setBpmLibrosa]  = useState<number | null>(null);
  const [pianoTime,   setPianoTime]   = useState(-1);
  const [harmonizing, setHarmonizing] = useState(false);
  const [refining,    setRefining]    = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [audioUrl,    setAudioUrl]    = useState<string | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem("recordingUrl");
    if (stored) setAudioUrl(stored);
  }, []);

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
        // Stop polling once transcription is done (keep the user on this page)
        if (data.status !== "transcribing") clearInterval(interval);
      } catch { /* network hiccup */ }
    }, 1500);

    return () => clearInterval(interval);
  }, [sessionId, router]);

  const handleDownloadMidi = () => {
    const basicNotes: Note[] = notes.map(n => ({
      pitchMidi:          n.pitch,
      startTimeSeconds:   n.start_time,
      durationSeconds:    n.duration,
      amplitude:          0.75,
    }));
    const uri = notesToRawMidiUri(basicNotes, tempo);
    const a = document.createElement("a");
    a.href = uri;
    a.download = "melody.mid";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleRefine = async () => {
    setRefining(true);
    setRefineError(null);
    try {
      await refineAndDownloadMidi(sessionId);
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : "Refinement failed");
    } finally {
      setRefining(false);
    }
  };

  const handleGenerateHarmony = async () => {
    setHarmonizing(true);
    try {
      await harmonizeSession(sessionId);
      router.push(`/processing?id=${sessionId}`);
    } catch {
      setHarmonizing(false);
      alert("Failed to start harmonization. Please try again.");
    }
  };

  const transcribing  = status === "transcribing";
  const notesReady    = notes.length > 0 && status !== "transcribing" && status !== "failed";
  const alreadyDone   = status === "complete";
  const playbackNotes = combineSustainArtifacts(notes);

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-extrabold text-gray-900">Your Melody</h1>
          <p className="text-sm text-gray-500 mt-1">
            Review your recording, explore the notes, then generate a choral arrangement.
          </p>
        </div>
        <button
          onClick={() => router.push("/")}
          className="text-sm text-gray-400 hover:text-gray-600 transition-colors whitespace-nowrap"
        >
          ← Record again
        </button>
      </div>

      {/* ── Section 1: Recording ─────────────────────────────────────────── */}
      {audioUrl && (
        <section className="bg-white rounded-3xl shadow-sm p-6 space-y-4">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Your Recording
          </h2>
          <AudioPlayer src={audioUrl} label="Original humming" />
          <Waveform audioUrl={audioUrl} height={72} />
        </section>
      )}

      {/* ── Section 2: Transcribed Notes ─────────────────────────────────── */}
      <section className="bg-white rounded-3xl shadow-sm p-6 space-y-5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Transcribed Notes
          </h2>
          {notesReady && (
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="px-2.5 py-1 rounded-full bg-violet-100 text-violet-700 font-semibold">{key}</span>
              <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-semibold">
                {tempo} BPM
              </span>
              {bpmLibrosa != null && (
                <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-800 font-semibold"
                  title="librosa beat_track on the raw audio">
                  {bpmLibrosa} BPM (audio)
                </span>
              )}
              <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-semibold">
                {playbackNotes.length} notes
              </span>
            </div>
          )}
        </div>

        {/* Loading */}
        {transcribing && (
          <div className="flex items-center gap-3 py-8 justify-center text-violet-600">
            <span className="text-2xl animate-spin">⟳</span>
            <span className="font-medium">NeuralNote is transcribing your melody...</span>
          </div>
        )}

        {status === "failed" && (
          <div className="text-center py-8 text-red-500">
            Transcription failed.{" "}
            <button onClick={() => router.push("/")} className="underline">Try again</button>
          </div>
        )}

        {notesReady && (
          <div className="space-y-4">
            {/* Piano roll */}
            <PianoRoll notes={playbackNotes} currentTime={pianoTime} />

            {/* MIDI playback + download row */}
            <div className="flex items-center justify-between flex-wrap gap-3">
              <NotePlayer
                notes={playbackNotes}
                tempo={tempo}
                musicalKey={key}
                onTimeUpdate={setPianoTime}
              />

              <div className="flex items-center gap-2">
                {/* Download raw MIDI */}
                <button
                  onClick={handleDownloadMidi}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl border border-gray-200 bg-white text-gray-700 text-sm font-medium hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm"
                >
                  ⬇ Raw MIDI
                </button>

                {/* AI-refined MIDI */}
                <button
                  onClick={handleRefine}
                  disabled={refining}
                  title="Run local cleanup to improve timing, key, and melody shape"
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-700 text-sm font-medium hover:bg-indigo-100 transition-all shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {refining ? <span className="animate-spin">⟳</span> : "✨"} Filtered MIDI
                </button>
              </div>
            </div>

            <p className="text-xs text-gray-400">
              <span className="font-medium text-gray-500">Filtered MIDI</span> is cleaner for lead playback.
              <span className="mx-1">·</span>
              <span className="font-medium text-gray-500">Raw MIDI</span> keeps the original transcription for maximum accuracy.
            </p>

            {refineError && (
              <p className="text-xs text-red-500">{refineError}</p>
            )}

            {/* Raw note list */}
            <details>
              <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 select-none">
                Show raw note data ({notes.length} notes)
              </summary>
              <div className="mt-2 max-h-36 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50 p-3 font-mono text-xs text-gray-600 grid grid-cols-3 sm:grid-cols-4 gap-1">
                {notes.map((n, i) => (
                  <span key={i} className="px-1.5 py-0.5 rounded bg-white border border-gray-100">
                    {n.note_name}{" "}
                    <span className="text-gray-400">@{n.start_time.toFixed(2)}s</span>
                  </span>
                ))}
              </div>
            </details>
          </div>
        )}
      </section>

      {/* ── Section 3: ElevenLabs voice preview ─────────────────────────── */}
      {notesReady && (
        <section className="bg-white rounded-3xl shadow-sm p-6">
          <MelodyVoicePlayer sessionId={sessionId} />
        </section>
      )}

      {/* ── Section 4: Generate Choral Harmony CTA ───────────────────────── */}
      {notesReady && (
        <section className="bg-gradient-to-br from-violet-600 to-violet-700 rounded-3xl shadow-lg p-8 text-white text-center space-y-4">
          <h2 className="text-2xl font-bold">
            {alreadyDone ? "Arrangement ready!" : "Ready to arrange?"}
          </h2>
          <p className="text-violet-200 text-sm max-w-md mx-auto">
            {alreadyDone
              ? "This melody was already arranged into a 4-part SATB choir. View it or generate a fresh one."
              : "Generate a full 4-part SATB choral arrangement — ready to open in MuseScore or hear as an AI choir."}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {alreadyDone && (
              <button
                onClick={() => router.push(`/result?id=${sessionId}`)}
                className="inline-flex items-center gap-2 px-8 py-4 bg-white text-violet-700 font-bold rounded-2xl shadow hover:shadow-md hover:-translate-y-0.5 transition-all"
              >
                🎼 View Arrangement
              </button>
            )}
            <button
              onClick={handleGenerateHarmony}
              disabled={harmonizing}
              className={`inline-flex items-center gap-2 px-8 py-4 font-bold rounded-2xl shadow hover:shadow-md hover:-translate-y-0.5 transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                alreadyDone
                  ? "bg-violet-500 text-white hover:bg-violet-400"
                  : "bg-white text-violet-700"
              }`}
            >
              {harmonizing ? (
                <><span className="animate-spin">⟳</span> Starting…</>
              ) : alreadyDone ? (
                "Re-generate Harmony"
              ) : (
                "🎼 Generate Choral Harmony"
              )}
            </button>
          </div>
        </section>
      )}

    </div>
  );
}

export default function NotesPage() {
  return (
    <Suspense fallback={
      <div className="text-center text-gray-400 mt-20 animate-pulse">Loading…</div>
    }>
      <NotesContent />
    </Suspense>
  );
}
