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
import re
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

_NOTE_LETTERS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _note_label(midi: int) -> str:
    m = int(max(0, min(127, midi)))
    return f"{_NOTE_LETTERS[m % 12]}{(m // 12) - 1}"


# How tightly to follow the written duration before hard-truncating.
MAX_STRETCH_RATIO = 2.5
MIN_STRETCH_RATIO = 0.4
SYLLABLE = "ahhh"

# ---------------------------------------------------------------------------
# ElevenLabs TTS
# ---------------------------------------------------------------------------

def _elevenlabs_tts(
    text: str,
    voice_id: str,
    api_key: str,
    *,
    singing: bool = False,
) -> bytes:
    """Return raw MP3 bytes from ElevenLabs for the given text + voice."""
    import requests  # soft import — only paid when needed

    # Never prepend “instructions” to the string — the model will read them aloud.
    # For a slightly more musical delivery, only adjust voice_settings when singing=True.
    out_text = text.strip()

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
    headers = {
        "xi-api-key": api_key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    # Slightly more expressive / less flat when we want a sung line.
    if singing:
        voice_settings = {
            "stability": 0.50,
            "similarity_boost": 0.78,
            "style": 0.50,
            "use_speaker_boost": True,
        }
        model_id = "eleven_multilingual_v2"
    else:
        voice_settings = {
            "stability": 0.82,
            "similarity_boost": 0.90,
            "style": 0.0,
            "use_speaker_boost": True,
        }
        model_id = "eleven_multilingual_v2"

    payload = {
        "text": out_text,
        "model_id": model_id,
        "voice_settings": voice_settings,
    }
    resp = requests.post(url, json=payload, headers=headers, timeout=60)
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
    return _pitch_shift_toward_midi(audio, sr, source_hz, target_midi, max_semitones=96.0)


def _pitch_shift_toward_midi(
    audio: np.ndarray,
    sr: int,
    source_hz: float,
    target_midi: float,
    max_semitones: float,
) -> np.ndarray:
    """Nudge pitch toward `target_midi` but cap by `max_semitones` (keeps TTS natural when small)."""
    import librosa
    target_hz = _midi_to_hz(target_midi)
    n_steps = 12.0 * np.log2(target_hz / max(source_hz, 1.0))
    n_steps = max(-max_semitones, min(max_semitones, n_steps))
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


_VOWELS = "aeiouyAEIOUY"


def _split_word_to_syllables(word: str) -> list[str]:
    if not word or len(word) < 2:
        return [word] if word else []
    groups: list[tuple[int, int]] = []
    i = 0
    while i < len(word):
        if word[i] not in _VOWELS:
            i += 1
            continue
        a = i
        while i < len(word) and word[i] in _VOWELS:
            i += 1
        groups.append((a, i))
    if len(groups) <= 1:
        return [word]
    out: list[str] = []
    s0 = 0
    for g, (_a, b) in enumerate(groups[:-1]):
        na = groups[g + 1][0]
        cut = na - 1 if (na - b) > 1 else b
        if cut > s0:
            out.append(word[s0:cut])
            s0 = cut
    if s0 < len(word):
        out.append(word[s0:])
    return [x for x in out if x]


def split_lyrics_into_syllable_tokens(lyrics: str) -> list[str]:
    """Chips suitable for one TTS call per singing step."""
    words = re.findall(r"[A-Za-z0-9']+", lyrics)
    tokens: list[str] = []
    for w in words:
        tokens.extend(_split_word_to_syllables(w))
    return [t for t in tokens if t.strip()]


def build_simple_sung_melody(
    n_notes: int,
    bpm: int = 96,
) -> list[dict[str, Any]]:
    """One mild contour per syllable; timing from BPM (singing line, not speaking)."""
    bpm = max(60, min(180, bpm))
    beat = 60.0 / bpm
    step = beat * 0.48
    gap = 0.018
    # Mid / “regular voice” range (~E3–D4), not C4+ which reads bright after pitch-shift.
    pattern = [52, 54, 55, 57, 55, 54, 52, 55, 57, 55, 54, 52, 55, 54]
    out: list[dict[str, Any]] = []
    t = 0.0
    for i in range(n_notes):
        pitch = pattern[i % len(pattern)]
        dur = max(0.14, min(0.52, float(step)))
        out.append(
            {
                "pitch": pitch,
                "start_time": round(t, 4),
                "duration": round(dur, 4),
                "note_name": _note_label(pitch),
                "amplitude": 0.82,
            }
        )
        t += dur + gap
    return out


def _synth_part(
    notes: list[dict[str, Any]],
    voice_id: str | None,
    api_key: str,
    sr: int = SAMPLE_RATE,
    part_name: str | None = None,
    syllable_texts: list[str] | None = None,
) -> np.ndarray:
    """
    Synthesise a single SATB part into a float32 numpy array.
    Returns an empty array if there are no notes.

    If syllable_texts is set (same length as notes, melody part), fetches TTS for each
    token and pitch-shifts to the note (true “sings the words” path).
    """
    syllable_mode = (
        part_name == "melody"
        and syllable_texts
        and len(notes) > 0
        and len(syllable_texts) == len(notes)
    )

    if syllable_mode:
        raw = sorted(notes, key=lambda n: float(n["start_time"]))
        filtered_notes = [copy.deepcopy(n) for n in raw]
    else:
        filtered_notes = _filter_outlier_notes(notes)
        if part_name == "melody":
            filtered_notes = _merge_nearby_same_pitch(_monophonize_lead(filtered_notes))

    if not filtered_notes:
        return np.array([], dtype=np.float32)
    filtered_notes = sorted(filtered_notes, key=lambda n: float(n["start_time"]))
    legato = part_name == "melody" and not syllable_mode

    chosen_voice = _pick_voice_id(filtered_notes, part_name=part_name, explicit_voice_id=voice_id)

    base: np.ndarray | None = None
    legato_base: np.ndarray | None = None
    source_hz_global = 220.0

    if not syllable_mode:
        log.info("Fetching ElevenLabs '%s' for voice %s …", SYLLABLE, chosen_voice)
        mp3 = _elevenlabs_tts(SYLLABLE, chosen_voice, api_key)
        base = _load_mp3(mp3, sr)
        legato_base = _steady_vowel_region(base)
        source_hz_global = _detect_pitch(base, sr)
        log.info("  base pitch detected: %.1f Hz", source_hz_global)

    # Total buffer length
    last = max(filtered_notes, key=lambda n: n["start_time"] + n["duration"])
    total_sec = last["start_time"] + last["duration"] + 0.3
    output = np.zeros(int(total_sec * sr), dtype=np.float32)

    prev_end_i = 0
    crossfade_samples = int(0.07 * sr) if legato else (int(0.045 * sr) if syllable_mode else int(0.02 * sr))

    for i, note in enumerate(filtered_notes):
        pitch     = float(note["pitch"])
        start_s   = float(note["start_time"])
        dur_s     = max(0.08, float(note["duration"]))
        amplitude = float(note.get("amplitude", 0.75))

        if syllable_mode:
            token = (syllable_texts[i] or "la").strip() or "la"
            token = token[:120]
            log.info("Text-sing syllable TTS: %r", token[:40])
            mp3_s = _elevenlabs_tts(token, chosen_voice, api_key, singing=False)
            base_i = _load_mp3(mp3_s, sr)
            source_hz = _detect_pitch(base_i, sr)
            # Short syllables: bad F0 → huge shifts and chipmunk highs; keep in speech range.
            source_hz = float(max(95.0, min(320.0, source_hz)))
            source_wave = base_i
            if syllable_mode and i < len(filtered_notes) - 1:
                next_s = float(filtered_notes[i + 1]["start_time"])
                slot = max(0.06, next_s - start_s)
                dur_s = min(dur_s, max(0.1, slot * 0.97))
        else:
            # Melody legato: let each note connect into the next one.
            if legato and i < len(filtered_notes) - 1:
                next_start = float(filtered_notes[i + 1]["start_time"])
                dur_s = max(dur_s, max(0.12, (next_start - start_s) + 0.10))
            assert legato_base is not None and base is not None
            source_wave = legato_base if legato else base
            source_hz = source_hz_global

        if syllable_mode:
            # Light correction toward the grid — stays close to the natural TTS timbre.
            shifted = _pitch_shift_toward_midi(
                source_wave, sr, source_hz, pitch, max_semitones=5.5
            )
        else:
            shifted = _pitch_shift(source_wave, sr, source_hz, pitch)
        fit_leg = legato and not syllable_mode
        fitted   = _fit_duration(shifted, sr, dur_s, legato=fit_leg)
        if legato and not syllable_mode:
            fitted = _apply_envelope(fitted, sr, attack_s=0.006, release_s=0.012)
        elif syllable_mode:
            fitted = _apply_envelope(fitted, sr, attack_s=0.004, release_s=0.02)
        fitted = fitted * amplitude

        start_i = int(start_s * sr)
        if legato and not syllable_mode and i > 0:
            start_i = min(start_i, max(0, prev_end_i - crossfade_samples))

        prev_end_i = _crossfade_insert(output, fitted, start_i, crossfade_samples)

    peak = np.max(np.abs(output))
    if peak > 0.9:
        output = output * (0.9 / peak)

    return output


def synthesize_sung_text_line(
    lyrics: str,
    api_key: str,
    bpm: int = 96,
) -> tuple[bytes, list[dict[str, Any]]]:
    """
    Build a simple diatonic-ish line and render each syllable with TTS, then
    pitch-correct to match the score — this is the closest we get to "singing"
    without a dedicated singing model: real words, musical rhythm and contour.
    """
    toks = split_lyrics_into_syllable_tokens(lyrics)
    if not toks:
        raise ValueError("No words to sing")
    max_tok = 40
    if len(toks) > max_tok:
        toks = toks[:max_tok]
        log.warning("Singing only first %d syllables (line too long for one pass).", max_tok)
    mel = build_simple_sung_melody(len(toks), bpm=bpm)
    if len(mel) != len(toks):
        raise RuntimeError("internal: melody / syllable mismatch")
    # Fixed mid/tenor voice so the “sung line” doesn’t default to a high bright timbre.
    arr = _synth_part(
        mel,
        MALE_VOICE_IDS[0],
        api_key,
        SAMPLE_RATE,
        part_name="melody",
        syllable_texts=toks,
    )
    return _to_wav_bytes(arr, SAMPLE_RATE), mel


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
