"""
Rule-based SATB voice assignment over detected chord spans.

For each chord span:
  - pick melody anchor near the span end (cadence-friendly)
  - build a voiced SATB chord around that anchor
  - sustain each voice only for the active chord span
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


def _candidates(pitch_classes: list[int], voice_range: tuple[int, int], target: int, limit: int = 10) -> list[int]:
    lo, hi = voice_range
    vals = [
        pc + 12 * octv
        for pc in pitch_classes
        for octv in range(0, 9)
        if lo <= pc + 12 * octv <= hi
    ]
    vals = sorted(set(vals), key=lambda p: abs(p - target))
    return vals[:limit] if vals else [clamp(target, lo, hi)]


def _best_satb_voicing(
    pitch_classes: list[int],
    root_pc: int,
    anchor_pitch: int,
    prev: tuple[int, int, int, int] | None = None,  # s,a,t,b
) -> tuple[int, int, int, int]:
    # Prefer root in bass; keep voicing independent and close to previous chord.
    s_c = _candidates(pitch_classes, RANGES["soprano"], anchor_pitch, limit=8)
    a_c = _candidates(pitch_classes, RANGES["alto"], anchor_pitch - 6, limit=8)
    t_c = _candidates(pitch_classes, RANGES["tenor"], anchor_pitch - 12, limit=8)
    b_root = _candidates([root_pc], RANGES["bass"], 43, limit=6)
    b_any = _candidates(pitch_classes, RANGES["bass"], 43, limit=6)
    b_c = b_root + [x for x in b_any if x not in b_root]

    best = None
    best_score = -10**9
    for s in s_c:
        for a in a_c:
            if not (a < s and 2 <= (s - a) <= 12):
                continue
            for t in t_c:
                if not (t < a and 2 <= (a - t) <= 12):
                    continue
                for b in b_c:
                    if not (b < t and 2 <= (t - b) <= 19):
                        continue
                    # discourage exact unison/octave duplication between upper parts
                    dup_penalty = 0.0
                    for x, y in ((s, a), (a, t), (s, t)):
                        if (x - y) % 12 == 0:
                            dup_penalty += 1.5

                    score = 0.0
                    score -= abs(s - anchor_pitch) * 0.7
                    score += 1.5 if (b % 12) == root_pc else 0.0
                    score -= dup_penalty

                    pcs = {s % 12, a % 12, t % 12, b % 12}
                    # Prefer SATB that spans more chord tones (not same-note spam).
                    score += len(pcs) * 0.9
                    missing = [pc for pc in set(pitch_classes) if pc not in pcs]
                    score -= len(missing) * 1.2

                    if prev:
                        ps, pa, pt, pb = prev
                        score -= (abs(s - ps) + abs(a - pa) + abs(t - pt) + abs(b - pb)) * 0.12

                    if score > best_score:
                        best_score = score
                        best = (s, a, t, b)

    if best:
        return best

    # Fallback to simple nearest assignment
    s_pitch = clamp(anchor_pitch, *RANGES["soprano"])
    a_pitch = nearest_chord_tone(s_pitch - 5, pitch_classes, RANGES["alto"])
    t_pitch = nearest_chord_tone(a_pitch - 5, pitch_classes, RANGES["tenor"])
    b_pitch = nearest_chord_tone(root_pc + 36, [root_pc], RANGES["bass"])
    return s_pitch, a_pitch, t_pitch, b_pitch


def assign_voices(notes: list[dict], chords: list[dict]) -> dict[str, list[dict]]:
    parts: dict[str, list[dict]] = {
        "lead": [],
        "piano_rh": [],
        "piano_lh": [],
        "soprano": [],
        "alto": [],
        "tenor": [],
        "bass": [],
    }

    # Lead keeps the exact sung/transcribed melody timing and pitch.
    for note in notes:
        lp = int(note["pitch"])
        parts["lead"].append(
            {
                "note_name": midi_to_name(lp),
                "pitch": lp,
                "start_time": note["start_time"],
                "duration": note["duration"],
            }
        )

    prev_voicing: tuple[int, int, int, int] | None = None

    for chord in chords:
        start = chord["start_time"]
        end = chord["end_time"]
        dur = max(0.1, end - start)
        seg_notes = [n for n in notes if start <= n["start_time"] < end]
        # Anchor harmony to the note ending nearest the chord boundary.
        if seg_notes:
            anchor_note = min(seg_notes, key=lambda n: abs(n["end_time"] - end))
            anchor_pitch = int(anchor_note["pitch"])
        else:
            # Fallback around middle C if melody is absent in this span.
            anchor_pitch = 60

        pcs = chord["pitch_classes"]
        root_pc = chord["root_pc"]

        s_pitch, a_pitch, t_pitch, b_pitch = _best_satb_voicing(
            pcs, root_pc, anchor_pitch, prev=prev_voicing
        )
        prev_voicing = (s_pitch, a_pitch, t_pitch, b_pitch)

        for voice, pitch in [("soprano", s_pitch), ("alto", a_pitch), ("tenor", t_pitch), ("bass", b_pitch)]:
            parts[voice].append(
                {
                    "note_name": midi_to_name(pitch),
                    "pitch": pitch,
                    "start_time": start,
                    "duration": dur,
                }
            )

        # Piano reduction (sustained):
        # RH = soprano+alto chord tones, LH = tenor+bass chord tones.
        for p in (s_pitch, a_pitch):
            parts["piano_rh"].append(
                {
                    "note_name": midi_to_name(p),
                    "pitch": p,
                    "start_time": start,
                    "duration": dur,
                }
            )
        for p in (t_pitch, b_pitch):
            parts["piano_lh"].append(
                {
                    "note_name": midi_to_name(p),
                    "pitch": p,
                    "start_time": start,
                    "duration": dur,
                }
            )

    return parts
