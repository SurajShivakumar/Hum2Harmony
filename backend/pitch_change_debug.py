"""
CLI tool to inspect major frequency changes in a recording.

Usage:
    python pitch_change_debug.py "audio_files/input.webm"

This prints timestamped pitch-change events:
    time_seconds | hz | note | delta_semitones
"""

from __future__ import annotations

import argparse
import csv
import math
import os
import pathlib
import statistics
import subprocess
import tempfile
from collections import deque

import imageio_ffmpeg
import librosa
import numpy as np

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def midi_to_name(midi_num: int) -> str:
    return f"{NOTE_NAMES[midi_num % 12]}{(midi_num // 12) - 1}"


def hz_to_midi(hz: float) -> float:
    return 69.0 + 12.0 * math.log2(hz / 440.0)


def _to_wav(input_path: str) -> tuple[str, bool]:
    """Convert any browser audio format to 22050 Hz mono WAV via imageio-ffmpeg binary."""
    ext = pathlib.Path(input_path).suffix.lower()
    if ext in (".wav", ".flac"):
        return input_path, False

    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        subprocess.run(
            [ffmpeg_exe, "-y", "-i", input_path, "-ar", "22050", "-ac", "1", "-f", "wav", wav_path],
            check=True,
            capture_output=True,
        )
        return wav_path, True
    except Exception as exc:
        if os.path.exists(wav_path):
            os.remove(wav_path)
        raise RuntimeError(f"Audio conversion failed: {exc}") from exc


def load_audio(input_path: str, sr: int = 22050) -> tuple[np.ndarray, int]:
    """Convert to WAV if needed, then load with librosa/soundfile."""
    wav_path, converted = _to_wav(input_path)
    try:
        y, loaded_sr = librosa.load(wav_path, sr=sr, mono=True)
        return y, loaded_sr
    finally:
        if converted and os.path.exists(wav_path):
            os.remove(wav_path)


def detect_major_changes(
    audio_path: str,
    semitone_threshold: float,
    min_change_gap_s: float,
    frame_hop: int,
    smooth_window: int,
) -> list[dict]:
    y, sr = load_audio(audio_path)
    f0, voiced_flag, _ = librosa.pyin(
        y,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C6"),
        sr=sr,
        frame_length=2048,
        hop_length=frame_hop,
    )
    if f0 is None or voiced_flag is None:
        return []

    times = librosa.times_like(f0, sr=sr, hop_length=frame_hop)
    events: list[dict] = []
    smooth = deque(maxlen=max(1, smooth_window))
    anchor_midi: float | None = None
    anchor_time = -1e9

    for i, hz in enumerate(f0):
        if not bool(voiced_flag[i]) or not np.isfinite(hz) or hz <= 0:
            continue

        smooth.append(float(hz))
        hz_smoothed = float(statistics.median(smooth))
        midi = hz_to_midi(hz_smoothed)
        t = float(times[i])

        if anchor_midi is None:
            anchor_midi = midi
            anchor_time = t
            events.append(
                {
                    "time": t,
                    "hz": hz_smoothed,
                    "midi": midi,
                    "delta": 0.0,
                    "kind": "start",
                }
            )
            continue

        delta = midi - anchor_midi
        if abs(delta) >= semitone_threshold and (t - anchor_time) >= min_change_gap_s:
            events.append(
                {
                    "time": t,
                    "hz": hz_smoothed,
                    "midi": midi,
                    "delta": delta,
                    "kind": "change",
                }
            )
            anchor_midi = midi
            anchor_time = t

    return events


def detect_pitch_plateaus(
    audio_path: str,
    semitone_threshold: float,
    min_plateau_duration_s: float,
    frame_hop: int,
    smooth_window: int,
) -> list[dict]:
    """
    Group voiced frames into stable pitch plateaus and return:
      start_s, end_s, duration_s, avg_hz, avg_midi, note
    """
    y, sr = load_audio(audio_path)
    f0, voiced_flag, voiced_probs = librosa.pyin(
        y,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C6"),
        sr=sr,
        frame_length=2048,
        hop_length=frame_hop,
    )
    if f0 is None or voiced_flag is None:
        return []

    times = librosa.times_like(f0, sr=sr, hop_length=frame_hop)
    smooth = deque(maxlen=max(1, smooth_window))
    plateaus: list[dict] = []
    current: dict | None = None
    last_voiced_idx: int | None = None

    def flush_current() -> None:
        nonlocal current
        if current is None:
            return
        duration = float(current["end"] - current["start"])
        if duration >= min_plateau_duration_s and current["hz_values"]:
            avg_hz = float(np.mean(current["hz_values"]))
            avg_midi = hz_to_midi(avg_hz)
            plateaus.append(
                {
                    "start_s": float(current["start"]),
                    "end_s": float(current["end"]),
                    "duration_s": duration,
                    "avg_hz": avg_hz,
                    "avg_midi": avg_midi,
                    "note": midi_to_name(int(round(avg_midi))),
                }
            )
        current = None

    for i, hz in enumerate(f0):
        prob = float(voiced_probs[i]) if voiced_probs is not None else 1.0
        is_voiced = bool(voiced_flag[i]) and np.isfinite(hz) and hz > 0 and prob >= 0.5
        if not is_voiced:
            if current is not None and last_voiced_idx is not None:
                gap = float(times[i]) - float(times[last_voiced_idx])
                if gap > 0.15:
                    flush_current()
            smooth.clear()
            continue

        last_voiced_idx = i
        t = float(times[i])
        smooth.append(float(hz))
        hz_smoothed = float(statistics.median(smooth))
        midi = hz_to_midi(hz_smoothed)

        if current is None:
            current = {
                "start": t,
                "end": t,
                "anchor_midi": midi,
                "hz_values": [hz_smoothed],
            }
            continue

        delta = abs(midi - float(current["anchor_midi"]))
        if delta >= semitone_threshold:
            flush_current()
            current = {
                "start": t,
                "end": t,
                "anchor_midi": midi,
                "hz_values": [hz_smoothed],
            }
        else:
            current["end"] = t
            current["hz_values"].append(hz_smoothed)
            current["anchor_midi"] = float(np.mean([current["anchor_midi"], midi]))

    flush_current()

    # Split plateaus at syllable re-attacks (same pitch hummed twice)
    onset_frames = librosa.onset.onset_detect(
        y=y, sr=sr, hop_length=frame_hop, backtrack=True, units="frames"
    )
    onset_times = [
        float(librosa.frames_to_time(int(f), sr=sr, hop_length=frame_hop))
        for f in onset_frames
    ]
    min_gap = 0.09
    split_plateaus: list[dict] = []
    for p in plateaus:
        internal = sorted(
            t for t in onset_times
            if p["start_s"] + min_gap < t < p["end_s"] - min_gap
        )
        if not internal:
            split_plateaus.append(p)
            continue
        boundaries = [p["start_s"]] + internal + [p["end_s"]]
        for j in range(len(boundaries) - 1):
            s, e = boundaries[j], boundaries[j + 1]
            dur = e - s
            if dur >= min_plateau_duration_s:
                split_plateaus.append({**p, "start_s": round(s, 4), "end_s": round(e, 4), "duration_s": round(dur, 4)})

    return split_plateaus


def main() -> None:
    parser = argparse.ArgumentParser(description="Print major frequency changes from audio.")
    parser.add_argument("audio_path", help="Path to recording (wav/webm/ogg/mp4/flac)")
    parser.add_argument(
        "--mode",
        choices=["changes", "plateaus"],
        default="changes",
        help="Output major jump events or stable pitch plateaus",
    )
    parser.add_argument("--threshold", type=float, default=1.5, help="Semitone jump threshold")
    parser.add_argument(
        "--min-gap",
        type=float,
        default=0.12,
        help="Minimum seconds between accepted changes",
    )
    parser.add_argument("--hop", type=int, default=512, help="Hop length for pyin frames")
    parser.add_argument(
        "--smooth-window",
        type=int,
        default=5,
        help="Median smoothing window over consecutive voiced frames",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="",
        help="Optional CSV output path for detected events",
    )
    parser.add_argument(
        "--min-plateau",
        type=float,
        default=0.12,
        help="Minimum duration (seconds) to keep a plateau in --mode plateaus",
    )
    args = parser.parse_args()

    if args.mode == "changes":
        events = detect_major_changes(
            audio_path=args.audio_path,
            semitone_threshold=args.threshold,
            min_change_gap_s=args.min_gap,
            frame_hop=args.hop,
            smooth_window=args.smooth_window,
        )
        if not events:
            print("No voiced pitch events detected.")
            return

        print("time_s\thz\tnote\tdelta_st\tkind")
        for ev in events:
            midi_round = int(round(ev["midi"]))
            print(
                f"{ev['time']:.3f}\t{ev['hz']:.2f}\t{midi_to_name(midi_round)}\t"
                f"{ev['delta']:+.2f}\t{ev['kind']}"
            )

        if args.output:
            with open(args.output, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=["time_s", "hz", "midi", "note", "delta_st", "kind"])
                writer.writeheader()
                for ev in events:
                    midi_round = int(round(ev["midi"]))
                    writer.writerow(
                        {
                            "time_s": f"{ev['time']:.6f}",
                            "hz": f"{ev['hz']:.4f}",
                            "midi": f"{ev['midi']:.4f}",
                            "note": midi_to_name(midi_round),
                            "delta_st": f"{ev['delta']:.4f}",
                            "kind": ev["kind"],
                        }
                    )
            print(f"\nSaved {len(events)} events to {args.output}")
        return

    plateaus = detect_pitch_plateaus(
        audio_path=args.audio_path,
        semitone_threshold=args.threshold,
        min_plateau_duration_s=args.min_plateau,
        frame_hop=args.hop,
        smooth_window=args.smooth_window,
    )
    if not plateaus:
        print("No stable pitch plateaus detected.")
        return

    print("start_s\tend_s\tduration_s\tavg_hz\tnote")
    for p in plateaus:
        print(f"{p['start_s']:.3f}\t{p['end_s']:.3f}\t{p['duration_s']:.3f}\t{p['avg_hz']:.2f}\t{p['note']}")

    if args.output:
        with open(args.output, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=["start_s", "end_s", "duration_s", "avg_hz", "avg_midi", "note"],
            )
            writer.writeheader()
            writer.writerows(plateaus)
        print(f"\nSaved {len(plateaus)} plateaus to {args.output}")


if __name__ == "__main__":
    main()

