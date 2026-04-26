"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSession, harmonizeSessionWithNotes, refineAndDownloadMidi, updateSessionNotes } from "@/lib/api";
import type { NoteEvent, SessionStatus } from "@/lib/api";
import type { MidiExportNote } from "@/lib/midiExportNote";
import { notesToRawMidiUri } from "@/lib/midiWriter";
import { combineSustainArtifacts } from "@/lib/noteCleanup";
import AudioPlayer from "@/components/AudioPlayer";
import PianoRoll from "@/components/PianoRoll";
import NotePlayer from "@/components/NotePlayer";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function midiToName(pitch: number): string {
  const p = Math.max(0, Math.min(127, Math.round(pitch)));
  return `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
}

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
  const [playbackStartAt, setPlaybackStartAt] = useState(0);
  const [playRequest, setPlayRequest] = useState(0);
  const [toggleRequest, setToggleRequest] = useState(0);
  const [harmonizing, setHarmonizing] = useState(false);
  const [refining,    setRefining]    = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [audioUrl,    setAudioUrl]    = useState<string | null>(null);
  const [selectedNoteIndex, setSelectedNoteIndex] = useState<number | null>(null);
  const [selectedNoteIndices, setSelectedNoteIndices] = useState<number[]>([]);
  const [hoveredRollPosition, setHoveredRollPosition] = useState<{ time: number; pitch: number } | null>(null);
  const [notesDirty, setNotesDirty] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [noteEditError, setNoteEditError] = useState<string | null>(null);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const undoStackRef = useRef<NoteEvent[][]>([]);

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
        if (data.status === "failed") {
          setTranscriptionError(data.error?.trim() || null);
        }
        if (data.notes?.length) {
          setNotes(combineSustainArtifacts(data.notes));
          setKey(data.key);
          setTempo(data.tempo);
          setBpmLibrosa(data.bpm_librosa ?? null);
          setNotesDirty(false);
        }
        // Stop polling once transcription is done (keep the user on this page)
        if (data.status !== "transcribing") clearInterval(interval);
      } catch { /* network hiccup */ }
    }, 1500);

    return () => clearInterval(interval);
  }, [sessionId, router]);

  useEffect(() => {
    if (selectedNoteIndex != null && selectedNoteIndex >= notes.length) {
      setSelectedNoteIndex(null);
    }
    setSelectedNoteIndices((prev) => prev.filter((index) => index < notes.length));
  }, [notes.length, selectedNoteIndex]);

  const selectSingleNote = (index: number) => {
    setSelectedNoteIndex(index);
    setSelectedNoteIndices([index]);
  };

  const selectMultipleNotes = (indices: number[]) => {
    const unique = Array.from(new Set(indices)).sort((a, b) => a - b);
    setSelectedNoteIndices(unique);
    setSelectedNoteIndex(unique[0] ?? null);
  };

  const updateNoteAt = useCallback((index: number, patch: Partial<NoteEvent>) => {
    setNotes((prev) => {
      undoStackRef.current.push(prev.map((note) => ({ ...note })));
      const next = prev.map((note, i) => {
        if (i !== index) return note;
        const pitch = Math.max(0, Math.min(127, Math.round(patch.pitch ?? note.pitch)));
        const duration = Math.max(0.03, Number((patch.duration ?? note.duration).toFixed(4)));
        const startTime = Math.max(0, Number((patch.start_time ?? note.start_time).toFixed(4)));
        return {
          ...note,
          ...patch,
          pitch,
          note_name: midiToName(pitch),
          start_time: startTime,
          duration,
        };
      });
      return next;
    });
    setNotesDirty(true);
    setNoteEditError(null);
  }, []);

  const updateNoteAtLatest = useCallback((
    index: number,
    getPatch: (note: NoteEvent) => Partial<NoteEvent>
  ) => {
    setNotes((prev) => {
      undoStackRef.current.push(prev.map((note) => ({ ...note })));
      const next = prev.map((note, i) => {
        if (i !== index) return note;
        const patch = getPatch(note);
        const pitch = Math.max(0, Math.min(127, Math.round(patch.pitch ?? note.pitch)));
        const duration = Math.max(0.03, Number((patch.duration ?? note.duration).toFixed(4)));
        const startTime = Math.max(0, Number((patch.start_time ?? note.start_time).toFixed(4)));
        return {
          ...note,
          ...patch,
          pitch,
          note_name: midiToName(pitch),
          start_time: startTime,
          duration,
        };
      });
      return next;
    });
    setNotesDirty(true);
    setNoteEditError(null);
  }, []);

  const deleteSelectedNote = useCallback(() => {
    const selected = new Set(selectedNoteIndices.length ? selectedNoteIndices : selectedNoteIndex == null ? [] : [selectedNoteIndex]);
    if (!selected.size) return;
    setNotes((prev) => {
      undoStackRef.current.push(prev.map((note) => ({ ...note })));
      return prev.filter((_, i) => !selected.has(i));
    });
    setSelectedNoteIndex(null);
    setSelectedNoteIndices([]);
    setNotesDirty(true);
    setNoteEditError(null);
  }, [selectedNoteIndex, selectedNoteIndices]);

  const addNoteAtHover = useCallback(() => {
    if (!hoveredRollPosition) return;
    const start = Math.max(0, Number((Math.round(hoveredRollPosition.time / 0.05) * 0.05).toFixed(4)));
    const pitch = Math.max(0, Math.min(127, hoveredRollPosition.pitch));
    setNotes((prev) => {
      undoStackRef.current.push(prev.map((note) => ({ ...note })));
      const newNote: NoteEvent = {
        note_name: midiToName(pitch),
        pitch,
        start_time: start,
        duration: 0.5,
      };
      const next = [...prev, newNote].sort((a, b) => a.start_time - b.start_time);
      const insertedIndex = next.findIndex((note) => note === newNote);
      setSelectedNoteIndex(insertedIndex);
      setSelectedNoteIndices([insertedIndex]);
      return next;
    });
    setNotesDirty(true);
    setNoteEditError(null);
  }, [hoveredRollPosition]);

  const splitNoteAt = useCallback((index: number, splitTime: number) => {
    setNotes((prev) => {
      const target = prev[index];
      if (!target) return prev;
      const noteStart = target.start_time;
      const noteEnd = target.start_time + target.duration;
      const clampedSplit = Math.max(noteStart + 0.03, Math.min(noteEnd - 0.03, splitTime));
      if (clampedSplit <= noteStart || clampedSplit >= noteEnd) return prev;

      undoStackRef.current.push(prev.map((note) => ({ ...note })));
      const first: NoteEvent = {
        ...target,
        duration: Number((clampedSplit - noteStart).toFixed(4)),
      };
      const second: NoteEvent = {
        ...target,
        start_time: Number(clampedSplit.toFixed(4)),
        duration: Number((noteEnd - clampedSplit).toFixed(4)),
      };
      const next = [
        ...prev.slice(0, index),
        first,
        second,
        ...prev.slice(index + 1),
      ];
      setSelectedNoteIndex(index + 1);
      setSelectedNoteIndices([index + 1]);
      return next;
    });
    setNotesDirty(true);
    setNoteEditError(null);
  }, []);

  const undoLastEdit = useCallback(() => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    setNotes(previous);
    setSelectedNoteIndex(null);
    setSelectedNoteIndices([]);
    setNotesDirty(true);
    setNoteEditError(null);
  }, []);

  const persistNotes = useCallback((notesToSave: NoteEvent[], showNotFound = false) => {
    if (!sessionId) return Promise.resolve();

    const run = async () => {
      setSavingNotes(true);
      setNoteEditError(null);
      try {
        const saved = await updateSessionNotes(sessionId, notesToSave);
        setNotes(saved.notes);
        setKey(saved.key);
        setTempo(saved.tempo);
        setStatus(saved.status);
        setNotesDirty(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to save notes";
        if (showNotFound || !message.toLowerCase().includes("not found")) {
          setNoteEditError(message);
        }
        throw err;
      } finally {
        setSavingNotes(false);
      }
    };

    const next = saveChainRef.current.catch(() => undefined).then(run);
    saveChainRef.current = next.catch(() => undefined);
    return next;
  }, [sessionId]);

  const saveEditedNotes = useCallback(async () => {
    if (!notesDirty) return;
    await persistNotes(notes);
  }, [notesDirty, notes, persistNotes]);

  const saveCurrentPianoRollNotes = useCallback(async () => {
    if (!sessionId) throw new Error("Missing session id");
    setSavingNotes(true);
    setNoteEditError(null);
    try {
      const saved = await updateSessionNotes(sessionId, notes);
      setNotes(saved.notes);
      setKey(saved.key);
      setTempo(saved.tempo);
      setStatus(saved.status);
      setNotesDirty(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save notes";
      setNoteEditError(message);
      throw err;
    } finally {
      setSavingNotes(false);
    }
  }, [notes, sessionId]);

  useEffect(() => {
    if (!notesDirty || harmonizing) return;
    const timeout = window.setTimeout(() => {
      void saveEditedNotes().catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [notesDirty, harmonizing, saveEditedNotes]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.code === "Space") {
        event.preventDefault();
        setToggleRequest((value) => value + 1);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoLastEdit();
        return;
      }
      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        addNoteAtHover();
        return;
      }
      const activeSelection = selectedNoteIndices.length
        ? selectedNoteIndices
        : selectedNoteIndex == null
          ? []
          : [selectedNoteIndex];
      if (!activeSelection.length) return;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        for (const index of activeSelection) {
          updateNoteAtLatest(index, (selected) => ({
            pitch: selected.pitch + (event.key === "ArrowUp" ? 1 : -1),
          }));
        }
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = 0.05;
        for (const index of activeSelection) {
          if (event.key === "ArrowLeft") {
            updateNoteAtLatest(index, (selected) => {
              const extendBy = Math.min(step, selected.start_time);
              return {
                start_time: selected.start_time - extendBy,
                duration: selected.duration + extendBy,
              };
            });
          } else {
            updateNoteAtLatest(index, (selected) => ({
              duration: selected.duration + step,
            }));
          }
        }
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelectedNote();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addNoteAtHover, deleteSelectedNote, selectedNoteIndex, selectedNoteIndices, undoLastEdit, updateNoteAtLatest]);

  const seekAndPlayFrom = (time: number) => {
    setPianoTime(time);
    setPlaybackStartAt(time);
    setPlayRequest((value) => value + 1);
  };

  const handleDownloadMidi = () => {
    const basicNotes: MidiExportNote[] = notes.map(n => ({
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
      await persistNotes(notes, true);
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
      await harmonizeSessionWithNotes(sessionId, notes);
      setNotesDirty(false);
      setNoteEditError(null);
      router.push(`/processing?id=${sessionId}`);
    } catch (err) {
      setHarmonizing(false);
      const message = err instanceof Error ? err.message : "Failed to start harmonization";
      alert(message);
    }
  };

  const transcribing  = status === "transcribing";
  const notesReady    = notes.length > 0 && status !== "transcribing" && status !== "failed";
  const alreadyDone   = status === "complete";
  const playbackNotes = notes;
  const selectedNote = selectedNoteIndex == null ? null : playbackNotes[selectedNoteIndex] ?? null;

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
          <AudioPlayer
            src={audioUrl}
            label="Original humming"
            onUnsupported={() => {
              sessionStorage.removeItem("recordingUrl");
              setAudioUrl(null);
            }}
          />
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
          <div className="text-center py-8 text-red-600 max-w-2xl mx-auto space-y-2">
            <p>
              Transcription failed.{" "}
              <button onClick={() => router.push("/")} className="underline">Try again</button>
            </p>
            {transcriptionError && (
              <p className="text-xs text-left font-mono text-red-700 bg-red-50 p-3 rounded-lg break-words">
                {transcriptionError}
              </p>
            )}
            <p className="text-xs text-gray-500">
              Check that the API server is the same version as this app, running from the
              <code className="mx-1">backend</code> folder, and that{" "}
              <code className="mx-1">NEXT_PUBLIC_BACKEND_URL</code> in{" "}
              <code className="mx-1">frontend/.env.local</code> matches the port (e.g.{" "}
              <code className="mx-1">http://localhost:8002</code>).
            </p>
          </div>
        )}

        {notesReady && (
          <div className="space-y-4">
            {/* Piano roll */}
            <PianoRoll
              notes={playbackNotes}
              currentTime={pianoTime}
              selectedIndex={selectedNoteIndex}
              selectedIndices={selectedNoteIndices}
              onSelectNote={selectSingleNote}
              onSelectNotes={selectMultipleNotes}
              onChangeNote={updateNoteAt}
              onSplitNote={splitNoteAt}
              onSeek={seekAndPlayFrom}
              onHoverPosition={setHoveredRollPosition}
            />

            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-700">Edit notes directly</h3>
                  <p className="text-xs text-gray-400">
                    Drag the middle of a note to move it in time or pitch. Drag the left or right edge to trim or extend.
                    Drag across notes to select multiple. Arrow keys and Delete apply to the selection.
                    Hover the grid and press T to add a note. Ctrl+Z undoes the last edit.
                    Double-click a note to split it.
                  </p>
                </div>
                <span className="text-xs font-semibold text-gray-400">
                  {savingNotes ? "Saving..." : notesDirty ? "Autosaving..." : "Saved"}
                </span>
              </div>

              {selectedNote ? (
                <div className="flex flex-wrap gap-2 text-xs text-gray-500">
                  {selectedNoteIndices.length > 1 && (
                    <span className="px-2.5 py-1 rounded-full bg-violet-100 text-violet-700 font-semibold">
                      {selectedNoteIndices.length} selected
                    </span>
                  )}
                  <span className="px-2.5 py-1 rounded-full bg-white border border-gray-100 font-mono">
                    {selectedNote.note_name}
                  </span>
                  <span className="px-2.5 py-1 rounded-full bg-white border border-gray-100">
                    start {selectedNote.start_time.toFixed(2)}s
                  </span>
                  <span className="px-2.5 py-1 rounded-full bg-white border border-gray-100">
                    duration {selectedNote.duration.toFixed(2)}s
                  </span>
                </div>
              ) : (
                <p className="text-sm text-gray-400">No note selected.</p>
              )}

              {noteEditError && (
                <p className="text-xs text-red-500">{noteEditError}</p>
              )}
            </div>

            {/* MIDI playback + download row */}
            <div className="flex items-center justify-between flex-wrap gap-3">
              <NotePlayer
                notes={playbackNotes}
                tempo={tempo}
                musicalKey={key}
                onTimeUpdate={setPianoTime}
                seekTime={playbackStartAt}
                playRequest={playRequest}
                toggleRequest={toggleRequest}
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

      {/* ── Section 3: Generate Choral Harmony CTA ───────────────────────── */}
      {notesReady && (
        <section className="bg-gradient-to-br from-violet-600 to-violet-700 rounded-3xl shadow-lg p-8 text-white text-center space-y-4">
          <h2 className="text-2xl font-bold">
            {alreadyDone ? "Arrangement ready!" : "Ready to arrange?"}
          </h2>
          <p className="text-violet-200 text-sm max-w-md mx-auto">
            {alreadyDone
              ? "This melody was already arranged into a 4-part SATB choir. View it or generate a fresh one."
              : "Generate a full 4-part SATB choral arrangement, ready to open in MuseScore or a DAW."}
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
