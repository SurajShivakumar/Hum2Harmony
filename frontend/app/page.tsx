"use client";

import { useRef, useState } from "react";
import type { Note } from "@/lib/basicPitch";
import { fileToAudioBuffer, transcribeAudio } from "@/lib/basicPitch";
import { downloadMidi } from "@/lib/midiWriter";
import { loadInstrument, playNotes, stopPlayback } from "@/lib/playback";
import RecordButton from "@/components/RecordButton";
import UploadZone from "@/components/UploadZone";
import ProgressBar from "@/components/ProgressBar";
import NoteVisualizer from "@/components/NoteVisualizer";
import PlaybackControls from "@/components/PlaybackControls";

type Stage = "idle" | "processing" | "done";

export default function Home() {
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  async function handleAudio(file: File) {
    try {
      setError(null);
      setStage("processing");
      setProgress(0);
      const buffer = await fileToAudioBuffer(file);
      const detected = await transcribeAudio(buffer, setProgress);
      setNotes(detected);
      audioContextRef.current = await loadInstrument();
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to transcribe audio");
      setStage("idle");
    }
  }

  function handlePlay() {
    if (audioContextRef.current) playNotes(notes, audioContextRef.current);
  }

  function handleStop() {
    stopPlayback();
  }

  function handleDownload() {
    downloadMidi(notes);
  }

  function handleReset() {
    stopPlayback();
    setStage("idle");
    setNotes([]);
    setProgress(0);
    setError(null);
  }

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center gap-8 p-8">
      <h1 className="text-4xl font-bold">🎵 Basic Pitch Demo</h1>
      <p className="text-zinc-400 text-center">
        Record or upload audio. Get MIDI back entirely in your browser.
      </p>

      {error && (
        <div className="w-full max-w-2xl rounded-lg border border-red-700 bg-red-950 text-red-200 px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {stage === "idle" && (
        <div className="flex flex-col items-center gap-6 w-full max-w-md">
          <UploadZone onFile={handleAudio} />
          <p className="text-zinc-500">or</p>
          <RecordButton onRecorded={handleAudio} />
        </div>
      )}

      {stage === "processing" && (
        <div className="flex flex-col items-center gap-4 w-full max-w-md">
          <p className="text-zinc-300">Running Basic Pitch model...</p>
          <ProgressBar progress={progress} />
        </div>
      )}

      {stage === "done" && (
        <div className="flex flex-col items-center gap-6 w-full max-w-5xl">
          <p className="text-emerald-400">✓ {notes.length} notes detected</p>
          <NoteVisualizer notes={notes} />
          <PlaybackControls
            onPlay={handlePlay}
            onStop={handleStop}
            onDownload={handleDownload}
            onReset={handleReset}
          />
        </div>
      )}
    </main>
  );
}
