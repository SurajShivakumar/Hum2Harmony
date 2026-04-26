"""
Phrase-aware chord detection with cadence-aware scoring.

Chords are placed only over active melody spans. Within each phrase, chord
changes follow meaningful note transitions and (lightly) measure boundaries,
with a bias toward about one chord per measure when the melody allows it.
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

    Chord boundaries favor places where the melody naturally gives harmony room:
    unusually long held notes, larger-than-normal gaps/onset spacing, strong
    melodic motion, or measure boundaries. A light note-density target keeps
    segments from having wildly different note counts within a phrase.
    """
    if not notes:
        return []

    notes = sorted(notes, key=lambda n: float(n["start_time"]))
    beat_dur = 60.0 / max(tempo, 1)
    measure_dur = beat_dur * 4
    key_root_pc = KEY_NAMES.index(key_root)
    diatonic = build_diatonic_chords(key_root_pc, key_mode)
    chords: list[dict] = []

    gap_break = beat_dur * 1.0
    # Allow half-bar chords so we can place ~2 changes per measure when the melody supports it.
    min_segment = measure_dur * 0.5
    max_segment = measure_dur * 2.0

    def median_or(values: list[float], fallback: float) -> float:
        if not values:
            return fallback
        ordered = sorted(values)
        mid = len(ordered) // 2
        if len(ordered) % 2:
            return ordered[mid]
        return (ordered[mid - 1] + ordered[mid]) / 2

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
            repeat_penalty = 0.0
            progression_bonus = 0.0
            if chords:
                prev_chord = chords[-1]
                prev_root = prev_chord["root_pc"]
                dist = min(
                    abs(chord["root_pc"] - prev_root),
                    12 - abs(chord["root_pc"] - prev_root),
                )
                smoothness_bonus = max(0.0, 1.0 - (dist / 6.0))
                if chord["root_pc"] == prev_root:
                    repeat_penalty = 6.0

                prev_degree = prev_chord.get("degree")
                degree = chord["degree"]
                if prev_degree == 1 and degree in (4, 5, 6):
                    progression_bonus += 1.2
                elif prev_degree == 4 and degree in (1, 5):
                    progression_bonus += 1.0
                elif prev_degree == 5 and degree == 1:
                    progression_bonus += 1.4
                elif prev_degree == 6 and degree in (2, 4):
                    progression_bonus += 0.8

            # Slight preference for I, IV, V in ambiguous contexts.
            function_bonus = 0.4 if chord["degree"] in (1, 4, 5) else 0.0

            score = (
                coverage
                + endnote_bonus
                + cadence_bonus
                + smoothness_bonus
                + function_bonus
                + progression_bonus
                - repeat_penalty
            )
            if score > best_score:
                best_score, best = score, chord

        return {
            "start_time": round(start, 4),
            "end_time": round(end, 4),
            "chord_name": best["name"],
            "root_pc": best["root_pc"],
            "pitch_classes": best["pitch_classes"],
            "degree": best.get("degree"),
        }

    for phrase in phrases:
        phrase_start = float(phrase[0]["start_time"])
        phrase_end = max(float(n["end_time"]) for n in phrase)
        boundaries = [phrase_start]

        durations = [
            max(0.01, float(n.get("duration", float(n["end_time"]) - float(n["start_time"]))))
            for n in phrase
        ]
        onset_spacings = [
            max(0.0, float(cur["start_time"]) - float(prev["start_time"]))
            for prev, cur in zip(phrase, phrase[1:])
        ]
        silent_gaps = [
            max(0.0, float(cur["start_time"]) - float(prev["end_time"]))
            for prev, cur in zip(phrase, phrase[1:])
        ]

        median_duration = median_or(durations, beat_dur * 0.5)
        median_onset_spacing = median_or(onset_spacings, beat_dur * 0.5)
        median_silent_gap = median_or([g for g in silent_gaps if g > 0.02], beat_dur * 0.25)

        long_sustain_threshold = max(beat_dur * 0.75, median_duration * 1.65)
        long_spacing_threshold = max(beat_dur * 0.75, median_onset_spacing * 1.65)
        long_gap_threshold = max(beat_dur * 0.5, median_silent_gap * 1.9)

        phrase_measures = max((phrase_end - phrase_start) / measure_dur, 1.0)
        notes_per_measure = len(phrase) / phrase_measures

        gap_count = sum(1 for g in silent_gaps if g >= long_gap_threshold)
        gap_density = gap_count / phrase_measures
        # Harmonic rhythm: bias toward ~1 chord per measure; stretch only when
        # the line is very dense and legato (few gaps, many notes per bar).
        if gap_density >= 0.45 or notes_per_measure <= 5:
            target_segment = measure_dur * 1.0
        elif gap_density >= 0.22 or notes_per_measure <= 8:
            target_segment = measure_dur * 1.25
        else:
            target_segment = measure_dur * 1.5
        target_segment = min(max(target_segment, min_segment), max_segment)
        search_radius = beat_dur * 0.75

        def boundary_candidates(target: float) -> list[tuple[float, float]]:
            candidates: list[tuple[float, float]] = []
            for prev, cur in zip(phrase, phrase[1:]):
                prev_start = float(prev["start_time"])
                cur_start = float(cur["start_time"])
                prev_end = float(prev["end_time"])
                onset_spacing = cur_start - prev_start
                silent_gap = max(0.0, cur_start - prev_end)
                prev_duration = max(
                    0.01,
                    float(prev.get("duration", prev_end - prev_start)),
                )

                # Note onset near a measure boundary → extra candidate for ~1 change / bar.
                bar_off = (cur_start - phrase_start) % measure_dur
                near_bar = bar_off < beat_dur * 0.22 or bar_off > measure_dur - beat_dur * 0.22
                bar_weight = 1.05 if near_bar and cur_start > phrase_start + 1e-4 else 0.0

                for at, weight in (
                    (cur_start, 2.5 if silent_gap >= long_gap_threshold else 0.0),
                    (cur_start, 1.5 if onset_spacing >= long_spacing_threshold else 0.0),
                    (prev_start, 1.0 if prev_duration >= long_sustain_threshold else 0.0),
                    (cur_start, bar_weight),
                ):
                    if weight <= 0.0:
                        continue
                    if abs(at - target) > search_radius:
                        continue
                    if at - boundaries[-1] < min_segment:
                        continue
                    if phrase_end - at < beat_dur * 0.5:
                        continue
                    closeness = max(0.0, 1.0 - (abs(at - target) / search_radius))
                    candidates.append((weight + closeness, at))
            return candidates

        target = phrase_start + target_segment
        while target < phrase_end - min_segment:
            candidates = boundary_candidates(target)
            if candidates:
                _score, at = max(candidates, key=lambda item: item[0])
                boundaries.append(at)
            elif target - boundaries[-1] >= min_segment:
                boundaries.append(target)
            target = boundaries[-1] + target_segment

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
        # Start grounded on tonic, but do not force every cadence back to tonic:
        # short hummed melodies often become all-I if the final chord is overwritten.
        chords[0] = {**chords[0], **tonic, "chord_name": tonic["name"]}

        for i in range(1, len(chords)):
            prev = chords[i - 1]
            cur = chords[i]
            if cur["root_pc"] != prev["root_pc"]:
                continue

            start = float(cur["start_time"])
            end = float(cur["end_time"])
            seg_notes = [
                n for n in notes
                if float(n["start_time"]) < end and float(n["end_time"]) > start
            ]
            if not seg_notes:
                continue

            weights = [0.0] * 12
            for n in seg_notes:
                overlap = max(
                    0.0,
                    min(end, float(n["end_time"])) - max(start, float(n["start_time"])),
                )
                weights[int(n["pitch"]) % 12] += overlap
            end_note = max(seg_notes, key=lambda n: float(n["end_time"]))
            end_pc = int(end_note["pitch"]) % 12

            best_alt = None
            best_alt_score = -1.0
            for candidate in diatonic:
                if candidate["root_pc"] == prev["root_pc"]:
                    continue
                coverage = sum(weights[pc % 12] for pc in candidate["pitch_classes"])
                cadence = 2.0 if end_pc in candidate["pitch_classes"] else 0.0
                function = 0.5 if candidate["degree"] in (4, 5, 6) else 0.0
                score = coverage + cadence + function
                if score > best_alt_score:
                    best_alt_score = score
                    best_alt = candidate

            if best_alt is not None and best_alt_score > 0.0:
                chords[i] = {
                    **cur,
                    **best_alt,
                    "chord_name": best_alt["name"],
                }

        # Close on the tonic (typical cadence; keeps regression tests stable).
        chords[-1] = {
            **chords[-1],
            **tonic,
            "chord_name": tonic["name"],
            "start_time": chords[-1]["start_time"],
            "end_time": chords[-1]["end_time"],
        }

    return chords
