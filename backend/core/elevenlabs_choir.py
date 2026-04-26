"""
ElevenLabs choir synthesis.

Strategy
--------
1. Call ElevenLabs TTS once per voice part to get a clean sustained "aaah" sample.
2. Detect the natural pitch of that sample (librosa pyin).
3. For every note in the part:
   a. Pitch-shift the base "aaah" to the target MIDI pitch.
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

import copy
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

SATB_VOICE_IDS: dict[str, str] = {
    "soprano": "21m00Tcm4TlvDq8ikWAM",  # Rachel
    "alto":    "EXAVITQu4vr4xnSDxMaL",  # Bella
    "tenor":   "ErXwobaYiN019PkySvjV",  # Antoni
    "bass":    "pNInz6obpgDQGcFmaJgB",  # Adam
}

FEMALE_VOICE_IDS = [
    "21m00Tcm4TlvDq8ikWAM",  # Rachel
    "EXAVITQu4vr4xnSDxMaL",  # Bella
]
MALE_VOICE_IDS = [
    "ErXwobaYiN019PkySvjV",  # Antoni
    "pNInz6obpgDQGcFmaJgB",  # Adam
]

# How tightly to follow the written duration before hard-truncating.
MAX_STRETCH_RATIO = 2.5
MIN_STRETCH_RATIO = 0.4
SYLLABLE = "ahhh"

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
            "stability": 0.82,          # clearer, steadier timbre
            "similarity_boost": 0.90,
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


def _steady_vowel_region(audio: np.ndarray) -> np.ndarray:
    """
    Extract steady-state vowel region to avoid restarting the initial attack
    on every note (improves connected legato flow).
    """
    if len(audio) < 64:
        return audio
    n = len(audio)
    lo = int(n * 0.22)
    hi = int(n * 0.77)
    core = audio[lo:hi]
    return core if len(core) > 32 else audio


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


def _fit_duration(audio: np.ndarray, sr: int, target_sec: float, legato: bool = False) -> np.ndarray:
    """Time-stretch then crop/pad to target length."""
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
        if not legato:
            # non-legato parts: stronger note boundary
            fade_len = max(1, target_samples // 10)
            result[-fade_len:] *= np.linspace(1.0, 0.0, fade_len, dtype=np.float32)
        return result
    else:
        return np.pad(stretched, (0, target_samples - len(stretched))).astype(np.float32)


def _apply_envelope(wave: np.ndarray, sr: int, attack_s: float, release_s: float) -> np.ndarray:
    out = wave.copy()
    n = len(out)
    if n == 0:
        return out
    a = min(n, max(1, int(sr * attack_s)))
    r = min(n, max(1, int(sr * release_s)))
    out[:a] *= np.linspace(0.0, 1.0, a, dtype=np.float32)
    out[-r:] *= np.linspace(1.0, 0.0, r, dtype=np.float32)
    return out


def _crossfade_insert(
    output: np.ndarray,
    segment: np.ndarray,
    start_i: int,
    crossfade_samples: int,
) -> int:
    """
    Insert a segment using overlap crossfade to keep notes connected.
    Returns written end index.
    """
    start_i = max(0, start_i)
    if len(segment) <= 0 or start_i >= len(output):
        return start_i
    end_i = min(len(output), start_i + len(segment))
    seg = segment[: end_i - start_i]
    if len(seg) <= 0:
        return start_i

    overlap = min(crossfade_samples, len(seg))
    has_existing = np.any(np.abs(output[start_i:start_i + overlap]) > 1e-6) if overlap > 0 else False
    if has_existing and overlap > 0:
        fade_in = np.linspace(0.0, 1.0, overlap, dtype=np.float32)
        fade_out = 1.0 - fade_in
        output[start_i:start_i + overlap] = (
            output[start_i:start_i + overlap] * fade_out
            + seg[:overlap] * fade_in
        )
        output[start_i + overlap:end_i] = seg[overlap:]
    else:
        output[start_i:end_i] = seg
    return end_i


# ---------------------------------------------------------------------------
# Per-part synthesis
# ---------------------------------------------------------------------------

def _median_pitch(notes: list[dict[str, Any]]) -> float:
    if not notes:
        return 60.0
    vals = sorted(float(n["pitch"]) for n in notes)
    return vals[len(vals) // 2]


def _filter_outlier_notes(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Remove obvious random spikes/noise notes before vocal synthesis.
    Conservative so we keep real melody motion.
    """
    if not notes:
        return []

    sorted_notes = sorted(notes, key=lambda n: float(n["start_time"]))
    if len(sorted_notes) < 3:
        return [n for n in sorted_notes if float(n.get("duration", 0)) >= 0.06]

    pitches = [int(round(float(n["pitch"]))) for n in sorted_notes]
    cleaned: list[dict[str, Any]] = []
    for i, note in enumerate(sorted_notes):
        dur = float(note.get("duration", 0))
        amp = float(note.get("amplitude", 0.75))
        if dur < 0.06:
            continue
        lo = max(0, i - 4)
        hi = min(len(sorted_notes), i + 5)
        local = sorted(pitches[lo:hi])
        med = local[len(local) // 2]
        if abs(pitches[i] - med) > 10:
            # Keep very strong long notes; drop short weak outliers.
            if dur < 0.20 or amp < 0.18:
                continue
        if 0 < i < len(sorted_notes) - 1:
            prev_p = pitches[i - 1]
            next_p = pitches[i + 1]
            isolated_jump = (
                abs(pitches[i] - prev_p) >= 12
                and abs(pitches[i] - next_p) >= 12
                and abs(prev_p - next_p) <= 4
            )
            if isolated_jump and dur < 0.25:
                continue
        cleaned.append(copy.deepcopy(note))
    return cleaned


def _monophonize_lead(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Convert noisy/polyphonic transcription into a single melodic line.
    Keeps the loudest (or higher-pitch tie) note when overlaps occur.
    """
    if not notes:
        return []
    sorted_notes = sorted(notes, key=lambda n: float(n["start_time"]))
    out: list[dict[str, Any]] = []
    for n in sorted_notes:
        cur = copy.deepcopy(n)
        cur["pitch"] = int(round(float(cur["pitch"])))
        cur["start_time"] = float(cur["start_time"])
        cur["duration"] = max(0.06, float(cur["duration"]))
        cur["amplitude"] = float(cur.get("amplitude", 0.75))

        prev = out[-1] if out else None
        if not prev:
            out.append(cur)
            continue

        prev_end = prev["start_time"] + prev["duration"]
        if cur["start_time"] >= prev_end - 1e-3:
            out.append(cur)
            continue

        prev_amp = float(prev.get("amplitude", 0.75))
        cur_amp = float(cur.get("amplitude", 0.75))
        new_is_lead = cur_amp > prev_amp + 0.05 or (
            abs(cur_amp - prev_amp) <= 0.05 and cur["pitch"] > prev["pitch"]
        )
        if new_is_lead:
            trimmed = cur["start_time"] - prev["start_time"]
            if trimmed < 0.05:
                out.pop()
            else:
                prev["duration"] = trimmed
            out.append(cur)
        # else discard current note
    return out


def _merge_nearby_same_pitch(notes: list[dict[str, Any]], gap_s: float = 0.09) -> list[dict[str, Any]]:
    if not notes:
        return []
    merged = [copy.deepcopy(notes[0])]
    for n in notes[1:]:
        prev = merged[-1]
        same = int(n["pitch"]) == int(prev["pitch"])
        gap = float(n["start_time"]) - (float(prev["start_time"]) + float(prev["duration"]))
        if same and gap < gap_s:
            new_end = max(
                float(prev["start_time"]) + float(prev["duration"]),
                float(n["start_time"]) + float(n["duration"]),
            )
            prev["duration"] = new_end - float(prev["start_time"])
            prev["amplitude"] = max(float(prev.get("amplitude", 0.75)), float(n.get("amplitude", 0.75)))
        else:
            merged.append(copy.deepcopy(n))
    return merged


def _pick_voice_id(
    notes: list[dict[str, Any]],
    part_name: str | None = None,
    explicit_voice_id: str | None = None,
) -> str:
    if explicit_voice_id:
        return explicit_voice_id
    if part_name in SATB_VOICE_IDS:
        return SATB_VOICE_IDS[part_name]  # Fixed SATB preset

    # Generic melody case: low -> male, high -> female
    med = _median_pitch(notes)
    return MALE_VOICE_IDS[0] if med < 62 else FEMALE_VOICE_IDS[0]


def _synth_part(
    notes: list[dict[str, Any]],
    voice_id: str | None,
    api_key: str,
    sr: int = SAMPLE_RATE,
    part_name: str | None = None,
) -> np.ndarray:
    """
    Synthesise a single SATB part into a float32 numpy array.
    Returns an empty array if there are no notes.
    """
    filtered_notes = _filter_outlier_notes(notes)
    if part_name == "melody":
        # Make melody voice actually follow one clear pitch line.
        filtered_notes = _merge_nearby_same_pitch(_monophonize_lead(filtered_notes))
    if not filtered_notes:
        return np.array([], dtype=np.float32)
    filtered_notes = sorted(filtered_notes, key=lambda n: float(n["start_time"]))
    legato = part_name == "melody"

    chosen_voice = _pick_voice_id(filtered_notes, part_name=part_name, explicit_voice_id=voice_id)
    log.info("Fetching ElevenLabs '%s' for voice %s …", SYLLABLE, chosen_voice)
    mp3 = _elevenlabs_tts(SYLLABLE, chosen_voice, api_key)
    base = _load_mp3(mp3, sr)
    legato_base = _steady_vowel_region(base)
    source_hz = _detect_pitch(base, sr)
    log.info("  base pitch detected: %.1f Hz", source_hz)

    # Total buffer length
    last = max(filtered_notes, key=lambda n: n["start_time"] + n["duration"])
    total_sec = last["start_time"] + last["duration"] + 0.3
    output = np.zeros(int(total_sec * sr), dtype=np.float32)

    prev_end_i = 0
    crossfade_samples = int(0.08 * sr) if legato else int(0.02 * sr)

    for i, note in enumerate(filtered_notes):
        pitch     = float(note["pitch"])
        start_s   = float(note["start_time"])
        dur_s     = max(0.08, float(note["duration"]))
        amplitude = float(note.get("amplitude", 0.75))

        # Melody legato: let each note connect into the next one.
        if legato and i < len(filtered_notes) - 1:
            next_start = float(filtered_notes[i + 1]["start_time"])
            dur_s = max(dur_s, max(0.12, (next_start - start_s) + 0.10))

        source_wave = legato_base if legato else base
        shifted  = _pitch_shift(source_wave, sr, source_hz, pitch)
        fitted   = _fit_duration(shifted, sr, dur_s, legato=legato)
        if legato:
            # Tiny attack/release + crossfade placement keeps one connected phrase.
            fitted = _apply_envelope(fitted, sr, attack_s=0.006, release_s=0.012)
        fitted = fitted * amplitude

        start_i = int(start_s * sr)
        if legato and i > 0:
            # Force continuity: no silent gaps between notes.
            start_i = min(start_i, max(0, prev_end_i - crossfade_samples))

        prev_end_i = _crossfade_insert(output, fitted, start_i, crossfade_samples)

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

    for part_name, voice_id in SATB_VOICE_IDS.items():
        notes = parts.get(part_name) or []
        log.info("Synthesising %s (%d notes) …", part_name, len(notes))
        try:
            arr = _synth_part(notes, voice_id, api_key, sr, part_name=part_name)
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
