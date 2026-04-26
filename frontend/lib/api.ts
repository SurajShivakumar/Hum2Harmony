const BASE = process.env.NEXT_PUBLIC_BACKEND_URL;

export interface NoteEvent {
  note_name: string;
  pitch: number;
  start_time: number;
  duration: number;
}

export interface ChordEvent {
  start_time: number;
  end_time: number;
  chord_name: string;
  root_pc?: number;
  pitch_classes?: number[];
  roman?: string;
}

export type SessionStatus =
  | "transcribing"
  | "notes_ready"
  | "harmonizing"
  | "complete"
  | "failed";

export interface SessionData {
  session_id: string;
  status: SessionStatus;
  key: string;
  tempo: number;
  /** Global BPM from librosa on the raw audio (can differ from `tempo`). */
  bpm_librosa: number | null;
  /** Present when `status` is `failed` — server-side reason (debugging). */
  error?: string | null;
  notes: NoteEvent[];
  chords: ChordEvent[];
  parts: {
    soprano: NoteEvent[];
    alto: NoteEvent[];
    tenor: NoteEvent[];
    bass: NoteEvent[];
    piano_rh?: NoteEvent[];
    piano_lh?: NoteEvent[];
  };
}

/** Upload audio blob. Backend immediately kicks off audio-to-MIDI transcription. */
export async function uploadAudio(blob: Blob): Promise<{ session_id: string; status: string }> {
  const form = new FormData();
  const ext = blob.type.includes("webm") ? ".webm"
    : blob.type.includes("ogg") ? ".ogg"
    : blob.type.includes("mp4") ? ".mp4"
    : ".wav";
  form.append("audio", blob, `recording${ext}`);
  const res = await fetch(`${BASE}/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

/** Poll session status and results. */
export async function getSession(sessionId: string): Promise<SessionData> {
  const res = await fetch(`${BASE}/session/${sessionId}`);
  if (!res.ok) throw new Error(`Session fetch failed: ${res.status}`);
  return res.json();
}

/** Persist user-edited melody notes and clear any stale arrangement. */
export async function updateSessionNotes(
  sessionId: string,
  notes: NoteEvent[]
): Promise<Pick<SessionData, "session_id" | "status" | "key" | "tempo" | "notes">> {
  const res = await fetch(`${BASE}/session/${sessionId}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(notes),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { detail?: string }).detail ?? `Save notes failed: ${res.status}`);
  }
  return res.json();
}

/** Trigger chord detection + SATB harmonization (session must be notes_ready). */
export async function harmonizeSession(sessionId: string): Promise<void> {
  const res = await fetch(`${BASE}/harmonize/${sessionId}`, { method: "POST" });
  if (!res.ok) throw new Error(`Harmonize failed: ${res.status}`);
}

/** Save the current piano-roll notes and start harmonization in one request. */
export async function harmonizeSessionWithNotes(
  sessionId: string,
  notes: NoteEvent[]
): Promise<void> {
  const res = await fetch(`${BASE}/harmonize/${sessionId}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(notes),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { detail?: string }).detail ?? `Harmonize failed: ${res.status}`);
  }
}

// ── MIDI refinement ──────────────────────────────────────────────────────────

/**
 * Send the session's notes to the backend local refinement pipeline, then
 * trigger a browser download of the cleaned MIDI file.
 */
export async function refineAndDownloadMidi(sessionId: string): Promise<void> {
  const res = await fetch(`${BASE}/refine/${sessionId}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { detail?: string }).detail ?? `Refine failed: ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "refined.mid";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Download the arranged MIDI (Lead + Piano + SATB). */
export async function downloadArrangementMidi(
  sessionId: string,
  filename = "hum-to-harmony-arrangement.mid"
): Promise<void> {
  const res = await fetch(`${BASE}/export-midi/${sessionId}`);
  if (!res.ok) throw new Error(`MIDI export failed: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const clean = filename.trim();
  a.download = clean.toLowerCase().endsWith(".mid") ? clean : `${clean || "arrangement"}.mid`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
