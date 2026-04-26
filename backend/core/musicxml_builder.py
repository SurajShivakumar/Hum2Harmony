"""
MusicXML 3.1 builder.

Exports a synced arrangement with:
  - Lead melody
  - Piano RH/LH reduction
  - SATB sustained harmony staves

Unlike the previous implementation, this version preserves measure-relative
timing (rests, simultaneous notes/chords) so MuseScore playback stays aligned.
"""

KEY_FIFTHS: dict[str, int] = {
    "C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5,
    "F": -1, "Bb": -2, "Eb": -3, "Ab": -4,
}

NOTE_NAMES_XML = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# duration in quarter notes → MusicXML type name
DURATION_MAP: dict[float, str] = {
    4.0: "whole",
    2.0: "half",
    1.0: "quarter",
    0.5: "eighth",
    0.25: "16th",
}

DIVISIONS_PER_QUARTER = 4  # one division = one 16th note


def _dur_type(duration_seconds: float, tempo: int) -> tuple[str, int]:
    """
    Convert a note duration in seconds to (MusicXML type string, divisions).
    Snaps to nearest supported value; defaults to 'quarter'.
    """
    quarter_secs = 60.0 / max(tempo, 1)
    quarter_len = duration_seconds / quarter_secs  # duration in quarter notes
    # Snap to nearest supported value
    snap = min(DURATION_MAP.keys(), key=lambda k: abs(k - quarter_len))
    type_name = DURATION_MAP[snap]
    divs = int(snap * DIVISIONS_PER_QUARTER)
    return type_name, max(divs, 1)


def _type_from_divs(divs: int) -> str:
    # Reverse lookup with nearest fallback
    by_divs = {int(k * DIVISIONS_PER_QUARTER): v for k, v in DURATION_MAP.items()}
    if divs in by_divs:
        return by_divs[divs]
    nearest = min(by_divs.keys(), key=lambda k: abs(k - divs))
    return by_divs[nearest]


def _build_note(note: dict, tempo: int, chord: bool = False, override_divs: int | None = None) -> str:
    pitch = note["pitch"]
    name_str = NOTE_NAMES_XML[pitch % 12]
    step = name_str.replace("#", "")
    alter = 1 if "#" in name_str else 0
    octave = (pitch // 12) - 1
    if override_divs is None:
        type_name, divs = _dur_type(note["duration"], tempo)
    else:
        divs = max(1, int(override_divs))
        type_name = _type_from_divs(divs)

    alter_xml = f"<alter>{alter}</alter>" if alter else ""
    chord_xml = "<chord/>" if chord else ""
    return (
        f"\n    <note>"
        f"{chord_xml}"
        f"<pitch><step>{step}</step>{alter_xml}<octave>{octave}</octave></pitch>"
        f"<duration>{divs}</duration>"
        f"<type>{type_name}</type>"
        f"</note>"
    )


def _build_rest(divs: int) -> str:
    if divs <= 0:
        return ""
    return (
        f"\n    <note>"
        f"<rest/>"
        f"<duration>{divs}</duration>"
        f"<type>{_type_from_divs(divs)}</type>"
        f"</note>"
    )


def _group_into_measures(notes: list[dict], tempo: int, measure_beats: int = 4) -> list[list[dict]]:
    """Bin notes into measure-length buckets by start_time."""
    if not notes:
        return [[]]
    quarter_secs = 60.0 / max(tempo, 1)
    measure_dur = quarter_secs * measure_beats
    total = notes[-1]["start_time"] + notes[-1]["duration"]
    num = max(1, int(total / measure_dur) + 1)
    buckets: list[list[dict]] = [[] for _ in range(num)]
    for n in notes:
        idx = min(int(n["start_time"] / measure_dur), num - 1)
        buckets[idx].append(n)
    return buckets


def _measure_note_groups(
    notes: list[dict], tempo: int, measure_start: float, measure_end: float
) -> list[tuple[int, int, list[dict]]]:
    """
    Return grouped events: (start_div, duration_div, notes_at_same_start).
    Notes are clamped to the measure and grouped by quantized start division.
    """
    quarter_secs = 60.0 / max(tempo, 1)
    measure_notes = [n for n in notes if measure_start <= n["start_time"] < measure_end]
    groups: dict[int, list[dict]] = {}
    durs: dict[int, int] = {}

    for n in measure_notes:
        start_rel = max(0.0, n["start_time"] - measure_start)
        end_abs = min(measure_end, n["start_time"] + n["duration"])
        dur = max(0.05, end_abs - n["start_time"])
        start_quarters = start_rel / quarter_secs
        dur_quarters = dur / quarter_secs
        start_div = int(round(start_quarters * DIVISIONS_PER_QUARTER))
        dur_div = max(1, int(round(dur_quarters * DIVISIONS_PER_QUARTER)))
        groups.setdefault(start_div, []).append(n)
        durs[start_div] = max(durs.get(start_div, 1), dur_div)

    ordered = []
    for start_div in sorted(groups.keys()):
        # chord notes from high to low for cleaner notation
        same_start = sorted(groups[start_div], key=lambda n: n["pitch"], reverse=True)
        ordered.append((start_div, durs[start_div], same_start))
    return ordered


def _build_part(
    pid: str,
    notes: list[dict],
    fifths: int,
    tempo: int,
    total_measures: int,
    clef_sign: str = "G",
    clef_line: int = 2,
) -> str:
    quarter_secs = 60.0 / max(tempo, 1)
    measure_dur = quarter_secs * 4
    measure_divs = int(4 * DIVISIONS_PER_QUARTER)
    measures_xml = ""
    for i in range(total_measures):
        start = i * measure_dur
        end = (i + 1) * measure_dur
        groups = _measure_note_groups(notes, tempo, start, end)
        notes_xml = ""
        cursor = 0
        for start_div, dur_div, chord_notes in groups:
            if start_div > cursor:
                notes_xml += _build_rest(start_div - cursor)
            # first note
            notes_xml += _build_note(chord_notes[0], tempo, chord=False, override_divs=dur_div)
            # simultaneous notes
            for ch in chord_notes[1:]:
                notes_xml += _build_note(ch, tempo, chord=True, override_divs=dur_div)
            cursor = max(cursor, start_div + dur_div)
        if cursor < measure_divs:
            notes_xml += _build_rest(measure_divs - cursor)

        attr_xml = ""
        if i == 0:
            attr_xml = (
                f"\n    <attributes>"
                f"<divisions>{DIVISIONS_PER_QUARTER}</divisions>"
                f"<key><fifths>{fifths}</fifths></key>"
                f"<time><beats>4</beats><beat-type>4</beat-type></time>"
                f"<clef><sign>{clef_sign}</sign><line>{clef_line}</line></clef>"
                f"</attributes>"
                f"\n    <direction><sound tempo=\"{tempo}\"/></direction>"
            )
        measures_xml += f"\n  <measure number=\"{i + 1}\">{attr_xml}{notes_xml}\n  </measure>"
    return f"\n<part id=\"{pid}\">{measures_xml}\n</part>"


def build_musicxml(parts: dict[str, list[dict]], key: str, tempo: int) -> str:
    """
    Build a complete MusicXML 3.1 score-partwise document.

    parts  — dict with keys 'soprano', 'alto', 'tenor', 'bass', 'lead', 'piano_rh', 'piano_lh'
    key    — root note name e.g. 'C', 'G', 'F'
    tempo  — BPM integer
    """
    fifths = KEY_FIFTHS.get(key, 0)

    voice_config = [
        ("P1", "Lead",     "lead",     "G", 2),
        ("P2", "Piano RH", "piano_rh", "G", 2),
        ("P3", "Piano LH", "piano_lh", "F", 4),
        ("P4", "Soprano",  "soprano",  "G", 2),
        ("P5", "Alto",     "alto",     "G", 2),
        ("P6", "Tenor",    "tenor",    "G", 2),
        ("P7", "Bass",     "bass",     "F", 4),
    ]

    part_list_xml = "\n".join(
        f'    <score-part id="{pid}"><part-name>{name}</part-name></score-part>'
        for pid, name, _, _, _ in voice_config
    )

    # keep all parts aligned by measure count derived from the longest part
    all_notes = []
    for _pid, _name, voice, _cs, _cl in voice_config:
        all_notes.extend(parts.get(voice, []))
    if all_notes:
        end_time = max(n["start_time"] + n["duration"] for n in all_notes)
        quarter_secs = 60.0 / max(tempo, 1)
        total_measures = max(1, int(end_time / (quarter_secs * 4)) + 1)
    else:
        total_measures = 1

    parts_xml = "".join(
        _build_part(
            pid,
            parts.get(voice, []),
            fifths,
            tempo,
            total_measures,
            clef_sign,
            clef_line,
        )
        for pid, _name, voice, clef_sign, clef_line in voice_config
    )

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN"\n'
        '  "http://www.musicxml.org/dtds/partwise.dtd">\n'
        '<score-partwise version="3.1">\n'
        f'  <part-list>\n{part_list_xml}\n  </part-list>\n'
        f"{parts_xml}\n"
        "</score-partwise>"
    )
