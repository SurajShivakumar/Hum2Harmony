"""Tests for musicxml_builder module."""

from core.musicxml_builder import build_musicxml


def _part_note(pitch: int, start: float, duration: float = 0.5) -> dict:
    from core.voice_assignment import midi_to_name
    return {"note_name": midi_to_name(pitch), "pitch": pitch, "start_time": start, "duration": duration}


def _make_parts() -> dict:
    notes = [_part_note(p, float(i) * 0.5) for i, p in enumerate([60, 64, 67, 64])]
    return {
        "soprano": notes,
        "alto":    [_part_note(p - 7, n["start_time"], n["duration"]) for p, n in zip([60,64,67,64], notes)],
        "tenor":   [_part_note(p - 12, n["start_time"], n["duration"]) for p, n in zip([60,64,67,64], notes)],
        "bass":    [_part_note(p - 24, n["start_time"], n["duration"]) for p, n in zip([60,64,67,64], notes)],
    }


def test_build_musicxml_contains_header():
    xml = build_musicxml(_make_parts(), key="C", tempo=120)
    assert '<?xml version="1.0"' in xml
    assert "score-partwise" in xml


def test_build_musicxml_has_four_parts():
    xml = build_musicxml(_make_parts(), key="C", tempo=120)
    assert xml.count('<part id="P') == 4
    assert "Soprano" in xml
    assert "Alto" in xml
    assert "Tenor" in xml
    assert "Bass" in xml


def test_build_musicxml_tempo_embedded():
    xml = build_musicxml(_make_parts(), key="C", tempo=144)
    assert 'tempo="144"' in xml


def test_build_musicxml_key_signature():
    # G major = 1 sharp
    xml = build_musicxml(_make_parts(), key="G", tempo=120)
    assert "<fifths>1</fifths>" in xml

    # F major = 1 flat
    xml = build_musicxml(_make_parts(), key="F", tempo=120)
    assert "<fifths>-1</fifths>" in xml


def test_build_musicxml_is_string():
    xml = build_musicxml(_make_parts(), key="C", tempo=120)
    assert isinstance(xml, str)
    assert len(xml) > 100
