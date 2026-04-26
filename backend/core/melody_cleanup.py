"""Melody-level cleanup for arrangement and playback.

The transcription engines give us timings from the audio, but they can also emit
brief octave harmonics or chromatic blips. This module keeps the original note
placement while making the melody more suitable for harmony generation.
"""

from __future__ import annotations

from statistics import median

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
ROOT_MAP = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3,
    "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8,
    "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11,
}
MAJOR = [0, 2, 4, 5, 7, 9, 11]
MINOR = [0, 2, 3, 5, 7, 8, 10]


def midi_to_name(pitch: int) -> str:
    p = max(0, min(127, int(round(pitch))))
    return f"{NOTE_NAMES[p % 12]}{(p // 12) - 1}"


def _scale_pcs(key_name: str | None, key_mode: str | None) -> set[int] | None:
    if not key_name:
        return None
    root = ROOT_MAP.get(key_name.strip())
    if root is None:
        return None
    intervals = MINOR if (key_mode or "").lower().startswith("min") else MAJOR
    return {(root + interval) % 12 for interval in intervals}


def _nearest_scale_pitch(pitch: int, scale_pcs: set[int], target: float | None = None) -> int:
    center = pitch if target is None else target
    candidates = [
        pc + (12 * octave)
        for pc in scale_pcs
        for octave in range(0, 11)
        if 0 <= pc + (12 * octave) <= 127
    ]
    return min(candidates, key=lambda p: (abs(p - pitch), abs(p - center)))


def _is_supported_chromatic_passing(prev_pitch: int, pitch: int, next_pitch: int) -> bool:
    """Allow an intentional-looking chromatic neighbor/passing tone."""
    step_in = pitch - prev_pitch
    step_out = next_pitch - pitch
    same_direction = (step_in > 0 and step_out > 0) or (step_in < 0 and step_out < 0)
    neighbor = abs(step_in) <= 2 and abs(step_out) <= 2
    return same_direction and neighbor


def _is_octave_move(a: int, b: int) -> bool:
    distance = abs(int(a) - int(b))
    return distance >= 12 and distance % 12 == 0


def _merge_or_drop_strays(notes: list[dict], tempo: int) -> list[dict]:
    if len(notes) < 2:
        return notes

    beat_sec = 60.0 / max(1, tempo)
    min_clear_duration = beat_sec * 0.25
    max_stutter_gap = beat_sec * 0.25
    out: list[dict] = []

    for note in notes:
        cur = dict(note)
        cur["pitch"] = int(round(cur["pitch"]))
        cur["duration"] = max(0.01, float(cur["duration"]))
        cur["end_time"] = float(cur["start_time"]) + cur["duration"]

        prev = out[-1] if out else None
        if not prev:
            out.append(cur)
            continue

        prev_end = float(prev["start_time"]) + float(prev["duration"])
        gap = float(cur["start_time"]) - prev_end
        same_or_neighbor = abs(int(prev["pitch"]) - int(cur["pitch"])) <= 1
        octave_move = _is_octave_move(int(prev["pitch"]), int(cur["pitch"]))
        short_note = cur["duration"] < min_clear_duration

        if same_or_neighbor and gap <= max_stutter_gap:
            new_end = max(prev_end, float(cur["end_time"]))
            prev["duration"] = round(new_end - float(prev["start_time"]), 4)
            prev["end_time"] = round(new_end, 4)
            if cur.get("amplitude", 0) > prev.get("amplitude", 0):
                prev["pitch"] = cur["pitch"]
                prev["note_name"] = midi_to_name(cur["pitch"])
            continue

        if short_note and len(out) >= 1:
            next_like_prev = False
            # Let the next pass merge around this if the surrounding note is
            # clearly more stable than the blip.
            if (
                gap <= max_stutter_gap
                and abs(int(prev["pitch"]) - int(cur["pitch"])) >= 4
                and not octave_move
            ):
                next_like_prev = True
            if next_like_prev:
                prev["duration"] = round(max(prev_end, float(cur["end_time"])) - float(prev["start_time"]), 4)
                prev["end_time"] = round(float(prev["start_time"]) + float(prev["duration"]), 4)
                continue

        out.append(cur)

    return out


def simplify_lead_for_export(
    notes: list[dict],
    key_name: str | None,
    key_mode: str | None,
    tempo: int,
) -> list[dict]:
    """Produce a simpler monophonic lead for arrangement MIDI export."""
    cleaned = clean_melody_notes(notes, key_name, key_mode, tempo)
    if len(cleaned) < 2:
        return cleaned

    # A second cleanup after scale snapping catches tiny neighbor/stutter notes
    # that should sound like one sustained melody tone in the exported MIDI.
    cleaned = _merge_or_drop_strays(cleaned, tempo)

    # Keep the lead in a single vocal register so score importers do not split
    # it into piano-style upper/lower staves.
    pitches = [int(round(n["pitch"])) for n in cleaned]
    center = float(median(pitches))
    out: list[dict] = []
    for note in cleaned:
        pitch = int(round(note["pitch"]))
        while pitch - center > 9:
            pitch -= 12
        while center - pitch > 9:
            pitch += 12
        out.append({**note, "pitch": pitch, "note_name": midi_to_name(pitch)})

    return _merge_or_drop_strays(out, tempo)


def clean_melody_notes(
    notes: list[dict],
    key_name: str | None,
    key_mode: str | None,
    tempo: int,
) -> list[dict]:
    """
    Remove isolated harmonic spikes and snap unsupported chromatic notes to key.

    Timing is intentionally preserved: starts, gaps, and durations still come
    from the audio transcription so the arrangement follows the recording.
    """
    if len(notes) < 2:
        return [dict(n) for n in notes]

    sorted_notes = sorted((dict(n) for n in notes), key=lambda n: float(n["start_time"]))
    pitches = [int(round(n["pitch"])) for n in sorted_notes]
    global_median = float(median(pitches))
    beat_sec = 60.0 / max(1, tempo)

    cleaned: list[dict] = []
    for i, note in enumerate(sorted_notes):
        pitch = int(round(note["pitch"]))
        lo = max(0, i - 4)
        hi = min(len(sorted_notes), i + 5)
        neighbor_pitches = [
            int(round(sorted_notes[j]["pitch"]))
            for j in range(lo, hi)
            if j != i
        ]

        if neighbor_pitches:
            local_median = float(median(neighbor_pitches))
            nearest_neighbor = min(abs(pitch - p) for p in neighbor_pitches)
            duration = float(note.get("duration", 0.0))
            octave_related = any(_is_octave_move(pitch, p) for p in neighbor_pitches)
            isolated_jump = (
                abs(pitch - local_median) >= 17
                and nearest_neighbor >= 12
                and not octave_related
            )
            very_far_from_song = abs(pitch - global_median) >= 24
            if isolated_jump and (very_far_from_song or duration <= beat_sec * 0.6):
                continue

            # Common octave-error case: same melodic shape, clearly wrong octave.
            # Leave moderate jumps alone so intentional low/high notes survive.
            while pitch - local_median > 17:
                pitch -= 12
            while local_median - pitch > 17:
                pitch += 12

        note["pitch"] = pitch
        note["note_name"] = midi_to_name(pitch)
        cleaned.append(note)

    scale = _scale_pcs(key_name, key_mode)
    if not scale:
        return cleaned

    corrected: list[dict] = []
    for i, note in enumerate(cleaned):
        pitch = int(round(note["pitch"]))
        if pitch % 12 in scale:
            corrected.append({**note, "pitch": pitch, "note_name": midi_to_name(pitch)})
            continue

        prev_pitch = int(round(cleaned[i - 1]["pitch"])) if i > 0 else None
        next_pitch = int(round(cleaned[i + 1]["pitch"])) if i + 1 < len(cleaned) else None
        supported_passing = (
            prev_pitch is not None
            and next_pitch is not None
            and _is_supported_chromatic_passing(prev_pitch, pitch, next_pitch)
            and float(note.get("duration", 0.0)) <= beat_sec * 0.75
        )
        if supported_passing:
            corrected.append({**note, "pitch": pitch, "note_name": midi_to_name(pitch)})
            continue

        local_target = None
        if prev_pitch is not None and next_pitch is not None:
            local_target = (prev_pitch + next_pitch) / 2
        snapped = _nearest_scale_pitch(pitch, scale, local_target)
        corrected.append({**note, "pitch": snapped, "note_name": midi_to_name(snapped)})

    return _merge_or_drop_strays(corrected, tempo)
