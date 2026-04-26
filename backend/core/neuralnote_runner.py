"""
Adapter for NeuralNote's C++ transcription engine.

NeuralNote does not ship a Python package or command-line transcriber, so the
repo is vendored with a small headless CLI target. This module converts browser
audio to the exact WAV format that CLI expects, executes it, and maps the JSON
events back into the note dict shape used by the rest of the backend.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import tempfile

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def midi_to_name(midi_num: int) -> str:
    return f"{NOTE_NAMES[midi_num % 12]}{(midi_num // 12) - 1}"


def _repo_root() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parents[2]


def _candidate_cli_paths() -> list[pathlib.Path]:
    configured = os.getenv("NEURALNOTE_CLI_PATH", "").strip()
    candidates: list[pathlib.Path] = []
    if configured:
        candidates.append(pathlib.Path(configured))

    root = _repo_root()
    exe = "NeuralNoteCLI.exe" if os.name == "nt" else "NeuralNoteCLI"
    neuralnote = root / "vendor" / "NeuralNote"
    candidates.extend(
        [
            neuralnote / "build" / "Release" / exe,
            neuralnote / "build" / "Debug" / exe,
            neuralnote / "build" / "NeuralNoteCLI_artefacts" / "Release" / exe,
            neuralnote / "build" / "NeuralNoteCLI_artefacts" / "Debug" / exe,
        ]
    )
    return candidates


def neuralnote_cli_path() -> pathlib.Path | None:
    for path in _candidate_cli_paths():
        if path.exists():
            return path
    return None


def _to_neuralnote_wav(input_path: str) -> tuple[str, bool]:
    """Convert any browser audio to 22050 Hz mono 16-bit PCM WAV."""
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                input_path,
                "-ar",
                "22050",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                "-f",
                "wav",
                wav_path,
            ],
            check=True,
            capture_output=True,
        )
        return wav_path, True
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        if os.path.exists(wav_path):
            os.remove(wav_path)
        raise RuntimeError(f"ffmpeg conversion for NeuralNote failed: {exc}") from exc


def transcribe_audio_neuralnote(audio_path: str) -> list[dict]:
    cli = neuralnote_cli_path()
    if cli is None:
        raise FileNotFoundError(
            "NeuralNoteCLI is not built. Run vendor/NeuralNote/build.bat or set NEURALNOTE_CLI_PATH."
        )

    wav_path, converted = _to_neuralnote_wav(audio_path)
    try:
        result = subprocess.run(
            [str(cli), wav_path, "0.7", "0.5", "125"],
            check=True,
            capture_output=True,
            text=True,
        )
        raw_events = json.loads(result.stdout)
    finally:
        if converted and os.path.exists(wav_path):
            os.remove(wav_path)

    notes = []
    for event in raw_events:
        start = float(event["start_time"])
        end = float(event["end_time"])
        duration = max(0.0, end - start)
        if duration < 0.07:
            continue

        pitch = int(round(float(event["pitch"])))
        notes.append(
            {
                "pitch": pitch,
                "note_name": midi_to_name(pitch),
                "start_time": round(start, 4),
                "end_time": round(end, 4),
                "duration": round(duration, 4),
                "amplitude": round(float(event.get("amplitude", 0.8)), 3),
            }
        )

    return sorted(notes, key=lambda n: n["start_time"])
