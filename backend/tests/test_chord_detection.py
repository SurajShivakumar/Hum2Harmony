"""Tests for chord_detection module."""

from core.chord_detection import detect_chords, build_diatonic_chords


def _make_note(pitch: int, start: float, duration: float = 0.5) -> dict:
    return {"pitch": pitch, "start_time": start, "end_time": start + duration, "duration": duration}


def test_build_diatonic_chords_c_major():
    chords = build_diatonic_chords(0, "major")  # C major
    assert len(chords) == 5
    # I chord should be C (root_pc=0) with pitch classes [0, 4, 7]
    assert chords[0]["root_pc"] == 0
    assert set(chords[0]["pitch_classes"]) == {0, 4, 7}


def test_detect_chords_returns_tonic_at_start_and_end():
    # Simple C major melody: C E G repeated
    notes = [
        _make_note(60, 0.0),   # C4
        _make_note(64, 0.5),   # E4
        _make_note(67, 1.0),   # G4
        _make_note(60, 1.5),   # C4
        _make_note(64, 2.0),   # E4
        _make_note(67, 2.5),   # G4
        _make_note(60, 3.0),   # C4
        _make_note(64, 3.5),   # E4
    ]
    chords = detect_chords(notes, tempo=120, key_root="C", key_mode="major")
    assert len(chords) >= 1
    # First and last must be the tonic (C = root_pc 0)
    assert chords[0]["root_pc"] == 0
    assert chords[-1]["root_pc"] == 0


def test_detect_chords_structure():
    notes = [_make_note(60 + i, float(i) * 0.5) for i in range(8)]
    chords = detect_chords(notes, tempo=120, key_root="C", key_mode="major")
    for chord in chords:
        assert "start_time" in chord
        assert "end_time" in chord
        assert "chord_name" in chord
        assert "pitch_classes" in chord
        assert len(chord["pitch_classes"]) == 3


def test_empty_notes_returns_empty():
    result = detect_chords([], tempo=120, key_root="C", key_mode="major")
    assert result == []
