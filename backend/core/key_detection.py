"""
Krumhansl-Schmuckler key-finding algorithm.

Builds a pitch-class duration histogram from the note list, then correlates
against the Krumhansl-Kessler major and minor profiles for all 24 keys.
Returns the key with the highest correlation coefficient.
"""

import numpy as np

# Krumhansl-Kessler tonal hierarchy profiles (C-major and C-minor starting positions)
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def detect_key(notes: list[dict]) -> tuple[str, str]:
    """
    Returns (key_name, mode) e.g. ("G", "major").
    Falls back to ("C", "major") for empty note lists.
    """
    if not notes:
        return "C", "major"

    pitch_weights = [0.0] * 12
    for note in notes:
        pitch_weights[note["pitch"] % 12] += note["duration"]

    best_score, best_key, best_mode = -999.0, "C", "major"

    for i in range(12):
        # Rotate pitch histogram to align with each possible root
        rotated = pitch_weights[i:] + pitch_weights[:i]
        for profile, mode in [(MAJOR_PROFILE, "major"), (MINOR_PROFILE, "minor")]:
            corr = np.corrcoef(rotated, profile)[0, 1]
            if corr > best_score:
                best_score, best_key, best_mode = corr, KEY_NAMES[i], mode

    return best_key, best_mode
