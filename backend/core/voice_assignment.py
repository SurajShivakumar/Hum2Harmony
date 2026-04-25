"""
Rule-based SATB voice assignment.

For each melody note:
  - Soprano  = the melody note itself (clamped to range)
  - Alto     = nearest chord tone below soprano, within alto range
  - Tenor    = nearest chord tone below alto, within tenor range
  - Bass     = root of the current chord in bass range

Ranges are clamped hard to avoid unsingable extremes.
"""

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

RANGES = {
    "soprano": (60, 79),  # C4 – G5
    "alto":    (55, 74),  # G3 – D5
    "tenor":   (48, 69),  # C3 – A4
    "bass":    (40, 60),  # E2 – C4
}


def midi_to_name(pitch: int) -> str:
    return f"{NOTE_NAMES[pitch % 12]}{(pitch // 12) - 1}"


def clamp(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, value))


def nearest_chord_tone(target: int, pitch_classes: list[int], voice_range: tuple[int, int]) -> int:
    """
    Find the MIDI note whose pitch class is in `pitch_classes` and whose
    absolute pitch is nearest to `target`, within [lo, hi].
    """
    lo, hi = voice_range
    candidates = [
        pc + 12 * octave
        for pc in pitch_classes
        for octave in range(0, 9)
        if lo <= pc + 12 * octave <= hi
    ]
    if not candidates:
        # Fallback: clamp target to range
        return clamp(target, lo, hi)
    return min(candidates, key=lambda p: abs(p - target))


def assign_voices(notes: list[dict], chords: list[dict]) -> dict[str, list[dict]]:
    parts: dict[str, list[dict]] = {"soprano": [], "alto": [], "tenor": [], "bass": []}

    for note in notes:
        # Find the chord active at this note's start time
        chord = chords[0]
        for c in chords:
            if c["start_time"] <= note["start_time"]:
                chord = c

        pcs = chord["pitch_classes"]
        root_pc = chord["root_pc"]

        # Soprano: melody note clamped to soprano range
        s_pitch = clamp(note["pitch"], *RANGES["soprano"])

        # Alto: nearest chord tone below soprano
        a_pitch = nearest_chord_tone(s_pitch - 5, pcs, RANGES["alto"])

        # Tenor: nearest chord tone below alto
        t_pitch = nearest_chord_tone(a_pitch - 5, pcs, RANGES["tenor"])

        # Bass: root in bass range
        b_pitch = nearest_chord_tone(root_pc + 36, [root_pc], RANGES["bass"])

        for voice, pitch in [("soprano", s_pitch), ("alto", a_pitch), ("tenor", t_pitch), ("bass", b_pitch)]:
            parts[voice].append(
                {
                    "note_name": midi_to_name(pitch),
                    "pitch": pitch,
                    "start_time": note["start_time"],
                    "duration": note["duration"],
                }
            )

    return parts
