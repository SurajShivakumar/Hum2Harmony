"""
Mock FastAPI server — push this first so Person A can start building immediately.

New 3-phase API:
  POST /upload              → session_id, status "transcribing"
  GET  /session/{id}        → polls status; mock goes straight to "notes_ready"
  POST /harmonize/{id}      → triggers harmony; mock transitions to "complete"
  GET  /export/{id}         → MusicXML file

Run:
    pip install fastapi uvicorn python-multipart
    uvicorn mock_main:app --reload --port 8000
"""

import uuid
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

app = FastAPI(title="Hum to Harmony — Mock Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory session state for mock
_sessions: dict[str, str] = {}

MOCK_NOTES = [
    {"note_name": "C4", "pitch": 60, "start_time": 0.0,  "duration": 0.5},
    {"note_name": "E4", "pitch": 64, "start_time": 0.5,  "duration": 0.5},
    {"note_name": "G4", "pitch": 67, "start_time": 1.0,  "duration": 0.5},
    {"note_name": "E4", "pitch": 64, "start_time": 1.5,  "duration": 0.5},
    {"note_name": "F4", "pitch": 65, "start_time": 2.0,  "duration": 0.5},
    {"note_name": "A4", "pitch": 69, "start_time": 2.5,  "duration": 0.5},
    {"note_name": "G4", "pitch": 67, "start_time": 3.0,  "duration": 1.0},
    {"note_name": "C4", "pitch": 60, "start_time": 4.0,  "duration": 0.5},
    {"note_name": "D4", "pitch": 62, "start_time": 4.5,  "duration": 0.5},
    {"note_name": "E4", "pitch": 64, "start_time": 5.0,  "duration": 0.5},
    {"note_name": "F4", "pitch": 65, "start_time": 5.5,  "duration": 0.5},
    {"note_name": "G4", "pitch": 67, "start_time": 6.0,  "duration": 1.0},
]

MOCK_CHORDS = [
    {"start_time": 0.0, "end_time": 2.0, "chord_name": "C"},
    {"start_time": 2.0, "end_time": 4.0, "chord_name": "F"},
    {"start_time": 4.0, "end_time": 6.0, "chord_name": "G"},
    {"start_time": 6.0, "end_time": 8.0, "chord_name": "C"},
]

MOCK_PARTS = {
    "soprano": [{"note_name": "C4", "pitch": 60, "start_time": 0.0, "duration": 0.5},
                {"note_name": "E4", "pitch": 64, "start_time": 0.5, "duration": 0.5},
                {"note_name": "G4", "pitch": 67, "start_time": 1.0, "duration": 0.5}],
    "alto":    [{"note_name": "E3", "pitch": 52, "start_time": 0.0, "duration": 0.5},
                {"note_name": "G3", "pitch": 55, "start_time": 0.5, "duration": 0.5},
                {"note_name": "C4", "pitch": 60, "start_time": 1.0, "duration": 0.5}],
    "tenor":   [{"note_name": "G3", "pitch": 55, "start_time": 0.0, "duration": 0.5},
                {"note_name": "B3", "pitch": 59, "start_time": 0.5, "duration": 0.5},
                {"note_name": "E4", "pitch": 64, "start_time": 1.0, "duration": 0.5}],
    "bass":    [{"note_name": "C2", "pitch": 36, "start_time": 0.0, "duration": 0.5},
                {"note_name": "C2", "pitch": 36, "start_time": 0.5, "duration": 0.5},
                {"note_name": "C2", "pitch": 36, "start_time": 1.0, "duration": 0.5}],
}

MOCK_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Alto</part-name></score-part>
    <score-part id="P3"><part-name>Tenor</part-name></score-part>
    <score-part id="P4"><part-name>Bass</part-name></score-part>
  </part-list>
</score-partwise>"""


@app.post("/upload")
async def upload(audio: UploadFile = File(...)):
    session_id = str(uuid.uuid4())
    _sessions[session_id] = "notes_ready"  # mock: instantly transcribed
    return {"session_id": session_id, "status": "transcribing"}


@app.post("/harmonize/{session_id}")
async def harmonize(session_id: str):
    _sessions[session_id] = "complete"
    return {"session_id": session_id, "status": "harmonizing"}


@app.get("/session/{session_id}")
async def get_session(session_id: str):
    status = _sessions.get(session_id, "notes_ready")
    notes = MOCK_NOTES
    chords = MOCK_CHORDS if status == "complete" else []
    parts = MOCK_PARTS if status == "complete" else {}
    return {
        "session_id": session_id,
        "status": status,
        "key": "C major",
        "tempo": 120,
        "bpm_librosa": 118,
        "notes": notes,
        "chords": chords,
        "parts": parts,
    }


@app.get("/export/{session_id}")
async def export(session_id: str):
    return Response(
        content=MOCK_MUSICXML,
        media_type="application/xml",
        headers={"Content-Disposition": "attachment; filename=arrangement.musicxml"},
    )
