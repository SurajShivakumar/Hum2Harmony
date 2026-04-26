"""
Hum to Harmony — real FastAPI application.

Three-phase pipeline:
  POST /upload              → store audio file, create session
  POST /analyze/{id}        → run transcription, store notes        (background)
  POST /harmonize/{id}      → chord detection + SATB + MusicXML    (background)
  GET  /session/{id}        → poll status + results
  GET  /export/{id}         → download MusicXML

Run:
    uvicorn main:app --reload --port 8000
"""

import json
import os
import uuid
from pathlib import Path
from typing import Iterator

from dotenv import load_dotenv

# Resolve paths to this package (works no matter the process CWD, e.g. `uvicorn` from repo root).
BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(BACKEND_DIR / ".env")

from fastapi import BackgroundTasks, Body, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from core.basic_pitch_runner import (
    midi_to_name,
    transcribe_audio,
    estimate_tempo_from_notes,
    quantize_to_scale,
    monophonize,
    filter_lead_notes,
    merge_nearby,
)
from core.chord_detection import detect_chords
from core.elevenlabs_choir import generate_choir_audio
from core.key_detection import detect_key
from core.melody_cleanup import clean_melody_notes, midi_to_name, simplify_lead_for_export
from core.midi_refiner import refine_midi
from core.musicxml_builder import build_musicxml
from core.voice_assignment import assign_voices
from database import get_db, init_db

app = FastAPI(title="Hum to Harmony")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

AUDIO_DIR = str(BACKEND_DIR / "audio_files")
CHOIR_DIR = str(BACKEND_DIR / "audio_files" / "choir")
os.makedirs(AUDIO_DIR, exist_ok=True)
os.makedirs(CHOIR_DIR, exist_ok=True)
init_db()

CHOIR_PARTS = ("soprano", "alto", "tenor", "bass", "mixed")


class TextSingRequest(BaseModel):
    lyrics: str = Field(..., min_length=1, max_length=4000)


class MelodyNoteIn(BaseModel):
    pitch: int
    start_time: float
    duration: float
    note_name: str | None = None


class MelodyUpdateRequest(BaseModel):
    notes: list[MelodyNoteIn]


# ---------------------------------------------------------------------------
# Background tasks
# ---------------------------------------------------------------------------

def _music_duration_ms(lyrics: str) -> int:
    """Pick a short-but-complete music duration from lyric length."""
    words = len(lyrics.split())
    # Roughly 2.5 words/sec for a sung line, with room for intro/outro.
    seconds = max(15, min(60, int(words / 2.5) + 10))
    return seconds * 1000


def _elevenlabs_music_compose(
    prompt: str,
    api_key: str,
    music_length_ms: int,
) -> Iterator[bytes]:
    """Stream ElevenLabs Music generation via the REST API."""
    import requests

    resp = requests.post(
        "https://api.elevenlabs.io/v1/music",
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        json={
            "prompt": prompt,
            "music_length_ms": music_length_ms,
            "model_id": "music_v1",
            "force_instrumental": False,
        },
        stream=True,
        timeout=180,
    )
    if not resp.ok:
        detail = resp.text
        try:
            detail_json = resp.json()
            suggestion = (
                detail_json.get("prompt_suggestion")
                or detail_json.get("composition_plan_suggestion")
            )
            detail = suggestion or detail_json.get("detail") or detail
        except Exception:
            pass
        raise RuntimeError(f"ElevenLabs Music failed ({resp.status_code}): {detail}")
    yield from resp.iter_content(chunk_size=64 * 1024)

def run_transcription(session_id: str, audio_path: str) -> None:
    """Phase 1: NeuralNote/Basic Pitch transcription only."""
    db = get_db()
    try:
        notes, bpm_librosa = transcribe_audio(audio_path)

        # Derive tempo from note onset spacing for playback / harmonization.
        tempo = estimate_tempo_from_notes(notes)

        key_name, key_mode = detect_key(notes)

        bpm_for_db = int(bpm_librosa) if bpm_librosa is not None else None
        db.execute(
            "UPDATE sessions SET status='notes_ready', key_name=?, key_mode=?, tempo=?, bpm_librosa=?, last_error=NULL WHERE id=?",
            (key_name, key_mode, tempo, bpm_for_db, session_id),
        )
        db.execute(
            "INSERT INTO melodies VALUES (?, ?, ?)",
            (str(uuid.uuid4()), session_id, json.dumps(notes)),
        )
        db.commit()

    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}"
        print(f"[transcription] session={session_id} error: {err}")
        db.execute(
            "UPDATE sessions SET status='failed', last_error=? WHERE id=?",
            (err, session_id),
        )
        db.commit()
    finally:
        db.close()


def run_text_sing(session_id: str, lyrics: str) -> None:
    """
    Generate actual music/vocals using ElevenLabs Music, then transcribe the
    resulting audio into editable notes for MIDI export / harmony.
    """
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    text = lyrics.strip()[:3000]
    path = os.path.join(AUDIO_DIR, f"{session_id}_music.mp3")

    try:
        if not api_key:
            raise RuntimeError("ELEVENLABS_API_KEY is not set.")
        if not text:
            raise ValueError("Empty lyrics")

        duration_ms = _music_duration_ms(text)
        prompt = (
            "Create an original short song with a clear, normal human lead vocal singing "
            "the provided lyrics. Use a regular mid-range voice, not chipmunk, not spoken "
            "word, not narration. Keep the arrangement sparse so the vocal melody is easy "
            "to detect for MIDI transcription. Do not add extra words beyond the lyrics. "
            f"Style: simple pop ballad, warm, melodic, steady tempo. Lyrics:\n{text}"
        )

        with open(path, "wb") as f:
            for chunk in _elevenlabs_music_compose(prompt, api_key, duration_ms):
                if chunk:
                    f.write(chunk)

        db = get_db()
        db.execute("UPDATE sessions SET audio_path=? WHERE id=?", (path, session_id))
        db.commit()
        db.close()

        run_transcription(session_id, path)
    except Exception as exc:
        print(f"[text-sing] session={session_id} error: {exc}")
        db = get_db()
        db.execute("UPDATE sessions SET status='failed' WHERE id=?", (session_id,))
        db.commit()
        db.close()


def run_harmonization(session_id: str) -> None:
    """Phase 2: chord detection + SATB voice assignment + MusicXML."""
    db = get_db()
    try:
        session = dict(
            db.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
        )
        melody = db.execute(
            "SELECT notes FROM melodies WHERE session_id=?", (session_id,)
        ).fetchone()

        if not melody:
            raise ValueError("No melody found for session")

        notes = json.loads(melody["notes"])
        tempo = session.get("tempo") or 120
        key_name = session.get("key_name") or "C"
        key_mode = session.get("key_mode") or "major"

        db.execute("UPDATE sessions SET status='harmonizing' WHERE id=?", (session_id,))
        db.execute("DELETE FROM arrangements WHERE session_id=?", (session_id,))
        db.commit()

        # Heavily filtered lead stream for harmony generation only.
        # Keep raw notes untouched in DB for "Raw MIDI" export.
        harmony_lead = sorted(notes, key=lambda n: n["start_time"])
        harmony_lead = monophonize(harmony_lead)
        harmony_lead = filter_lead_notes(harmony_lead, window=11)
        harmony_lead = merge_nearby(harmony_lead, gap_ms=120.0)
        harmony_lead = quantize_to_scale(harmony_lead, key_name, key_mode)
        harmony_lead = clean_melody_notes(harmony_lead, key_name, key_mode, tempo)

        # Coarse rhythmic grid for chord alignment (8th/16th based on tempo feel).
        beat_sec = 60.0 / max(tempo, 1)
        grid = beat_sec / 2 if tempo < 110 else beat_sec / 4
        for n in harmony_lead:
            st = round(float(n["start_time"]) / grid) * grid
            en = round(float(n["end_time"]) / grid) * grid
            if en <= st:
                en = st + grid
            n["start_time"] = round(st, 4)
            n["end_time"] = round(en, 4)
            n["duration"] = round(en - st, 4)

        # Use the legacy chord detector for more varied, melody-sensitive changes.
        # Music21 is useful for theory checks, but its Roman-numeral scoring was
        # over-preferring tonic chords on short hummed melodies.
        chords = detect_chords(harmony_lead, tempo, key_name, key_mode)
        parts = assign_voices(harmony_lead, chords)
        musicxml = build_musicxml(parts, key_name, tempo)

        db.execute(
            "INSERT INTO arrangements VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                str(uuid.uuid4()),
                session_id,
                json.dumps(chords),
                json.dumps(parts["soprano"]),
                json.dumps(parts["alto"]),
                json.dumps(parts["tenor"]),
                json.dumps(parts["bass"]),
                musicxml,
            ),
        )
        db.execute("UPDATE sessions SET status='complete' WHERE id=?", (session_id,))
        db.commit()

    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}"
        print(f"[harmonization] session={session_id} error: {err}")
        db.execute(
            "UPDATE sessions SET status='failed', last_error=? WHERE id=?",
            (err, session_id),
        )
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def _normalize_edited_notes(notes: list[dict]) -> tuple[list[dict], int, str, str]:
    if not notes:
        raise HTTPException(status_code=400, detail="At least one note is required")

    normalized: list[dict] = []
    for raw in notes:
        try:
            pitch = max(0, min(127, int(round(float(raw["pitch"])))))
            start = max(0.0, float(raw["start_time"]))
            duration = max(0.03, float(raw["duration"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=f"Invalid note: {raw}") from exc

        normalized.append(
            {
                "note_name": midi_to_name(pitch),
                "pitch": pitch,
                "start_time": round(start, 4),
                "end_time": round(start + duration, 4),
                "duration": round(duration, 4),
                "amplitude": float(raw.get("amplitude", 0.75)),
            }
        )

    normalized.sort(key=lambda n: float(n["start_time"]))
    tempo = estimate_tempo_from_notes(normalized)
    key_name, key_mode = detect_key(normalized)
    return normalized, tempo, key_name, key_mode


def _save_edited_notes(
    db,
    session_id: str,
    notes: list[dict],
    allow_harmonizing: bool = False,
) -> tuple[list[dict], int, str, str]:
    normalized, tempo, key_name, key_mode = _normalize_edited_notes(notes)

    row = db.execute("SELECT id, status FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    if row["status"] == "harmonizing" and not allow_harmonizing:
        raise HTTPException(status_code=409, detail="Harmony is already being generated")

    melody = db.execute(
        "SELECT session_id FROM melodies WHERE session_id=?", (session_id,)
    ).fetchone()
    if not melody:
        raise HTTPException(status_code=400, detail="No melody found for session")

    db.execute(
        "UPDATE melodies SET notes=? WHERE session_id=?",
        (json.dumps(normalized), session_id),
    )
    db.execute("DELETE FROM arrangements WHERE session_id=?", (session_id,))
    db.execute(
        "UPDATE sessions SET status='notes_ready', key_name=?, key_mode=?, tempo=?, last_error=NULL WHERE id=?",
        (key_name, key_mode, tempo, session_id),
    )
    return normalized, tempo, key_name, key_mode

@app.post("/upload")
async def upload(background_tasks: BackgroundTasks, audio: UploadFile = File(...)):
    """Store audio file and immediately kick off transcription."""
    session_id = str(uuid.uuid4())
    ext = os.path.splitext(audio.filename or "")[1] or ".webm"
    audio_path = os.path.join(AUDIO_DIR, f"{session_id}{ext}")

    content = await audio.read()
    with open(audio_path, "wb") as f:
        f.write(content)

    db = get_db()
    db.execute(
        "INSERT INTO sessions (id, status, audio_path) VALUES (?, 'transcribing', ?)",
        (session_id, audio_path),
    )
    db.commit()
    db.close()

    background_tasks.add_task(run_transcription, session_id, audio_path)
    return {"session_id": session_id, "status": "transcribing"}


@app.post("/text-sing")
async def text_sing(req: TextSingRequest, background_tasks: BackgroundTasks):
    """
    Generate spoken/sung audio from lyrics via ElevenLabs, then transcribe to MIDI notes
    (same pipeline as humming upload).
    """
    if not os.getenv("ELEVENLABS_API_KEY", "").strip():
        raise HTTPException(
            status_code=503,
            detail="ELEVENLABS_API_KEY is not set. Add it to backend/.env",
        )

    session_id = str(uuid.uuid4())
    db = get_db()
    db.execute(
        "INSERT INTO sessions (id, status, audio_path) VALUES (?, 'transcribing', ?)",
        (session_id, "text-sing-pending"),
    )
    db.commit()
    db.close()

    background_tasks.add_task(run_text_sing, session_id, req.lyrics)
    return {"session_id": session_id, "status": "transcribing"}


@app.get("/session/{session_id}/source-audio")
async def get_session_source_audio(session_id: str):
    """Stream the original session audio (upload or text-sing TTS)."""
    db = get_db()
    row = db.execute("SELECT audio_path FROM sessions WHERE id=?", (session_id,)).fetchone()
    db.close()
    if not row or not row["audio_path"] or row["audio_path"] == "text-sing-pending":
        raise HTTPException(status_code=404, detail="No source audio yet")
    path = row["audio_path"]
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Source audio file missing")

    ext = os.path.splitext(path)[1].lower()
    media = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".webm": "audio/webm",
        ".ogg": "audio/ogg",
        ".m4a": "audio/mp4",
    }.get(ext, "application/octet-stream")

    return FileResponse(
        path,
        media_type=media,
        filename=os.path.basename(path),
    )


@app.put("/session/{session_id}/melody")
async def put_session_melody(session_id: str, body: MelodyUpdateRequest):
    """Replace the stored lead melody (e.g. after editing pitches in the UI)."""
    db = get_db()
    row = db.execute("SELECT id FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        db.close()
        raise HTTPException(status_code=404, detail="Session not found")

    notes: list[dict] = []
    for n in body.notes:
        p = int(n.pitch)
        notes.append(
            {
                "pitch": p,
                "start_time": round(float(n.start_time), 4),
                "duration": round(float(n.duration), 4),
                "note_name": n.note_name if n.note_name else midi_to_name(p),
            }
        )

    m = db.execute("SELECT id FROM melodies WHERE session_id=?", (session_id,)).fetchone()
    if m:
        db.execute(
            "UPDATE melodies SET notes=? WHERE session_id=?",
            (json.dumps(notes), session_id),
        )
    else:
        db.execute(
            "INSERT INTO melodies VALUES (?, ?, ?)",
            (str(uuid.uuid4()), session_id, json.dumps(notes)),
        )
    db.commit()
    db.close()
    return {"ok": True, "count": len(notes)}


@app.post("/harmonize/{session_id}")
async def harmonize(session_id: str, background_tasks: BackgroundTasks):
    """Trigger chord detection + SATB arrangement for a session with notes_ready status."""
    db = get_db()
    row = db.execute("SELECT status FROM sessions WHERE id=?", (session_id,)).fetchone()
    db.close()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    if row["status"] not in ("notes_ready", "complete"):
        raise HTTPException(status_code=400, detail=f"Cannot harmonize from status: {row['status']}")

    background_tasks.add_task(run_harmonization, session_id)
    return {"session_id": session_id, "status": "harmonizing"}


@app.post("/harmonize/{session_id}/notes")
async def harmonize_with_notes(
    session_id: str,
    background_tasks: BackgroundTasks,
    notes: list[dict] = Body(...),
):
    """Save the current piano-roll notes, then trigger harmonization."""
    db = get_db()
    try:
        _save_edited_notes(db, session_id, notes, allow_harmonizing=True)
        db.commit()
    finally:
        db.close()

    background_tasks.add_task(run_harmonization, session_id)
    return {"session_id": session_id, "status": "harmonizing"}


@app.get("/session/{session_id}")
async def get_session(session_id: str):
    db = get_db()
    row = db.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")

    session = dict(row)
    melody = db.execute(
        "SELECT notes FROM melodies WHERE session_id=?", (session_id,)
    ).fetchone()
    arrangement = db.execute(
        "SELECT * FROM arrangements WHERE session_id=?", (session_id,)
    ).fetchone()
    db.close()

    notes = json.loads(melody["notes"]) if melody else []
    chords: list = []
    parts: dict = {}
    if arrangement:
        chords = json.loads(arrangement["chords"])
        soprano = json.loads(arrangement["soprano"])
        alto = json.loads(arrangement["alto"])
        tenor = json.loads(arrangement["tenor"])
        bass = json.loads(arrangement["bass"])
        parts = {
            "soprano": soprano,
            "alto": alto,
            "tenor": tenor,
            "bass": bass,
            "piano_rh": sorted(soprano + alto, key=lambda n: (n["start_time"], n["pitch"])),
            "piano_lh": sorted(tenor + bass, key=lambda n: (n["start_time"], n["pitch"])),
        }

    key_str = " ".join(
        filter(None, [session.get("key_name", ""), session.get("key_mode", "")])
    )

    bpm = session.get("bpm_librosa")
    ap = session.get("audio_path")
    source_audio_ready = bool(
        ap
        and str(ap) != "text-sing-pending"
        and os.path.isfile(str(ap))
    )
    return {
        "session_id": session_id,
        "status": session["status"],
        "key": key_str,
        "tempo": session.get("tempo") or 120,
        "bpm_librosa": int(bpm) if bpm is not None else None,
        "error": session.get("last_error"),
        "notes": notes,
        "chords": chords,
        "parts": parts,
        "source_audio_ready": source_audio_ready,
    }


@app.put("/session/{session_id}/notes")
async def update_session_notes(session_id: str, notes: list[dict] = Body(...)):
    """Persist user-edited melody notes and invalidate the old arrangement."""
    db = get_db()
    try:
        normalized, tempo, key_name, key_mode = _save_edited_notes(db, session_id, notes)
        db.commit()
    finally:
        db.close()

    return {
        "session_id": session_id,
        "status": "notes_ready",
        "key": f"{key_name} {key_mode}",
        "tempo": tempo,
        "notes": normalized,
    }


def _melody_path(session_id: str) -> str:
    return os.path.join(CHOIR_DIR, f"{session_id}_melody.wav")

def _melody_flag(session_id: str, suffix: str) -> str:
    return os.path.join(CHOIR_DIR, f"{session_id}_melody.{suffix}")


def run_melody_synthesis(session_id: str) -> None:
    """Background: sing the raw melody notes with one ElevenLabs voice."""
    from core.elevenlabs_choir import _synth_part, _to_wav_bytes, SAMPLE_RATE
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()

    open(_melody_flag(session_id, "generating"), "w").close()

    db = get_db()
    try:
        melody = db.execute(
            "SELECT notes FROM melodies WHERE session_id=?", (session_id,)
        ).fetchone()
        db.close()

        if not melody:
            raise ValueError("No melody found — run /analyze first")

        notes = json.loads(melody["notes"])
        # voice is auto-chosen by melody pitch range (low->male, high->female)
        audio = _synth_part(notes, None, api_key, SAMPLE_RATE, part_name="melody")
        with open(_melody_path(session_id), "wb") as f:
            f.write(_to_wav_bytes(audio, SAMPLE_RATE))

    except Exception as exc:
        print(f"[melody-voice] session={session_id} error: {exc}")
        with open(_melody_flag(session_id, "error"), "w") as f:
            f.write(str(exc))
    finally:
        try:
            os.remove(_melody_flag(session_id, "generating"))
        except OSError:
            pass


@app.post("/melody-voice/{session_id}")
async def start_melody_voice(session_id: str, background_tasks: BackgroundTasks):
    """Kick off ElevenLabs singing of the raw melody ("dom" syllables)."""
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="ELEVENLABS_API_KEY is not set.")

    db = get_db()
    row = db.execute("SELECT status FROM sessions WHERE id=?", (session_id,)).fetchone()
    db.close()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    if row["status"] not in ("notes_ready", "harmonizing", "complete"):
        raise HTTPException(status_code=400, detail="Transcription not complete yet")

    if os.path.exists(_melody_path(session_id)):
        return {"status": "ready"}
    if os.path.exists(_melody_flag(session_id, "generating")):
        return {"status": "generating"}

    try:
        os.remove(_melody_flag(session_id, "error"))
    except OSError:
        pass

    background_tasks.add_task(run_melody_synthesis, session_id)
    return {"status": "generating"}


@app.get("/melody-voice/{session_id}")
async def get_melody_voice_status(session_id: str):
    """Poll ElevenLabs melody synthesis status."""
    if os.path.exists(_melody_flag(session_id, "generating")):
        return {"status": "generating"}
    if os.path.exists(_melody_flag(session_id, "error")):
        with open(_melody_flag(session_id, "error")) as f:
            return {"status": "failed", "error": f.read()}
    if os.path.exists(_melody_path(session_id)):
        return {"status": "ready"}
    return {"status": "idle"}


@app.get("/melody-voice/audio/{session_id}")
async def get_melody_voice_audio(session_id: str):
    """Stream the ElevenLabs melody WAV."""
    path = _melody_path(session_id)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Audio not ready yet")
    with open(path, "rb") as f:
        return Response(
            content=f.read(),
            media_type="audio/wav",
            headers={"Content-Disposition": "inline; filename=melody-voice.wav"},
        )


def _choir_path(session_id: str, part: str) -> str:
    return os.path.join(CHOIR_DIR, f"{session_id}_{part}.wav")

def _choir_flag(session_id: str, suffix: str) -> str:
    return os.path.join(CHOIR_DIR, f"{session_id}.{suffix}")


def run_choir_synthesis(session_id: str) -> None:
    """Background: generate SATB + mixed choir audio via ElevenLabs."""
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()

    # Mark as in-progress
    open(_choir_flag(session_id, "generating"), "w").close()
    error_path = _choir_flag(session_id, "error")

    db = get_db()
    try:
        arrangement = db.execute(
            "SELECT soprano, alto, tenor, bass FROM arrangements WHERE session_id=?",
            (session_id,),
        ).fetchone()
        db.close()

        if not arrangement:
            raise ValueError("No arrangement found — run /harmonize first")

        parts = {
            "soprano": json.loads(arrangement["soprano"]),
            "alto":    json.loads(arrangement["alto"]),
            "tenor":   json.loads(arrangement["tenor"]),
            "bass":    json.loads(arrangement["bass"]),
        }

        audio_map = generate_choir_audio(parts, api_key)

        for part, wav_bytes in audio_map.items():
            if wav_bytes:
                with open(_choir_path(session_id, part), "wb") as f:
                    f.write(wav_bytes)

    except Exception as exc:
        print(f"[choir] session={session_id} error: {exc}")
        with open(error_path, "w") as f:
            f.write(str(exc))
    finally:
        # Remove in-progress sentinel
        try:
            os.remove(_choir_flag(session_id, "generating"))
        except OSError:
            pass


@app.post("/choir/{session_id}")
async def start_choir(session_id: str, background_tasks: BackgroundTasks):
    """Kick off ElevenLabs choir synthesis for a completed arrangement."""
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=(
                "ELEVENLABS_API_KEY is not set. "
                "Add it to backend/.env and restart the server."
            ),
        )

    db = get_db()
    row = db.execute("SELECT status FROM sessions WHERE id=?", (session_id,)).fetchone()
    db.close()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    if row["status"] != "complete":
        raise HTTPException(status_code=400, detail="Arrangement not complete yet")

    # If already done, just say so
    if os.path.exists(_choir_path(session_id, "mixed")):
        return {"status": "ready"}

    # Avoid double-generation
    if os.path.exists(_choir_flag(session_id, "generating")):
        return {"status": "generating"}

    # Clear any previous error
    try:
        os.remove(_choir_flag(session_id, "error"))
    except OSError:
        pass

    background_tasks.add_task(run_choir_synthesis, session_id)
    return {"status": "generating"}


@app.get("/choir/{session_id}")
async def get_choir_status(session_id: str):
    """Poll choir synthesis status. Returns ready parts once complete."""
    if os.path.exists(_choir_flag(session_id, "generating")):
        return {"status": "generating", "parts": []}

    if os.path.exists(_choir_flag(session_id, "error")):
        with open(_choir_flag(session_id, "error")) as f:
            msg = f.read()
        return {"status": "failed", "error": msg, "parts": []}

    ready = [p for p in CHOIR_PARTS if os.path.exists(_choir_path(session_id, p))]
    if ready:
        return {"status": "ready", "parts": ready}

    return {"status": "idle", "parts": []}


@app.get("/choir/audio/{session_id}/{part}")
async def get_choir_audio(session_id: str, part: str):
    """Stream a single choir part WAV (soprano/alto/tenor/bass/mixed)."""
    if part not in CHOIR_PARTS:
        raise HTTPException(status_code=400, detail=f"Unknown part: {part}")
    path = _choir_path(session_id, part)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Audio not ready yet")
    with open(path, "rb") as f:
        wav_bytes = f.read()
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"Content-Disposition": f"inline; filename={part}.wav"},
    )


@app.post("/refine/{session_id}")
async def refine(session_id: str):
    """
    Refine the session's raw notes into a cleaner MIDI using a local
    deterministic pipeline (no external API key required).
    """
    import asyncio
    from functools import partial

    db = get_db()
    row = db.execute("SELECT status FROM sessions WHERE id=?", (session_id,)).fetchone()
    melody = db.execute(
        "SELECT notes FROM melodies WHERE session_id=?", (session_id,)
    ).fetchone()
    session_row = db.execute(
        "SELECT tempo, key_name, key_mode FROM sessions WHERE id=?",
        (session_id,),
    ).fetchone()
    db.close()

    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    if not melody:
        raise HTTPException(status_code=400, detail="No notes yet — run /analyze first")

    notes = json.loads(melody["notes"])
    tempo = int((session_row["tempo"] or 120) if session_row else 120)
    key_name = session_row["key_name"] if session_row else None
    key_mode = session_row["key_mode"] if session_row else None

    try:
        loop = asyncio.get_event_loop()
        midi_bytes: bytes = await loop.run_in_executor(
            None, partial(refine_midi, notes, tempo, key_name, key_mode)
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Local refinement failed: {exc}")

    return Response(
        content=midi_bytes,
        media_type="audio/midi",
        headers={"Content-Disposition": "attachment; filename=refined.mid"},
    )


@app.get("/export/{session_id}")
async def export(session_id: str):
    db = get_db()
    row = db.execute(
        "SELECT musicxml FROM arrangements WHERE session_id=?", (session_id,)
    ).fetchone()
    db.close()
    if not row:
        raise HTTPException(status_code=404, detail="Arrangement not found")

    return Response(
        content=row["musicxml"],
        media_type="application/xml",
        headers={"Content-Disposition": "attachment; filename=arrangement.musicxml"},
    )


@app.get("/export-midi/{session_id}")
async def export_midi(session_id: str):
    """
    Export arrangement as MIDI with:
      - Lead melody track
      - SATB tracks aligned to lead note onsets

    MIDI order: Lead, Soprano, Alto, Tenor, Bass
    """
    import io
    import mido

    db = get_db()
    session = db.execute(
        "SELECT tempo, key_name, key_mode FROM sessions WHERE id=?",
        (session_id,),
    ).fetchone()
    melody = db.execute("SELECT notes FROM melodies WHERE session_id=?", (session_id,)).fetchone()
    arrangement = db.execute(
        "SELECT soprano, alto, tenor, bass FROM arrangements WHERE session_id=?",
        (session_id,),
    ).fetchone()
    db.close()

    if not session or not arrangement:
        raise HTTPException(status_code=404, detail="Arrangement not found")

    tempo = int(session["tempo"] or 120)
    melody_notes = json.loads(melody["notes"]) if melody else []
    melody_notes = simplify_lead_for_export(
        melody_notes,
        session["key_name"] or None,
        session["key_mode"] or None,
        tempo,
    )
    s = json.loads(arrangement["soprano"])
    a = json.loads(arrangement["alto"])
    t = json.loads(arrangement["tenor"])
    b = json.loads(arrangement["bass"])

    ticks_per_beat = 480
    sec_per_tick = 60.0 / (max(1, tempo) * ticks_per_beat)
    mid = mido.MidiFile(type=1, ticks_per_beat=ticks_per_beat)

    melody_notes = sorted(melody_notes, key=lambda n: float(n["start_time"]))
    lead_onsets = [float(n["start_time"]) for n in melody_notes]

    def _lead_to_chord_aware_grid(notes: list[dict], chord_notes: list[dict]) -> list[dict]:
        """
        Arrangement MIDI only: keep the lead note placement from the audio, then
        lightly quantize to a small grid. This preserves real gaps instead of
        rebuilding the melody into artificial fixed 8th-note buckets.
        """
        if not notes:
            return []
        beat_sec = 60.0 / max(1, tempo)
        sixteenth_sec = beat_sec / 4
        quarter_sec = beat_sec
        half_sec = beat_sec * 2
        grid_notes: list[dict] = []

        for n in sorted(notes, key=lambda item: float(item["start_time"])):
            start_raw = float(n["start_time"])
            end_raw = start_raw + float(n["duration"])
            start = round(start_raw / sixteenth_sec) * sixteenth_sec
            end = round(end_raw / sixteenth_sec) * sixteenth_sec
            if end <= start:
                end = start + max(sixteenth_sec, float(n["duration"]))
            grid_notes.append(
                {
                    "pitch": int(round(n["pitch"])),
                    "start_time": start,
                    "duration": max(sixteenth_sec, end - start),
                }
            )

        if not grid_notes:
            return []

        # Resolve accidental overlaps without closing intentional rests.
        non_overlapping: list[dict] = []
        for note in grid_notes:
            prev = non_overlapping[-1] if non_overlapping else None
            if prev:
                prev_end = float(prev["start_time"]) + float(prev["duration"])
                if float(note["start_time"]) < prev_end:
                    prev["duration"] = max(sixteenth_sec, float(note["start_time"]) - float(prev["start_time"]))
                    if prev["duration"] <= sixteenth_sec * 0.55:
                        non_overlapping.pop()
            non_overlapping.append(dict(note))
        grid_notes = non_overlapping

        # Chord spans come from SATB sustained notes (all voices share timing).
        chord_spans = sorted(
            [(float(n["start_time"]), float(n["start_time"]) + float(n["duration"])) for n in chord_notes],
            key=lambda x: x[0],
        )

        def _span_for(t: float) -> tuple[float, float] | None:
            for st, en in chord_spans:
                if st <= t < en:
                    return st, en
            return None

        merged: list[dict] = []
        for note in grid_notes:
            span = _span_for(float(note["start_time"]))
            same_pitch = merged and merged[-1]["pitch"] == note["pitch"]
            contiguous = merged and abs(merged[-1]["start_time"] + merged[-1]["duration"] - note["start_time"]) < 1e-6
            same_chord_span = False
            if merged and span:
                prev_span = _span_for(float(merged[-1]["start_time"]))
                same_chord_span = prev_span == span

            if same_pitch and contiguous and same_chord_span:
                # Allow stable lead tones to sustain under longer chords.
                max_len = half_sec if span and (span[1] - span[0]) >= half_sec else quarter_sec
                if merged[-1]["duration"] + note["duration"] <= max_len + 1e-6:
                    merged[-1]["duration"] += note["duration"]
                    continue
            merged.append(dict(note))

        return merged

    def _snap_to_lead_onset(t: float) -> float:
        """
        Snap chord onsets to nearby lead onsets (if close), so harmony entries
        line up when they come in while keeping mostly sustained chord lengths.
        """
        if not lead_onsets:
            return t
        beat_sec = 60.0 / max(1, tempo)
        max_snap = beat_sec * 0.35
        nearest = min(lead_onsets, key=lambda x: abs(x - t))
        return nearest if abs(nearest - t) <= max_snap else t

    def _align_chord_entries_to_lead(voice_notes: list[dict]) -> list[dict]:
        out: list[dict] = []
        for n in voice_notes:
            out.append(
                {
                    **n,
                    "start_time": _snap_to_lead_onset(float(n["start_time"])),
                    # Keep sustained durations (majority full/half notes)
                    "duration": max(0.25, float(n["duration"])),
                }
            )
        return out

    def _is_consonant_with_lead(harmony_pitch: int, lead_pitch: int) -> bool:
        interval = abs(harmony_pitch - lead_pitch) % 12
        # Treat seconds, sevenths, and tritone as clashes against the lead.
        return interval in {0, 3, 4, 5, 7, 8, 9}

    def _dominant_lead_pitch(start: float, end: float) -> int | None:
        overlaps = []
        for n in lead_export:
            n_start = float(n["start_time"])
            n_end = n_start + float(n["duration"])
            overlap = max(0.0, min(end, n_end) - max(start, n_start))
            if overlap > 0:
                overlaps.append((int(round(n["pitch"])), overlap))
        if not overlaps:
            return None
        return max(overlaps, key=lambda item: item[1])[0]

    def _nearest_consonant_chord_tone(
        original_pitch: int,
        lead_pitch: int,
        chord_pcs: set[int],
        voice_range: tuple[int, int],
    ) -> int | None:
        lo, hi = voice_range
        candidates = [
            pc + (12 * octave)
            for pc in chord_pcs
            for octave in range(0, 9)
            if lo <= pc + (12 * octave) <= hi
            and _is_consonant_with_lead(pc + (12 * octave), lead_pitch)
        ]
        if not candidates:
            return None
        return min(candidates, key=lambda pitch: abs(pitch - original_pitch))

    def _sanitize_harmony_against_lead(
        voices: dict[str, list[dict]],
    ) -> dict[str, list[dict]]:
        ranges = {
            "soprano": (60, 79),
            "alto": (55, 74),
            "tenor": (48, 69),
            "bass": (40, 60),
        }
        entries_by_span: dict[tuple[float, float], list[tuple[str, dict]]] = {}
        for voice, notes in voices.items():
            for n in notes:
                start = round(float(n["start_time"]), 4)
                end = round(start + float(n["duration"]), 4)
                entries_by_span.setdefault((start, end), []).append((voice, n))

        cleaned = {voice: [] for voice in voices}
        for (start, end), entries in sorted(entries_by_span.items()):
            lead_pitch = _dominant_lead_pitch(start, end)
            if lead_pitch is None:
                for voice, note in entries:
                    cleaned[voice].append(note)
                continue

            chord_pcs = {int(round(note["pitch"])) % 12 for _voice, note in entries}
            moved_entries: list[tuple[str, dict]] = []
            for voice, note in entries:
                pitch = int(round(note["pitch"]))
                if _is_consonant_with_lead(pitch, lead_pitch):
                    moved_entries.append((voice, note))
                    continue

                moved_pitch = _nearest_consonant_chord_tone(
                    pitch,
                    lead_pitch,
                    chord_pcs,
                    ranges[voice],
                )
                if moved_pitch is not None:
                    moved_entries.append((voice, {**note, "pitch": moved_pitch}))

            # If the whole chord clashes with the lead, omit it rather than
            # forcing a brittle replacement voicing into the MIDI export.
            if moved_entries:
                for voice, note in moved_entries:
                    cleaned[voice].append(note)

        return cleaned

    def add_track(
        name: str,
        notes: list[dict],
        velocity: int = 80,
        include_tempo: bool = False,
        channel: int = 0,
    ):
        tr = mido.MidiTrack()
        mid.tracks.append(tr)
        tr.append(mido.MetaMessage("track_name", name=name, time=0))
        if include_tempo:
            tr.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(tempo), time=0))
        # Acoustic Grand Piano. Keep track names separate for score import.
        tr.append(mido.Message("program_change", channel=channel, program=0, time=0))
        events = []
        for n in notes:
            p = int(round(n["pitch"]))
            st = int(round(float(n["start_time"]) / sec_per_tick))
            du = max(1, int(round(float(n["duration"]) / sec_per_tick)))
            events.append((st, "note_on", p, velocity))
            events.append((st + du, "note_off", p, 0))
        events.sort(key=lambda e: (e[0], 0 if e[1] == "note_off" else 1))
        cur = 0
        for tick, kind, pitch, vel in events:
            tr.append(
                mido.Message(
                    kind,
                    note=pitch,
                    velocity=vel,
                    channel=channel,
                    time=tick - cur,
                )
            )
            cur = tick

    # Arrangement MIDI only: lead becomes a simplified vocal melody.
    # Raw/Filtered MIDI buttons are not affected.
    lead_export = _lead_to_chord_aware_grid(melody_notes, s)
    sop_export = _align_chord_entries_to_lead(s)
    alto_export = _align_chord_entries_to_lead(a)
    tenor_export = _align_chord_entries_to_lead(t)
    bass_export = _align_chord_entries_to_lead(b)
    sanitized_harmony = _sanitize_harmony_against_lead(
        {
            "soprano": sop_export,
            "alto": alto_export,
            "tenor": tenor_export,
            "bass": bass_export,
        }
    )
    sop_export = sanitized_harmony["soprano"]
    alto_export = sanitized_harmony["alto"]
    tenor_export = sanitized_harmony["tenor"]
    bass_export = sanitized_harmony["bass"]

    # Required order and labels: Lead, Sop, Alto, Tenor, Bass.
    add_track("Lead", lead_export, 88, include_tempo=True, channel=0)
    add_track("Sop", sop_export, 82, channel=1)
    add_track("Alto", alto_export, 76, channel=2)
    add_track("Tenor", tenor_export, 74, channel=3)
    add_track("Bass", bass_export, 72, channel=4)

    buffer = io.BytesIO()
    mid.save(file=buffer)
    return Response(
        content=buffer.getvalue(),
        media_type="audio/midi",
        headers={"Content-Disposition": "attachment; filename=arrangement.mid"},
    )
