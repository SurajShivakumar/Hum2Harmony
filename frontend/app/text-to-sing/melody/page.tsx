"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  getSession,
  updateSessionMelody,
  sourceAudioUrl,
  harmonizeSession,
} from "@/lib/api";
import type { NoteEvent, SessionStatus } from "@/lib/api";
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [harmBusy, setHarmBusy] = useState(false);
  const [sourceAudioReady, setSourceAudioReady] = useState(false);
  const [audioError, setAudioError] = useState(false);

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
        if (data.notes?.length) setNotes(refreshNotes(data.notes));
        setKeyStr(data.key);
        setTempo(data.tempo);
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
        }
        setKeyStr(data.key);
        setTempo(data.tempo);
        if (data.status !== "transcribing") clearInterval(t);
      } catch {
        /* keep polling */
      }
    }, 1200);

    return () => clearInterval(t);
  }, [sessionId, router, refreshNotes]);

  const updatePitch = (index: number, pitch: number) => {
    const p = Math.max(36, Math.min(96, Math.round(pitch)));
    setNotes((prev) => {
      const next = [...prev];
      if (!next[index]) return prev;
      next[index] = { ...next[index], pitch: p, note_name: midiToName(p) };
      return next;
    });
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
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const goHarmony = async () => {
    setHarmBusy(true);
    setSaveError(null);
    try {
      await updateSessionMelody(sessionId, notes);
      await harmonizeSession(sessionId);
      router.push(`/processing?id=${sessionId}`);
    } catch (e) {
      setHarmBusy(false);
      setSaveError(e instanceof Error ? e.message : "Harmonize failed");
    }
  };

  const working = status === "transcribing";
  const failed = status === "failed";

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

          <PianoRoll notes={notes} currentTime={pianoTime} />

          <div className="flex flex-wrap items-center gap-3">
            <NotePlayer
              notes={notes}
              tempo={tempo}
              musicalKey={keyStr}
              onTimeUpdate={setPianoTime}
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
              disabled={saving}
              className="px-4 py-2 rounded-xl bg-violet-600 text-white text-sm font-semibold shadow hover:bg-violet-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save melody"}
            </button>
            <button
              type="button"
              onClick={goHarmony}
              disabled={harmBusy}
              className="px-4 py-2 rounded-xl border border-violet-300 bg-violet-50 text-violet-800 text-sm font-semibold hover:bg-violet-100 disabled:opacity-50"
            >
              {harmBusy ? "…" : "🎼 Choral harmony"}
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
            Tip: after editing, click <strong>Save melody</strong> before sending to choral
            harmony or opening the main notes page, so the server has your changes.
          </p>
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
