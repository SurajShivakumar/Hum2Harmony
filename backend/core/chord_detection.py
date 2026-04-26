"""
Phrase-aware chord detection with cadence-aware scoring.

Chords are placed only over active melody spans. Within each phrase, chord
changes happen at musically meaningful note transitions instead of every fixed
measure, so the arrangement can contain rests, short entries, and sustained
harmonies based on the melody's actual motion.
"""

KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Scale intervals for major and natural minor
_MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]


def build_diatonic_chords(root_pc: int, mode: str) -> list[dict]:
    """Return all 7 diatonic triads for the given key with degree labels."""
    scale = _MAJOR_SCALE if mode == "major" else _MINOR_SCALE
    chords = []
    quality_major = ["", "m", "m", "", "", "m", "dim"]
    quality_minor = ["m", "dim", "", "m", "m", "", ""]
    for i, interval in enumerate(scale):
        r = (root_pc + interval) % 12
        # Build true diatonic triads from scale degrees
        third = (root_pc + scale[(i + 2) % 7]) % 12
        fifth = (root_pc + scale[(i + 4) % 7]) % 12
        suffix = quality_major[i] if mode == "major" else quality_minor[i]
        chord_name = f"{KEY_NAMES[r]}{suffix}".replace("mdim", "dim")
        chords.append(
            {
                "name": chord_name,
                "root_pc": r,
                "pitch_classes": [r, third, fifth],
                "degree": i + 1,
            }
        )
    return chords


def detect_chords(
    notes: list[dict], tempo: int, key_root: str, key_mode: str
) -> list[dict]:
    """
    Segment melody by phrase and significant note transitions, then score
    candidate diatonic chords using:
      1) weighted pitch-class coverage in the segment
      2) end-note cadence fit
      3) smooth root motion from previous chord
    """
    if not notes:
        return []

    notes = sorted(notes, key=lambda n: float(n["start_time"]))
    beat_dur = 60.0 / max(tempo, 1)
    measure_dur = beat_dur * 4
    key_root_pc = KEY_NAMES.index(key_root)
    diatonic = build_diatonic_chords(key_root_pc, key_mode)
    chords: list[dict] = []

    gap_break = beat_dur * 0.75
    min_segment = beat_dur * 0.5
    max_segment = beat_dur * 2.0

    phrases: list[list[dict]] = []
    current: list[dict] = []
    for note in notes:
        if current:
            prev = current[-1]
            prev_end = float(prev["end_time"])
            if float(note["start_time"]) - prev_end >= gap_break:
                phrases.append(current)
                current = []
        current.append(note)
    if current:
        phrases.append(current)

    def score_segment(seg_notes: list[dict], start: float, end: float) -> dict:
        cadence_window = min(beat_dur, max(0.05, end - start))

        pitch_weights = [0.0] * 12
        for n in seg_notes:
            overlap = max(
                0.0,
                min(end, float(n["end_time"])) - max(start, float(n["start_time"])),
            )
            pitch_weights[int(n["pitch"]) % 12] += overlap

        # Cadence notes near the segment ending influence the chosen chord.
        cadence_notes = [
            n for n in seg_notes if float(n["end_time"]) >= (end - cadence_window)
        ]
        cadence_pcs = [int(n["pitch"]) % 12 for n in cadence_notes]

        end_note_pc = None
        if seg_notes:
            # Note ending closest to the segment boundary gets cadence priority.
            end_note = min(
                seg_notes,
                key=lambda n: abs(float(n["end_time"]) - end),
            )
            end_note_pc = int(end_note["pitch"]) % 12

        best = diatonic[0]
        best_score = -1.0
        for chord in diatonic:
            coverage = sum(pitch_weights[pc % 12] for pc in chord["pitch_classes"])
            endnote_bonus = 0.0
            cadence_bonus = 0.0
            if end_note_pc is not None:
                if end_note_pc in chord["pitch_classes"]:
                    endnote_bonus += 3.0
                if end_note_pc == chord["root_pc"]:
                    endnote_bonus += 1.5
            if cadence_pcs:
                hits = sum(1 for pc in cadence_pcs if pc in chord["pitch_classes"])
                cadence_bonus += (hits / len(cadence_pcs)) * 2.5

            smoothness_bonus = 0.0
            if chords:
                prev_root = chords[-1]["root_pc"]
                dist = min(
                    abs(chord["root_pc"] - prev_root),
                    12 - abs(chord["root_pc"] - prev_root),
                )
                smoothness_bonus = max(0.0, 1.0 - (dist / 6.0))

            # Slight preference for I, IV, V in ambiguous contexts.
            function_bonus = 0.4 if chord["degree"] in (1, 4, 5) else 0.0

            score = coverage + endnote_bonus + cadence_bonus + smoothness_bonus + function_bonus
            if score > best_score:
                best_score, best = score, chord

        return {
            "start_time": round(start, 4),
            "end_time": round(end, 4),
            "chord_name": best["name"],
            "root_pc": best["root_pc"],
            "pitch_classes": best["pitch_classes"],
        }

    for phrase in phrases:
        phrase_start = float(phrase[0]["start_time"])
        phrase_end = max(float(n["end_time"]) for n in phrase)
        boundaries = [phrase_start]
        segment_start = phrase_start
        anchor_pitch = int(phrase[0]["pitch"])

        for prev, cur in zip(phrase, phrase[1:]):
            cur_start = float(cur["start_time"])
            elapsed = cur_start - segment_start
            interval = abs(int(cur["pitch"]) - anchor_pitch)
            crossed_measure = int(segment_start / measure_dur) != int(cur_start / measure_dur)

            if elapsed >= min_segment and (
                elapsed >= max_segment
                or interval >= 5
                or crossed_measure
            ):
                boundaries.append(cur_start)
                segment_start = cur_start
                anchor_pitch = int(cur["pitch"])

        boundaries.append(phrase_end)

        for start, end in zip(boundaries, boundaries[1:]):
            if end - start < 0.05:
                continue
            seg_notes = [
                n for n in phrase
                if float(n["start_time"]) < end and float(n["end_time"]) > start
            ]
            if seg_notes:
                chords.append(score_segment(seg_notes, start, end))

    if chords:
        tonic = diatonic[0]
        # Harmonic grammar: tonic at beginning/end, without stretching across rests.
        chords[0] = {**chords[0], **tonic, "chord_name": tonic["name"]}
        chords[-1] = {**chords[-1], **tonic, "chord_name": tonic["name"]}

    return chords
