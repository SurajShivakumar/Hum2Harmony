import os
import sqlite3
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent
_DEFAULT_DB = str(_BACKEND / "hum_to_harmony.db")
DB_PATH = os.environ.get("DB_PATH", _DEFAULT_DB)


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            id          TEXT PRIMARY KEY,
            status      TEXT DEFAULT 'uploaded',
            audio_path  TEXT,
            key_name    TEXT,
            key_mode    TEXT,
            tempo       INTEGER,
            bpm_librosa INTEGER,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS melodies (
            id          TEXT PRIMARY KEY,
            session_id  TEXT REFERENCES sessions(id),
            notes       TEXT  -- JSON array of note objects
        );

        CREATE TABLE IF NOT EXISTS arrangements (
            id          TEXT PRIMARY KEY,
            session_id  TEXT REFERENCES sessions(id),
            chords      TEXT,
            soprano     TEXT,
            alto        TEXT,
            tenor       TEXT,
            bass        TEXT,
            musicxml    TEXT
        );

        CREATE TABLE IF NOT EXISTS music_generations (
            id                    TEXT PRIMARY KEY,
            session_id            TEXT REFERENCES sessions(id),
            lyrics                TEXT,
            style_prompt          TEXT,
            edit_prompt           TEXT,
            prompt                TEXT,
            audio_path            TEXT,
            parent_generation_id  TEXT,
            created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)
    # Add bpm_librosa to databases created before this column existed
    try:
        conn.execute("ALTER TABLE sessions ADD COLUMN bpm_librosa INTEGER")
    except sqlite3.OperationalError as e:
        if "duplicate column" not in str(e).lower():
            raise
    try:
        conn.execute("ALTER TABLE sessions ADD COLUMN last_error TEXT")
    except sqlite3.OperationalError as e:
        if "duplicate column" not in str(e).lower():
            raise
    conn.commit()
    conn.close()
