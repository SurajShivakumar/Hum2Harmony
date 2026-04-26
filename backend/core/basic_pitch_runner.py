"""
Audio transcription using Spotify's Basic Pitch, with voice-optimised
post-processing:

  1. ffmpeg converts browser webm/ogg → 22050 Hz mono WAV before inference.
  2. ONNX model is forced (TF 2.20 is incompatible with the SavedModel format).
  3. Higher thresholds reduce false-positive note density for a humming voice.
  4. monophonize()     — keeps only the loudest note at any instant (voice = 1 pitch).
  5. merge_nearby()    — fuses same-pitch notes separated by tiny gaps (< 120 ms).
  6. quantize_to_scale() — snaps every pitch to the nearest degree of the detected key.
"""

import os
import pathlib
import subprocess
import tempfile

import librosa
import numpy as np

try:
    from core.neuralnote_runner import transcribe_audio_neuralnote
except Exception:  # pragma: no cover - keeps Basic Pitch usable during setup
    transcribe_audio_neuralnote = None

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _get_basic_pitch_onnx_model_path() -> pathlib.Path:
    """Resolve Basic Pitch ONNX model lazily so the backend can boot without it."""
    try:
        module_path = pathlib.Path(__import__("basic_pitch").__file__).parent
    except Exception as exc:
        raise RuntimeError(
            "basic_pitch is not installed. Install Basic Pitch or use NeuralNote."
        ) from exc
    return module_path / "saved_models" / "icassp_2022" / "nmp.onnx"

MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def midi_to_name(midi_num: int) -> str:
    return f"{NOTE_NAMES[midi_num % 12]}{(midi_num // 12) - 1}"


def _to_wav(input_path: str) -> tuple[str, bool]:
    """Convert any browser audio format to 22050 Hz mono WAV via ffmpeg."""
    ext = pathlib.Path(input_path).suffix.lower()
    if ext in (".wav", ".flac"):
        return input_path, False

    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", input_path,
             "-ar", "22050", "-ac", "1", "-f", "wav", wav_path],
            check=True, capture_output=True,
        )
        return wav_path, True
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"[basic_pitch] ffmpeg conversion failed ({e}), using original")
        os.remove(wav_path)
        return input_path, False


# ---------------------------------------------------------------------------
# Post-processing
# ---------------------------------------------------------------------------

def monophonize(notes: list[dict]) -> list[dict]:
    """
    Humming produces exactly one pitch at a time. If Basic Pitch still returns
    overlapping notes (polyphonic artifacts), keep only the loudest one at
    each instant, resolved by amplitude.
    """
    if not notes:
        return notes

    result: list[dict] = []
    for note in notes:
        # Check if it overlaps with the last kept note
        if result and note["start_time"] < result[-1]["end_time"]:
            if note["amplitude"] > result[-1]["amplitude"]:
                # New note is louder — replace the tail of the previous note
                result[-1]["end_time"] = note["start_time"]
                result[-1]["duration"] = result[-1]["end_time"] - result[-1]["start_time"]
                if result[-1]["duration"] < 0.05:
                    result.pop()  # previous note was too short after trimming
                result.append(note)
            # else: keep existing, skip quieter overlap
        else:
            result.append(note)

    return result


def filter_lead_notes(notes: list[dict], window: int = 7) -> list[dict]:
    """
    Remove notes that are very unlikely to be part of the main melodic line.

    Two passes:
      1. Pitch outliers — a sliding window computes the local median pitch.
         Any note more than 9 semitones away from its local neighbours is
         discarded (catches octave errors and high/low harmonics).
      2. Amplitude outliers — notes quieter than the bottom 15th percentile
         AND below an absolute threshold of 0.12 are discarded (catches
         faint artefacts that slipped through the onset filter).
    """
    if len(notes) < 3:
        return notes

    pitches = np.array([n["pitch"] for n in notes])
    amplitudes = np.array([n["amplitude"] for n in notes])

    amp_floor = max(0.12, float(np.percentile(amplitudes, 15)))
    half = window // 2

    filtered = []
    for i, note in enumerate(notes):
        # Local pitch context
        lo, hi = max(0, i - half), min(len(notes), i + half + 1)
        local_median = float(np.median(pitches[lo:hi]))

        if abs(note["pitch"] - local_median) > 9:
            continue  # pitch outlier — likely a harmonic or octave detection error

        if note["amplitude"] < amp_floor:
            continue  # too quiet — likely background noise

        filtered.append(note)

    return filtered if len(filtered) >= 2 else notes  # never return an empty list


def merge_nearby(notes: list[dict], gap_ms: float = 60.0) -> list[dict]:
    """
    Merge consecutive notes of the *same pitch* separated by less than gap_ms
    milliseconds. Fuses stuttered detection of one held note into a single event.
    Different pitches are never merged, so semitone changes are always preserved.
    """
    if not notes:
        return notes

    gap_s = gap_ms / 1000.0
    merged = [dict(notes[0])]

    for note in notes[1:]:
        prev = merged[-1]
        same_pitch = note["pitch"] == prev["pitch"]
        small_gap = (note["start_time"] - prev["end_time"]) < gap_s

        if same_pitch and small_gap:
            prev["end_time"] = note["end_time"]
            prev["duration"] = round(prev["end_time"] - prev["start_time"], 4)
            prev["amplitude"] = max(prev["amplitude"], note["amplitude"])
        else:
            merged.append(dict(note))

    return merged


def quantize_to_scale(
    notes: list[dict], key_root: str, key_mode: str
) -> list[dict]:
    """
    Snap each note's pitch to the nearest degree of the detected scale.

    e.g. in C major [C D E F G A B], an F# gets pulled to F or G, whichever
    is closer. The octave is preserved; only the pitch class changes.
    """
    scale = MAJOR_SCALE if key_mode == "major" else MINOR_SCALE
    root_pc = NOTE_NAMES.index(key_root)
    scale_pcs = [(root_pc + interval) % 12 for interval in scale]

    quantized = []
    for note in notes:
        pc = note["pitch"] % 12

        # Circular distance to each scale pitch class
        best_pc = min(
            scale_pcs,
            key=lambda s: min(abs(s - pc), 12 - abs(s - pc)),
        )

        # Chromatic shift needed (−6 to +6 semitones)
        diff = best_pc - pc
        if diff > 6:
            diff -= 12
        elif diff < -6:
            diff += 12

        new_pitch = note["pitch"] + diff
        quantized.append({
            **note,
            "pitch": new_pitch,
            "note_name": midi_to_name(new_pitch),
        })

    return quantized


# ---------------------------------------------------------------------------
# Tempo estimation
# ---------------------------------------------------------------------------

def estimate_tempo_from_notes(notes: list[dict]) -> int:
    """BPM from median note-onset spacing — more reliable than beat tracking on voice."""
    if len(notes) < 4:
        return 120

    onsets = sorted(n["start_time"] for n in notes)
    intervals = [
        onsets[i + 1] - onsets[i]
        for i in range(len(onsets) - 1)
        if 0.08 < onsets[i + 1] - onsets[i] < 2.0
    ]
    if not intervals:
        return 120

    median_iv = float(np.median(intervals))
    for divisor in (0.25, 0.5, 1.0, 2.0, 3.0, 4.0):
        bpm = 60.0 / (median_iv * divisor)
        if 60 <= bpm <= 200:
            return int(round(bpm))

    return 120


def estimate_bpm_librosa(wav_path: str) -> int | None:
    """
    Global tempo from the audio waveform (librosa beat tracking).
    Can disagree with `estimate_tempo_from_notes` on unaccompanied voice — both are useful.
    """
    try:
        y, sr = librosa.load(wav_path, sr=22050, mono=True)
        if y.size < sr // 2:
            return None
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo, _ = librosa.beat.beat_track(
            onset_envelope=onset_env,
            sr=sr,
        )
        t = float(np.ravel(np.asarray(tempo))[0])
        if not np.isfinite(t) or t <= 0:
            return None
        bpm = int(round(t))
        if 40 <= bpm <= 300:
            return bpm
    except Exception as exc:
        print(f"[librosa] BPM estimation failed: {exc}")
    return None


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def _transcribe_audio_basic_pitch(audio_path: str) -> tuple[list[dict], int | None]:
    """
    Run Basic Pitch on audio_path and return post-processed notes.

    Post-processing order:
      Raw notes → monophonize → merge nearby → (quantize happens in main.py
      after key detection)

    Each note dict:
      pitch      – MIDI number
      note_name  – e.g. "C4"
      start_time – seconds
      end_time   – seconds
      duration   – seconds
      amplitude  – 0–1

    Second return value is librosa global BPM, or None if unavailable.
    """
    wav_path, converted = _to_wav(audio_path)
    bpm_librosa: int | None = None

    try:
        try:
            from basic_pitch.inference import predict
        except Exception as exc:
            raise RuntimeError(
                "basic_pitch is not installed. Install Basic Pitch dependencies to use fallback transcription."
            ) from exc

        bpm_librosa = estimate_bpm_librosa(wav_path)
        model_path = _get_basic_pitch_onnx_model_path()
        _model_output, _midi_data, note_events = predict(
            wav_path,
            model_or_model_path=model_path,
            onset_threshold=0.4,        # catch all real note onsets
            frame_threshold=0.25,       # sustain sensitivity
            minimum_note_length=80,     # ms
            minimum_frequency=60.0,     # ~B1 — allow bass harmonics through
            maximum_frequency=2000.0,   # ~C7 — allow upper harmonics through
            melodia_trick=False,        # FALSE — allow all simultaneous notes (polyphonic)
            multiple_pitch_bends=False,
        )
    finally:
        if converted and os.path.exists(wav_path):
            os.remove(wav_path)

    # Build initial note list, discard very short artifacts
    notes = []
    for start, end, pitch, amplitude, _bends in note_events:
        duration = float(end) - float(start)
        if duration < 0.07:   # ~70 ms — removes noise clicks, keeps quick notes
            continue
        notes.append({
            "pitch": int(pitch),
            "note_name": midi_to_name(int(pitch)),
            "start_time": round(float(start), 4),
            "end_time": round(float(end), 4),
            "duration": round(duration, 4),
            "amplitude": round(float(amplitude), 3),
        })

    notes = sorted(notes, key=lambda n: n["start_time"])
    # No monophonize — keep all simultaneous notes (polyphonic output)
    notes = merge_nearby(notes)  # fuse same-pitch fragments < 60 ms apart

    return notes, bpm_librosa


def _transcribe_audio_pyin(audio_path: str) -> tuple[list[dict], int | None]:
    """
    Emergency monophonic fallback when neither NeuralNote nor Basic Pitch is
    available. Uses librosa.pyin to recover a lead melody line.
    """
    wav_path, converted = _to_wav(audio_path)
    try:
        y, sr = librosa.load(wav_path, sr=22050, mono=True)
        bpm_librosa = estimate_bpm_librosa(wav_path)
    finally:
        if converted and os.path.exists(wav_path):
            os.remove(wav_path)

    if y.size < sr // 8:
        return [], bpm_librosa

    f0, voiced_flag, _ = librosa.pyin(
        y,
        fmin=float(librosa.note_to_hz("C2")),
        fmax=float(librosa.note_to_hz("C6")),
        sr=sr,
        frame_length=2048,
        hop_length=256,
    )

    if f0 is None or voiced_flag is None:
        return [], bpm_librosa

    times = librosa.frames_to_time(np.arange(len(f0)), sr=sr, hop_length=256)
    notes: list[dict] = []
    i = 0
    while i < len(f0):
        if not voiced_flag[i] or not np.isfinite(f0[i]) or f0[i] <= 0:
            i += 1
            continue

        start_i = i
        hz_values = []
        while i < len(f0) and voiced_flag[i] and np.isfinite(f0[i]) and f0[i] > 0:
            hz_values.append(float(f0[i]))
            i += 1

        if not hz_values:
            continue

        start_t = float(times[start_i])
        end_t = float(times[min(i, len(times) - 1)])
        duration = end_t - start_t
        if duration < 0.07:
            continue

        midi = int(round(librosa.hz_to_midi(float(np.median(hz_values)))))
        midi = max(36, min(96, midi))
        notes.append({
            "pitch": midi,
            "note_name": midi_to_name(midi),
            "start_time": round(start_t, 4),
            "end_time": round(end_t, 4),
            "duration": round(duration, 4),
            "amplitude": 0.75,
        })

    notes = merge_nearby(monophonize(sorted(notes, key=lambda n: n["start_time"])))
    notes = filter_lead_notes(notes)
    return notes, bpm_librosa


def transcribe_audio(audio_path: str) -> tuple[list[dict], int | None]:
    """
    Prefer NeuralNote's C++ transcription engine when its CLI is available.

    The rest of the backend expects the same note dict shape regardless of
    engine, so Basic Pitch remains a fallback while the native CLI is not built.
    """
    wav_path, converted = _to_wav(audio_path)
    bpm_librosa: int | None = None
    try:
        bpm_librosa = estimate_bpm_librosa(wav_path)
    finally:
        if converted and os.path.exists(wav_path):
            os.remove(wav_path)

    engine = os.getenv("TRANSCRIPTION_ENGINE", "neuralnote").strip().lower()
    if engine == "neuralnote_strict" and transcribe_audio_neuralnote is None:
        raise RuntimeError("NeuralNote runner could not be imported")

    if engine in ("neuralnote", "neuralnote_strict", "auto") and transcribe_audio_neuralnote is not None:
        try:
            notes = transcribe_audio_neuralnote(audio_path)
            notes = merge_nearby(notes)
            print(f"[transcription] engine=neuralnote notes={len(notes)}")
            return notes, bpm_librosa
        except Exception as exc:
            print(f"[neuralnote] unavailable, falling back to basic-pitch: {exc}")
            if engine == "neuralnote_strict":
                raise

    try:
        notes, fallback_bpm = _transcribe_audio_basic_pitch(audio_path)
        print(f"[transcription] engine=basic-pitch notes={len(notes)}")
        return notes, bpm_librosa if bpm_librosa is not None else fallback_bpm
    except Exception as exc:
        print(f"[basic-pitch] unavailable, falling back to librosa pyin: {exc}")

    notes, pyin_bpm = _transcribe_audio_pyin(audio_path)
    print(f"[transcription] engine=pyin-fallback notes={len(notes)}")
    return notes, bpm_librosa if bpm_librosa is not None else pyin_bpm
