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
  notes: NoteEvent[];
  chords: ChordEvent[];
  parts: {
    soprano: NoteEvent[];
    alto: NoteEvent[];
    tenor: NoteEvent[];
    bass: NoteEvent[];
  };
}

/** Upload audio blob. Backend immediately kicks off Basic Pitch transcription. */
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

/** Trigger chord detection + SATB harmonization (session must be notes_ready). */
export async function harmonizeSession(sessionId: string): Promise<void> {
  const res = await fetch(`${BASE}/harmonize/${sessionId}`, { method: "POST" });
  if (!res.ok) throw new Error(`Harmonize failed: ${res.status}`);
}

/** Download the MusicXML arrangement. */
export async function downloadArrangement(sessionId: string): Promise<void> {
  const res = await fetch(`${BASE}/export/${sessionId}`);
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "hum-to-harmony.musicxml";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
