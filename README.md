# 🎵 Hum to Harmony

**AI-powered acapella arranger.** Hum a melody for 10 seconds → get a full
SATB choral arrangement you can open in MuseScore in under 60 seconds.

---

## Quick Start

### Backend (Person B)

```bash
cd backend
pip install -r requirements.txt

uvicorn main:app --reload --port 8000
```

### Frontend (Person A)

```bash
cd frontend
npm install

# Copy env and set NEXT_PUBLIC_BACKEND_URL to match the API port
cp ../.env.example .env.local

npm run dev
# → http://localhost:3000
```

---

## How It Works

1. **Record** — Browser MediaRecorder captures a hummed melody
2. **Transcribe** — Basic Pitch (Spotify) converts audio to MIDI note events
3. **Detect** — Krumhansl-Schmuckler algorithm finds the key; chord segmentation finds harmonic structure
4. **Arrange** — Rule-based voice leading assigns Soprano, Alto, Tenor, Bass parts
5. **Export** — MusicXML file downloads and opens directly in MuseScore

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/transcribe` | Upload audio, start processing |
| GET | `/session/{id}` | Poll status and results |
| GET | `/export/{id}` | Download MusicXML file |

## Tech Stack

| Layer | Tool |
|-------|------|
| Frontend | Next.js 14 + Tailwind CSS |
| Audio | Browser MediaRecorder API |
| Transcription | Basic Pitch (Spotify, free) |
| Analysis | Librosa |
| Harmony | Algorithmic Python (no API cost) |
| MusicXML | Python string templating |
| Backend | FastAPI + SQLite |

**Zero paid APIs. Zero external accounts required.**
