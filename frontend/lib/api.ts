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

// ── Melody voice (ElevenLabs single-voice preview) ───────────────────────────

export type MelodyVoiceStatus = "idle" | "generating" | "ready" | "failed";

export interface MelodyVoiceStatusResponse {
  status: MelodyVoiceStatus;
  error?: string;
}

export async function startMelodyVoice(sessionId: string): Promise<MelodyVoiceStatusResponse> {
  const res = await fetch(`${BASE}/melody-voice/${sessionId}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { detail?: string }).detail ?? `Failed: ${res.status}`);
  }
  return res.json();
}

export async function getMelodyVoiceStatus(sessionId: string): Promise<MelodyVoiceStatusResponse> {
  const res = await fetch(`${BASE}/melody-voice/${sessionId}`);
  if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
  return res.json();
}

export function melodyVoiceAudioUrl(sessionId: string): string {
  return `${BASE}/melody-voice/audio/${sessionId}`;
}

// ── Choir (ElevenLabs) ───────────────────────────────────────────────────────

export type ChoirStatus = "idle" | "generating" | "ready" | "failed";

export interface ChoirStatusResponse {
  status: ChoirStatus;
  parts: string[];
  error?: string;
}

/** Kick off ElevenLabs choir synthesis for a completed arrangement. */
export async function startChoir(sessionId: string): Promise<ChoirStatusResponse> {
  const res = await fetch(`${BASE}/choir/${sessionId}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { detail?: string }).detail ?? `Choir start failed: ${res.status}`);
  }
  return res.json();
}

/** Poll choir synthesis status. */
export async function getChoirStatus(sessionId: string): Promise<ChoirStatusResponse> {
  const res = await fetch(`${BASE}/choir/${sessionId}`);
  if (!res.ok) throw new Error(`Choir status failed: ${res.status}`);
  return res.json();
}

/** Return the URL to stream a choir part WAV directly (for <audio> src). */
export function choirAudioUrl(sessionId: string, part: string): string {
  return `${BASE}/choir/audio/${sessionId}/${part}`;
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
