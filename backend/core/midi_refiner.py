"""
Local MIDI refinement (no external API key required).

This module implements a deterministic cleanup pipeline:
  - monophonize overlaps
  - remove local pitch outliers
  - quantize starts/durations to musically sensible grid values
  - optional scale snap from detected key
  - merge adjacent same-pitch fragments

Output is a cleaner MIDI that is robust on restricted networks.
"""

from __future__ import annotations

import os
import tempfile
from typing import Any

import mido


# ---------------------------------------------------------------------------
# Step 1: raw notes → MIDI file
# ---------------------------------------------------------------------------

def _notes_to_midi_file(notes: list[dict[str, Any]], tempo: int) -> str:
    """
    Write a MIDI type-0 file from our note list and return its path.
    The caller is responsible for deleting the file when done.
    """
    ticks_per_beat = 480
    microseconds_per_beat = max(1, int(60_000_000 / max(1, tempo)))
    secs_per_tick = 60.0 / (tempo * ticks_per_beat)

    mid = mido.MidiFile(type=0, ticks_per_beat=ticks_per_beat)
    track = mido.MidiTrack()
    mid.tracks.append(track)

    track.append(
        mido.MetaMessage("set_tempo", tempo=microseconds_per_beat, time=0)
    )

    # Build flat (tick, type, pitch, velocity) event list.
    events: list[tuple[int, str, int, int]] = []
    for n in notes:
        pitch    = max(0, min(127, int(round(n["pitch"]))))
        velocity = max(1, min(127, int(round(n.get("amplitude", 0.75) * 100))))
        start    = max(0, int(round(n["start_time"] / secs_per_tick)))
        dur      = max(1, int(round(n["duration"]   / secs_per_tick)))
        events.append((start,       "note_on",  pitch, velocity))
        events.append((start + dur, "note_off", pitch, 0))

    # Sort: by tick, then note_off before note_on at the same tick.
    events.sort(key=lambda e: (e[0], 0 if e[1] == "note_off" else 1))

    current_tick = 0
    for tick, msg_type, pitch, vel in events:
        delta = tick - current_tick
        track.append(
            mido.Message(msg_type, note=pitch, velocity=vel, time=delta)
        )
        current_tick = tick

    tmp = tempfile.NamedTemporaryFile(suffix=".mid", delete=False)
    mid.save(tmp.name)
    tmp.close()
    return tmp.name


def notes_to_midi_bytes(notes: list[dict[str, Any]], tempo: int = 120) -> bytes:
    """
    Build a plain local MIDI from note events (no external API call).
    Used as a fallback when MusicLang is unavailable.
    """
    path = _notes_to_midi_file(notes, tempo)
    try:
        with open(path, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
ROOT_MAP = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3,
    "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8,
    "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11,
}
MAJOR = [0, 2, 4, 5, 7, 9, 11]
MINOR = [0, 2, 3, 5, 7, 8, 10]
STANDARD_BEATS = [4, 2, 1, 0.5, 0.25]


def _midi_to_name(midi_num: int) -> str:
    m = max(0, min(127, int(round(midi_num))))
    return f"{NOTE_NAMES[m % 12]}{(m // 12) - 1}"


def _snap_duration(dur_sec: float, beat_sec: float) -> float:
    beats = dur_sec / beat_sec
    best = min(STANDARD_BEATS, key=lambda b: abs(b - beats))
    return best * beat_sec


def _parse_scale(key_name: str | None, key_mode: str | None) -> list[int] | None:
    if not key_name:
        return None
    root = ROOT_MAP.get(key_name.strip())
    if root is None:
        return None
    intervals = MINOR if (key_mode or "").lower().startswith("min") else MAJOR
    return [(root + i) % 12 for i in intervals]


def _snap_pitch_to_scale(pitch: int, scale_pcs: list[int]) -> int:
    pc = pitch % 12
    best_pc = min(scale_pcs, key=lambda s: min(abs(s - pc), 12 - abs(s - pc)))
    diff = best_pc - pc
    if diff > 6:
        diff -= 12
    if diff < -6:
        diff += 12
    return pitch + diff


def _monophonize(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not notes:
        return []
    sorted_notes = sorted(notes, key=lambda n: n["start_time"])
    out: list[dict[str, Any]] = []
    for n in sorted_notes:
        cur = dict(n)
        cur["pitch"] = int(round(cur["pitch"]))
        cur["duration"] = max(0.04, float(cur["duration"]))
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
            if trimmed < 0.04:
                out.pop()
            else:
                prev["duration"] = trimmed
            out.append(cur)
    return out


def _remove_pitch_outliers(notes: list[dict[str, Any]], window_half: int = 4, max_dev: int = 9) -> list[dict[str, Any]]:
    if len(notes) < 3:
        return notes
    pitches = [int(n["pitch"]) for n in notes]
    kept: list[dict[str, Any]] = []
    for i, n in enumerate(notes):
        lo = max(0, i - window_half)
        hi = min(len(notes), i + window_half + 1)
        med = sorted(pitches[lo:hi])[len(pitches[lo:hi]) // 2]
        if abs(pitches[i] - med) <= max_dev:
            kept.append(n)
    return kept if kept else notes


def _merge_same_pitch(notes: list[dict[str, Any]], sixteenth: float, beat_sec: float) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for n in notes:
        prev = out[-1] if out else None
        if prev and prev["pitch"] == n["pitch"]:
            gap = n["start_time"] - (prev["start_time"] + prev["duration"])
            if gap < sixteenth * 0.5:
                combined = n["start_time"] + n["duration"] - prev["start_time"]
                snapped = _snap_duration(combined, beat_sec)
                if abs(snapped - combined) <= sixteenth * 0.55:
                    prev["duration"] = snapped
                    continue
        out.append(dict(n))
    return out


def refine_midi(
    notes: list[dict[str, Any]],
    tempo: int = 120,
    key_name: str | None = None,
    key_mode: str | None = None,
) -> bytes:
    """
    Refine a note list locally and return MIDI bytes.
    No network or API key required.
    """
    if not notes:
        return notes_to_midi_bytes([], tempo)

    bpm = max(60, min(200, int(round(tempo / 5) * 5)))
    beat_sec = 60.0 / bpm
    sixteenth = beat_sec / 4
    scale = _parse_scale(key_name, key_mode)

    out = _monophonize(notes)
    out = _remove_pitch_outliers(out)

    # Quantize start/duration, snap pitch, and scale-snap
    quantized: list[dict[str, Any]] = []
    for n in out:
        pitch = int(round(n["pitch"]))
        if scale:
            pitch = _snap_pitch_to_scale(pitch, scale)
        start_q = round(float(n["start_time"]) / sixteenth) * sixteenth
        dur_q = max(sixteenth * 0.5, _snap_duration(float(n["duration"]), beat_sec))
        quantized.append({
            "pitch": pitch,
            "start_time": max(0.0, start_q),
            "duration": dur_q,
            "amplitude": float(n.get("amplitude", 0.75)),
            "note_name": _midi_to_name(pitch),
        })

    quantized.sort(key=lambda x: x["start_time"])
    merged = _merge_same_pitch(quantized, sixteenth, beat_sec)

    # Resolve overlaps conservatively
    cleaned: list[dict[str, Any]] = []
    for n in merged:
        prev = cleaned[-1] if cleaned else None
        if prev:
            prev_end = prev["start_time"] + prev["duration"]
            if n["start_time"] < prev_end - 1e-3:
                trimmed = _snap_duration(n["start_time"] - prev["start_time"], beat_sec)
                if trimmed < sixteenth * 0.5:
                    cleaned.pop()
                else:
                    prev["duration"] = trimmed
        cleaned.append(dict(n))

    return notes_to_midi_bytes(cleaned, bpm)
