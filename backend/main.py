"""
Hum to Harmony — real FastAPI application.

Three-phase pipeline:
  POST /upload              → store audio file, create session
  POST /analyze/{id}        → run Basic Pitch, store notes          (background)
  POST /harmonize/{id}      → chord detection + SATB + MusicXML    (background)
  GET  /session/{id}        → poll status + results
  GET  /export/{id}         → download MusicXML

Run:
    uvicorn main:app --reload --port 8000
"""

import json
import os
import uuid

from dotenv import load_dotenv
load_dotenv()  # loads .env in the backend directory

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from core.basic_pitch_runner import transcribe_audio, estimate_tempo_from_notes, quantize_to_scale
from core.chord_detection import detect_chords
from core.elevenlabs_choir import generate_choir_audio
from core.key_detection import detect_key
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

AUDIO_DIR  = "audio_files"
CHOIR_DIR  = os.path.join(AUDIO_DIR, "choir")
os.makedirs(AUDIO_DIR, exist_ok=True)
os.makedirs(CHOIR_DIR, exist_ok=True)
init_db()

CHOIR_PARTS = ("soprano", "alto", "tenor", "bass", "mixed")


# ---------------------------------------------------------------------------
# Background tasks
# ---------------------------------------------------------------------------

def run_transcription(session_id: str, audio_path: str) -> None:
    """Phase 1: Basic Pitch transcription only."""
    db = get_db()
    try:
        notes, bpm_librosa = transcribe_audio(audio_path)

        # Derive tempo from note onset spacing for playback / harmonization.
        tempo = estimate_tempo_from_notes(notes)

        key_name, key_mode = detect_key(notes)

        db.execute(
            "UPDATE sessions SET status='notes_ready', key_name=?, key_mode=?, tempo=?, bpm_librosa=? WHERE id=?",
            (key_name, key_mode, tempo, bpm_librosa, session_id),
        )
        db.execute(
            "INSERT INTO melodies VALUES (?, ?, ?)",
            (str(uuid.uuid4()), session_id, json.dumps(notes)),
        )
        db.commit()

    except Exception as exc:
        print(f"[transcription] session={session_id} error: {exc}")
        db.execute("UPDATE sessions SET status='failed' WHERE id=?", (session_id,))
        db.commit()
    finally:
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
        db.commit()

        chords = detect_chords(notes, tempo, key_name, key_mode)
        parts = assign_voices(notes, chords)
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
        print(f"[harmonization] session={session_id} error: {exc}")
        db.execute("UPDATE sessions SET status='failed' WHERE id=?", (session_id,))
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/upload")
async def upload(background_tasks: BackgroundTasks, audio: UploadFile = File(...)):
    """Store audio file and immediately kick off Basic Pitch transcription."""
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


@app.post("/harmonize/{session_id}")
async def harmonize(session_id: str, background_tasks: BackgroundTasks):
    """Trigger chord detection + SATB arrangement for a session with notes_ready status."""
    db = get_db()
    row = db.execute("SELECT status FROM sessions WHERE id=?", (session_id,)).fetchone()
    db.close()
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    if row["status"] not in ("notes_ready",):
        raise HTTPException(status_code=400, detail=f"Cannot harmonize from status: {row['status']}")

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
        parts = {
            "soprano": json.loads(arrangement["soprano"]),
            "alto": json.loads(arrangement["alto"]),
            "tenor": json.loads(arrangement["tenor"]),
            "bass": json.loads(arrangement["bass"]),
        }

    key_str = " ".join(
        filter(None, [session.get("key_name", ""), session.get("key_mode", "")])
    )

    bpm = session.get("bpm_librosa")
    return {
        "session_id": session_id,
        "status": session["status"],
        "key": key_str,
        "tempo": session.get("tempo") or 120,
        "bpm_librosa": int(bpm) if bpm is not None else None,
        "notes": notes,
        "chords": chords,
        "parts": parts,
    }


MELODY_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"  # Rachel — bright soprano


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
        audio = _synth_part(notes, MELODY_VOICE_ID, api_key, SAMPLE_RATE)
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
