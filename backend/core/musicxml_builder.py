"""
MusicXML 3.1 builder.

Generates a valid score-partwise file with four labeled staves (SATB).
All parts share the same time signature (4/4) and tempo. Divisions = 4
(one division = one sixteenth note), so a quarter note = 4 divisions.
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


def _build_note(note: dict, tempo: int) -> str:
    pitch = note["pitch"]
    name_str = NOTE_NAMES_XML[pitch % 12]
    step = name_str.replace("#", "")
    alter = 1 if "#" in name_str else 0
    octave = (pitch // 12) - 1
    type_name, divs = _dur_type(note["duration"], tempo)

    alter_xml = f"<alter>{alter}</alter>" if alter else ""
    return (
        f"\n    <note>"
        f"<pitch><step>{step}</step>{alter_xml}<octave>{octave}</octave></pitch>"
        f"<duration>{divs}</duration>"
        f"<type>{type_name}</type>"
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
    return [b for b in buckets if b] or [[]]


def _build_part(pid: str, notes: list[dict], fifths: int, tempo: int, clef_sign: str = "G", clef_line: int = 2) -> str:
    measures = _group_into_measures(notes, tempo)
    measures_xml = ""
    for i, measure_notes in enumerate(measures):
        notes_xml = "".join(_build_note(n, tempo) for n in measure_notes)
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

    parts  — dict with keys 'soprano', 'alto', 'tenor', 'bass'
    key    — root note name e.g. 'C', 'G', 'F'
    tempo  — BPM integer
    """
    fifths = KEY_FIFTHS.get(key, 0)

    voice_config = [
        ("P1", "Soprano", "soprano", "G", 2),
        ("P2", "Alto",    "alto",    "G", 2),
        ("P3", "Tenor",   "tenor",   "G", 2),  # 8vb clef simplified to treble
        ("P4", "Bass",    "bass",    "F", 4),
    ]

    part_list_xml = "\n".join(
        f'    <score-part id="{pid}"><part-name>{name}</part-name></score-part>'
        for pid, name, _, _, _ in voice_config
    )

    parts_xml = "".join(
        _build_part(pid, parts[voice], fifths, tempo, clef_sign, clef_line)
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
