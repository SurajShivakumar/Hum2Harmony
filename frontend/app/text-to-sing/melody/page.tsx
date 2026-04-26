"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  getTextSingGenerations,
  getSession,
  harmonizeSessionWithNotes,
  regenerateTextSing,
  updateSessionMelody,
  sourceAudioUrl,
  textSingGenerationAudioUrl,
} from "@/lib/api";
import type { MusicGeneration, NoteEvent, SessionStatus } from "@/lib/api";
import type { MidiExportNote } from "@/lib/midiExportNote";
import { notesToRawMidiUri } from "@/lib/midiWriter";
import PianoRoll from "@/components/PianoRoll";
import NotePlayer from "@/components/NotePlayer";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToName(midi: number): string {
  const p = Math.max(0, Math.min(127, Math.round(midi)));
  return `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
}

function toExportNotes(notes: NoteEvent[]): MidiExportNote[] {
  return notes.map((n) => ({
    pitchMidi: Math.round(n.pitch),
    startTimeSeconds: n.start_time,
    durationSeconds: Math.max(0.02, n.duration),
    amplitude: 0.75,
  }));
}

function MelodyEditorContent() {
  const router = useRouter();
  const params = useSearchParams();
  const sessionId = params.get("id") ?? "";

  const [status, setStatus] = useState<SessionStatus>("transcribing");
  const [notes, setNotes] = useState<NoteEvent[]>([]);
  const [keyStr, setKeyStr] = useState("");
  const [tempo, setTempo] = useState(120);
  const [pianoTime, setPianoTime] = useState(-1);
  const [playbackStartAt, setPlaybackStartAt] = useState(0);
  const [playRequest, setPlayRequest] = useState(0);
  const [toggleRequest, setToggleRequest] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [sourceAudioReady, setSourceAudioReady] = useState(false);
  const [audioError, setAudioError] = useState(false);
  const [editPrompt, setEditPrompt] = useState("");
  const [generations, setGenerations] = useState<MusicGeneration[]>([]);
  const [regenerating, setRegenerating] = useState(false);
  const [pollKey, setPollKey] = useState(0);
  const [selectedNoteIndex, setSelectedNoteIndex] = useState<number | null>(null);
  const [selectedNoteIndices, setSelectedNoteIndices] = useState<number[]>([]);
  const [hoveredRollPosition, setHoveredRollPosition] = useState<{ time: number; pitch: number } | null>(null);
  const [notesDirty, setNotesDirty] = useState(false);
  const undoStackRef = useRef<NoteEvent[][]>([]);

  const backendOk = Boolean(process.env.NEXT_PUBLIC_BACKEND_URL);

  const refreshNotes = useCallback(
    (list: NoteEvent[]) =>
      list.map((n) => ({
        ...n,
        pitch: Math.round(n.pitch),
        note_name: midiToName(n.pitch),
      })),
    []
  );

  const refreshGenerations = useCallback(async () => {
    if (!sessionId) return;
    try {
      setGenerations(await getTextSingGenerations(sessionId));
    } catch {
      /* history can lag behind the first generation */
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      router.replace("/text-to-sing");
      return;
    }

    void (async () => {
      try {
        const data = await getSession(sessionId);
        setStatus(data.status);
        setSourceAudioReady(data.source_audio_ready === true);
        if (data.notes?.length) {
          setNotes(refreshNotes(data.notes));
          setNotesDirty(false);
        }
        setKeyStr(data.key);
        setTempo(data.tempo);
        void refreshGenerations();
      } catch {
        /* ignore */
      }
    })();

    const t = setInterval(async () => {
      try {
        const data = await getSession(sessionId);
        setStatus(data.status);
        setSourceAudioReady(data.source_audio_ready === true);
        if (data.notes?.length) {
          setNotes(refreshNotes(data.notes));
          setNotesDirty(false);
        }
        setKeyStr(data.key);
        setTempo(data.tempo);
        void refreshGenerations();
        if (data.status !== "transcribing") clearInterval(t);
      } catch {
        /* keep polling */
      }
    }, 1200);

    return () => clearInterval(t);
  }, [sessionId, router, refreshNotes, refreshGenerations, pollKey]);

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
      return prev.map((note, i) => {
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
    });
    setNotesDirty(true);
    setSaveError(null);
  }, []);

  const updateNoteAtLatest = useCallback((
    index: number,
    getPatch: (note: NoteEvent) => Partial<NoteEvent>
  ) => {
    setNotes((prev) => {
      undoStackRef.current.push(prev.map((note) => ({ ...note })));
      return prev.map((note, i) => {
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
    });
    setNotesDirty(true);
    setSaveError(null);
  }, []);

  const updatePitch = (index: number, pitch: number) => {
    const p = Math.max(36, Math.min(96, Math.round(pitch)));
    updateNoteAt(index, { pitch: p });
  };

  const deleteSelectedNote = useCallback(() => {
    const selected = new Set(
      selectedNoteIndices.length
        ? selectedNoteIndices
        : selectedNoteIndex == null
          ? []
          : [selectedNoteIndex]
    );
    if (!selected.size) return;
    setNotes((prev) => {
      undoStackRef.current.push(prev.map((note) => ({ ...note })));
      return prev.filter((_, i) => !selected.has(i));
    });
    setSelectedNoteIndex(null);
    setSelectedNoteIndices([]);
    setNotesDirty(true);
    setSaveError(null);
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
    setSaveError(null);
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
      setSelectedNoteIndex(index + 1);
      setSelectedNoteIndices([index + 1]);
      return [
        ...prev.slice(0, index),
        first,
        second,
        ...prev.slice(index + 1),
      ];
    });
    setNotesDirty(true);
    setSaveError(null);
  }, []);

  const undoLastEdit = useCallback(() => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    setNotes(previous);
    setSelectedNoteIndex(null);
    setSelectedNoteIndices([]);
    setNotesDirty(true);
    setSaveError(null);
  }, []);

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

  const downloadMidi = () => {
    const uri = notesToRawMidiUri(toExportNotes(notes), tempo);
    const a = document.createElement("a");
    a.href = uri;
    a.download = "text-to-sing.mid";
    a.click();
  };

  const saveMelody = async () => {
    setSaveError(null);
    setSaving(true);
    try {
      await updateSessionMelody(sessionId, notes);
      setNotesDirty(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const arrangeFromMelody = async () => {
    if (!notes.length) {
      setSaveError("Generate or edit a melody first.");
      return;
    }
    setSaveError(null);
    setArranging(true);
    try {
      await harmonizeSessionWithNotes(sessionId, notes);
      setNotesDirty(false);
      router.push(`/processing?id=${sessionId}`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Arrangement failed");
      setArranging(false);
    }
  };

  const regenerateSong = async () => {
    const prompt = editPrompt.trim();
    if (!prompt) {
      setSaveError("Describe what you want changed first.");
      return;
    }
    setRegenerating(true);
    setSaveError(null);
    try {
      await regenerateTextSing(sessionId, prompt);
      setEditPrompt("");
      setNotes([]);
      setSelectedNoteIndex(null);
      setSelectedNoteIndices([]);
      setNotesDirty(false);
      setSourceAudioReady(false);
      setStatus("transcribing");
      setPollKey((n) => n + 1);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Regenerate failed");
    } finally {
      setRegenerating(false);
    }
  };

  const working = status === "transcribing";
  const failed = status === "failed";
  const selectedNote = selectedNoteIndex == null ? null : notes[selectedNoteIndex] ?? null;

  return (
    <main className="min-h-screen bg-gradient-to-b from-white to-violet-50 p-6 md:p-10 max-w-3xl mx-auto space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">Melody editor</h1>
          <p className="text-sm text-gray-500 mt-1">
            Edit MIDI pitch per note. Save so the same data is used in the main app.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 text-sm">
          <Link href="/text-to-sing" className="text-violet-600 hover:underline">
            New line
          </Link>
          <Link href={`/notes?id=${sessionId}`} className="text-gray-500 hover:text-gray-700">
            Open in full editor →
          </Link>
        </div>
      </div>

      {working && (
        <div className="flex items-center gap-3 text-violet-600 bg-violet-50 rounded-2xl px-4 py-3">
          <span className="text-2xl animate-spin">⟳</span>
          <span>Generating ElevenLabs Music and transcribing notes…</span>
        </div>
      )}

      {!backendOk && (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <strong>Backend URL missing.</strong> Add{" "}
          <code className="text-xs bg-amber-100 px-1 rounded">NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000</code>{" "}
          to <code className="text-xs">frontend/.env.local</code> and restart the dev server, or the voice
          will not play.
        </p>
      )}

      {failed && (
        <p className="text-red-600 text-sm">
          Transcription to notes failed. You can still play the generated voice below if it is
          available.{" "}
          <Link href="/text-to-sing" className="underline">
            Try a new line
          </Link>
        </p>
      )}

      {sourceAudioReady && backendOk && (
        <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Generated song
          </h2>
          <p className="text-xs text-gray-500 mb-2">
            This is the ElevenLabs Music output. The piano roll below is extracted from it so
            you can edit pitch and export MIDI.
          </p>
          {audioError && (
            <p className="text-xs text-red-600 mb-2">Could not load this audio (check API key and backend).</p>
          )}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio
            key={`${sessionId}-src`}
            controls
            src={sourceAudioUrl(sessionId)}
            className="w-full h-9"
            onError={() => setAudioError(true)}
            onLoadedData={() => setAudioError(false)}
          />
        </section>
      )}

      {backendOk && (
        <section className="rounded-2xl border border-fuchsia-200 bg-white p-4 shadow-sm space-y-3">
          <div>
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Edit / regenerate song
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              Ask for changes to the next generation: <span className="font-mono">(make the background music sadder, remove drums, acoustic guitar, slower)</span>.
              Previous generations stay below.
            </p>
          </div>
          <textarea
            value={editPrompt}
            onChange={(e) => setEditPrompt(e.target.value)}
            disabled={regenerating || working}
            rows={3}
            placeholder="e.g. (make it sadder, less drums, more piano, darker background music)"
            className="w-full rounded-2xl border border-fuchsia-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-fuchsia-100 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={regenerateSong}
            disabled={regenerating || working || !editPrompt.trim()}
            className="px-4 py-2 rounded-xl bg-fuchsia-600 text-white text-sm font-semibold shadow hover:bg-fuchsia-700 disabled:opacity-50"
          >
            {regenerating || working ? "Generating new version…" : "Generate edited version"}
          </button>
        </section>
      )}

      {generations.length > 0 && (
        <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm space-y-3">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Past generations
          </h2>
          <div className="space-y-3">
            {generations.map((g, i) => (
              <div
                key={g.id}
                className="rounded-xl border border-gray-100 bg-gray-50 p-3 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-gray-700">
                    Version {generations.length - i}
                    {g.is_current ? " · current" : ""}
                  </p>
                  <span className="text-[11px] text-gray-400">
                    {new Date(g.created_at).toLocaleString()}
                  </span>
                </div>
                {g.edit_prompt && (
                  <p className="text-xs text-fuchsia-700">
                    Edit: {g.edit_prompt}
                  </p>
                )}
                {g.style_prompt && (
                  <p className="text-xs text-gray-500">
                    Direction: {g.style_prompt}
                  </p>
                )}
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio
                  controls
                  src={textSingGenerationAudioUrl(g.id)}
                  className="w-full h-8"
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {working && !sourceAudioReady && (
        <p className="text-xs text-gray-500">Waiting for the first voice file from the server…</p>
      )}

      {!working && !failed && notes.length > 0 && (
        <>
          <div className="flex flex-wrap gap-2 text-xs">
            {keyStr && (
              <span className="px-2.5 py-1 rounded-full bg-violet-100 text-violet-800 font-semibold">
                {keyStr}
              </span>
            )}
            <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-semibold">
              {tempo} BPM
            </span>
            <span className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700 font-semibold">
              {notes.length} notes
            </span>
          </div>

          <PianoRoll
            notes={notes}
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
                  Hover the grid and press T to add a note. Ctrl/Cmd+Z undoes the last edit.
                  Double-click a note to split it.
                </p>
              </div>
              <span className="text-xs font-semibold text-gray-400">
                {saving ? "Saving..." : notesDirty ? "Unsaved" : "Saved"}
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
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <NotePlayer
              notes={notes}
              tempo={tempo}
              musicalKey={keyStr}
              onTimeUpdate={setPianoTime}
              seekTime={playbackStartAt}
              playRequest={playRequest}
              toggleRequest={toggleRequest}
            />
            <button
              type="button"
              onClick={downloadMidi}
              className="px-4 py-2 rounded-xl border border-gray-200 bg-white text-sm font-medium shadow-sm hover:bg-gray-50"
            >
              ⬇ Download MIDI
            </button>
            <button
              type="button"
              onClick={saveMelody}
              disabled={saving || !notesDirty}
              className="px-4 py-2 rounded-xl bg-violet-600 text-white text-sm font-semibold shadow hover:bg-violet-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : notesDirty ? "Save melody" : "Saved"}
            </button>
          </div>

          {saveError && <p className="text-sm text-red-500">{saveError}</p>}

          <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 py-2 border-b border-gray-100 bg-gray-50 text-xs font-semibold text-gray-500 uppercase">
              Pitch (MIDI) — change a value to move the note up or down
            </div>
            <div className="max-h-64 overflow-y-auto divide-y divide-gray-100">
              {notes.map((n, i) => (
                <div
                  key={`${n.start_time}-${i}`}
                  className="flex items-center gap-3 px-4 py-2 text-sm"
                >
                  <span className="text-gray-400 w-8 text-right font-mono">{i + 1}</span>
                  <span className="text-gray-500 w-20">{n.start_time.toFixed(2)}s</span>
                  <input
                    type="number"
                    min={36}
                    max={96}
                    value={n.pitch}
                    onChange={(e) => updatePitch(i, Number(e.target.value))}
                    className="w-20 rounded-lg border border-gray-200 px-2 py-1 font-mono"
                    aria-label={`MIDI pitch note ${i + 1}`}
                  />
                  <span className="text-violet-700 font-medium">{n.note_name}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="text-xs text-gray-500">
            Tip: after editing, click <strong>Save melody</strong> before opening the main
            notes page, so the server has your changes.
          </p>

          <section className="rounded-3xl bg-gradient-to-br from-violet-600 to-violet-700 p-6 text-white text-center space-y-3">
            <h2 className="text-xl font-bold">Ready for chords and arrangement?</h2>
            <p className="text-sm text-violet-200 max-w-md mx-auto">
              This saves your edited piano roll, generates the chord progression and full
              arrangement, then takes you to the normal arrangement/MIDI result flow.
            </p>
            <button
              type="button"
              onClick={arrangeFromMelody}
              disabled={arranging || working || notes.length === 0}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl bg-white text-violet-700 text-sm font-bold shadow hover:shadow-md hover:-translate-y-0.5 transition disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {arranging ? (
                <>
                  <span className="animate-spin">⟳</span> Arranging…
                </>
              ) : (
                "🎼 Arrange chords + MIDI"
              )}
            </button>
          </section>
        </>
      )}

      {!working && !failed && notes.length === 0 && (
        <p className="text-sm text-amber-800 bg-amber-50 rounded-xl px-4 py-3">
          No notes were detected from this line. Try different wording or a slightly longer
          phrase, then run again from{" "}
          <Link href="/text-to-sing" className="underline">
            Text to singing
          </Link>
          .
        </p>
      )}
    </main>
  );
}

export default function TextToSingMelodyPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center text-gray-400">
          Loading…
        </div>
      }
    >
      <MelodyEditorContent />
    </Suspense>
  );
}
