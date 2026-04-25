"""
Diatonic chord detection via measure-level pitch-class segmentation.

Divides the melody into measure-length windows, tallies weighted pitch classes,
and scores each candidate diatonic chord by how much of its pitch classes appear.
Applies a simple harmonic grammar: first and last measures are forced to tonic (I).
"""

KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Scale intervals for major and natural minor
_MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]


def build_diatonic_chords(root_pc: int, mode: str) -> list[dict]:
    """Return the 5 primary diatonic triads for the given key."""
    scale = _MAJOR_SCALE if mode == "major" else _MINOR_SCALE
    chords = []
    for interval in scale[:5]:  # I ii iii IV V (only first 5 degrees used)
        r = (root_pc + interval) % 12
        # Major-key thirds: 4 semitones; minor-key thirds vary but simplified here
        third = (r + 4) % 12 if mode == "major" else (r + 3) % 12
        fifth = (r + 7) % 12
        chords.append(
            {
                "name": KEY_NAMES[r],
                "root_pc": r,
                "pitch_classes": [r, third, fifth],
            }
        )
    return chords


def detect_chords(
    notes: list[dict], tempo: int, key_root: str, key_mode: str
) -> list[dict]:
    """
    Segment the melody by measure, pick the best-fitting diatonic chord per
    measure, then enforce I at start and end.
    """
    if not notes:
        return []

    beat_dur = 60.0 / max(tempo, 1)
    measure_dur = beat_dur * 4
    total_time = notes[-1]["end_time"]
    num_measures = max(1, round(total_time / measure_dur))

    key_root_pc = KEY_NAMES.index(key_root)
    diatonic = build_diatonic_chords(key_root_pc, key_mode)

    chords: list[dict] = []

    for m in range(num_measures):
        start = m * measure_dur
        end = (m + 1) * measure_dur

        seg_notes = [n for n in notes if start <= n["start_time"] < end]

        pitch_weights = [0.0] * 12
        for n in seg_notes:
            pitch_weights[n["pitch"] % 12] += n["duration"]

        best = diatonic[0]
        best_score = -1.0
        for chord in diatonic:
            score = sum(pitch_weights[pc % 12] for pc in chord["pitch_classes"])
            if score > best_score:
                best_score, best = score, chord

        chords.append(
            {
                "start_time": start,
                "end_time": end,
                "chord_name": best["name"],
                "root_pc": best["root_pc"],
                "pitch_classes": best["pitch_classes"],
            }
        )

    # Harmonic grammar: anchor on tonic
    tonic = diatonic[0]
    chords[0] = {**chords[0], **tonic, "start_time": 0.0, "end_time": measure_dur}
    chords[-1] = {**chords[-1], **tonic}

    return chords
