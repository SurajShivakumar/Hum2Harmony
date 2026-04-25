"""
ElevenLabs choir synthesis.

Strategy
--------
1. Call ElevenLabs TTS once per voice part to get a clean "dom" sample.
2. Detect the natural pitch of that sample (librosa pyin).
3. For every note in the part:
   a. Pitch-shift the base "dom" to the target MIDI pitch.
   b. Time-stretch to match the note's duration.
   c. Drop it into the right position of a silent audio buffer.
4. Normalise and export as 16-bit WAV bytes.
5. Repeat for all four parts; build a stereo mix.

Voice mapping
-------------
  Soprano → Rachel  (bright female, high register)
  Alto    → Bella   (warm female, lower register)
  Tenor   → Antoni  (natural male, mid register)
  Bass    → Adam    (deep male, low register)
"""

from __future__ import annotations

import io
import logging
import os
from typing import Any

import numpy as np
import soundfile as sf

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SAMPLE_RATE = 22_050          # internal processing rate

VOICE_IDS: dict[str, str] = {
    "soprano": "21m00Tcm4TlvDq8ikWAM",  # Rachel
    "alto":    "EXAVITQu4vr4xnSDxMaL",  # Bella
    "tenor":   "ErXwobaYiN019PkySvjV",  # Antoni
    "bass":    "pNInz6obpgDQGcFmaJgB",  # Adam
}

# How tightly to follow the written duration before hard-truncating.
MAX_STRETCH_RATIO = 2.5
MIN_STRETCH_RATIO = 0.4

# ---------------------------------------------------------------------------
# ElevenLabs TTS
# ---------------------------------------------------------------------------

def _elevenlabs_tts(text: str, voice_id: str, api_key: str) -> bytes:
    """Return raw MP3 bytes from ElevenLabs for the given text + voice."""
    import requests  # soft import — only paid when needed

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    headers = {
        "xi-api-key": api_key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    payload = {
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {
            "stability": 0.65,
            "similarity_boost": 0.80,
            "style": 0.0,
            "use_speaker_boost": True,
        },
    }
    resp = requests.post(url, json=payload, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.content


# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------

def _load_mp3(mp3_bytes: bytes, sr: int = SAMPLE_RATE) -> np.ndarray:
    import librosa  # heavy import; lazy
    audio, native_sr = librosa.load(io.BytesIO(mp3_bytes), sr=None, mono=True)
    if native_sr != sr:
        audio = librosa.resample(audio, orig_sr=native_sr, target_sr=sr)
    return audio.astype(np.float32)


def _detect_pitch(audio: np.ndarray, sr: int) -> float:
    """Median voiced F0 via pyin. Falls back to A3 (220 Hz) on failure."""
    import librosa
    try:
        f0, voiced, _ = librosa.pyin(
            audio,
            fmin=float(librosa.note_to_hz("C2")),
            fmax=float(librosa.note_to_hz("C6")),
            sr=sr,
        )
        voiced_f0 = f0[voiced & (f0 > 0)]
        if len(voiced_f0):
            return float(np.median(voiced_f0))
    except Exception as exc:
        log.warning("pyin failed: %s — using 220 Hz fallback", exc)
    return 220.0


def _midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


def _pitch_shift(audio: np.ndarray, sr: int, source_hz: float, target_midi: float) -> np.ndarray:
    import librosa
    target_hz = _midi_to_hz(target_midi)
    n_steps = 12.0 * np.log2(target_hz / max(source_hz, 1.0))
    if abs(n_steps) < 0.05:
        return audio
    return librosa.effects.pitch_shift(audio, sr=sr, n_steps=n_steps).astype(np.float32)


def _fit_duration(audio: np.ndarray, sr: int, target_sec: float) -> np.ndarray:
    """Time-stretch then hard-crop to exact target length, with fade-out."""
    import librosa

    target_sec = max(0.05, target_sec)
    current_sec = len(audio) / sr
    if current_sec <= 0:
        return np.zeros(int(target_sec * sr), dtype=np.float32)

    rate = max(MIN_STRETCH_RATIO, min(MAX_STRETCH_RATIO, current_sec / target_sec))

    try:
        stretched = librosa.effects.time_stretch(audio, rate=rate).astype(np.float32)
    except Exception:
        stretched = audio

    target_samples = int(target_sec * sr)

    if len(stretched) >= target_samples:
        result = stretched[:target_samples].copy()
        # 10 % fade-out to avoid clicks at note boundaries
        fade_len = max(1, target_samples // 10)
        result[-fade_len:] *= np.linspace(1.0, 0.0, fade_len, dtype=np.float32)
        return result
    else:
        return np.pad(stretched, (0, target_samples - len(stretched))).astype(np.float32)


# ---------------------------------------------------------------------------
# Per-part synthesis
# ---------------------------------------------------------------------------

def _synth_part(
    notes: list[dict[str, Any]],
    voice_id: str,
    api_key: str,
    sr: int = SAMPLE_RATE,
) -> np.ndarray:
    """
    Synthesise a single SATB part into a float32 numpy array.
    Returns an empty array if there are no notes.
    """
    if not notes:
        return np.array([], dtype=np.float32)

    log.info("Fetching ElevenLabs 'dom' for voice %s …", voice_id)
    mp3 = _elevenlabs_tts("dom", voice_id, api_key)
    base = _load_mp3(mp3, sr)
    source_hz = _detect_pitch(base, sr)
    log.info("  base pitch detected: %.1f Hz", source_hz)

    # Total buffer length
    last = max(notes, key=lambda n: n["start_time"] + n["duration"])
    total_sec = last["start_time"] + last["duration"] + 0.3
    output = np.zeros(int(total_sec * sr), dtype=np.float32)

    for note in notes:
        pitch     = float(note["pitch"])
        start_s   = float(note["start_time"])
        dur_s     = max(0.08, float(note["duration"]))
        amplitude = float(note.get("amplitude", 0.75))

        shifted  = _pitch_shift(base, sr, source_hz, pitch)
        fitted   = _fit_duration(shifted, sr, dur_s) * amplitude

        start_i = int(start_s * sr)
        end_i   = start_i + len(fitted)
        if end_i > len(output):
            fitted = fitted[: len(output) - start_i]
            end_i  = len(output)
        output[start_i:end_i] += fitted

    # Soft-clip to keep headroom for mixing
    peak = np.max(np.abs(output))
    if peak > 0.9:
        output = output * (0.9 / peak)

    return output


def _to_wav_bytes(audio: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def generate_choir_audio(
    parts: dict[str, list[dict[str, Any]]],
    api_key: str,
    sr: int = SAMPLE_RATE,
) -> dict[str, bytes]:
    """
    Generate WAV audio for all four SATB parts + a full choir mix.

    Parameters
    ----------
    parts : dict with keys "soprano", "alto", "tenor", "bass", each a list of
            NoteEvent dicts (pitch, start_time, duration, amplitude?).
    api_key : ElevenLabs API key.
    sr : sample rate (default 22 050 Hz).

    Returns
    -------
    dict mapping "soprano" | "alto" | "tenor" | "bass" | "mixed"
    to WAV bytes.  Empty parts produce b"".
    """
    api_key = api_key.strip()
    if not api_key:
        raise EnvironmentError("ELEVENLABS_API_KEY is not set.")

    results: dict[str, bytes]    = {}
    arrays:  dict[str, np.ndarray] = {}

    for part_name, voice_id in VOICE_IDS.items():
        notes = parts.get(part_name) or []
        log.info("Synthesising %s (%d notes) …", part_name, len(notes))
        try:
            arr = _synth_part(notes, voice_id, api_key, sr)
        except Exception as exc:
            log.error("Failed to synthesise %s: %s", part_name, exc)
            raise

        results[part_name] = _to_wav_bytes(arr, sr) if len(arr) else b""
        if len(arr):
            arrays[part_name] = arr

    # ---- Full choir mix ----
    if arrays:
        max_len = max(len(a) for a in arrays.values())
        mix = np.zeros(max_len, dtype=np.float32)
        for arr in arrays.values():
            mix[: len(arr)] += arr
        peak = np.max(np.abs(mix))
        if peak > 0.95:
            mix *= 0.95 / peak
        results["mixed"] = _to_wav_bytes(mix, sr)
    else:
        results["mixed"] = b""

    return results
