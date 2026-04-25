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

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from core.basic_pitch_runner import transcribe_audio, estimate_tempo_from_notes, quantize_to_scale
from core.chord_detection import detect_chords
from core.key_detection import detect_key
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

AUDIO_DIR = "audio_files"
os.makedirs(AUDIO_DIR, exist_ok=True)
init_db()


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
