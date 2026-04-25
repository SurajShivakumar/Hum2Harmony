"use client";

import { useEffect, useRef, useState } from "react";

interface AudioPlayerProps {
  src: string;
  label?: string;
}

export default function AudioPlayer({ src, label = "Your recording" }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(audio.duration);
    const onEnded = () => setPlaying(false);

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("loadedmetadata", onDurationChange);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("loadedmetadata", onDurationChange);
      audio.removeEventListener("ended", onEnded);
    };
  }, [src]);

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      await audio.play();
      setPlaying(true);
    }
  };

  const seek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Number(e.target.value);
    setCurrentTime(audio.currentTime);
  };

  const fmt = (s: number) => {
    if (!isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

  return (
    <div className="w-full bg-gray-50 border border-gray-200 rounded-2xl px-5 py-4 flex flex-col gap-3">
      <audio ref={audioRef} src={src} preload="metadata" />

      <div className="flex items-center gap-4">
        {/* Play/pause */}
        <button
          onClick={toggle}
          className="flex-shrink-0 w-11 h-11 rounded-full bg-violet-600 hover:bg-violet-500 text-white flex items-center justify-center text-lg shadow transition-colors focus:outline-none focus:ring-2 focus:ring-violet-400"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "⏸" : "▶"}
        </button>

        {/* Label + times */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-700 truncate">{label}</p>
          <p className="text-xs text-gray-400 font-mono mt-0.5">
            {fmt(currentTime)} / {fmt(duration)}
          </p>
        </div>
      </div>

      {/* Seek bar */}
      <input
        type="range"
        min={0}
        max={isFinite(duration) ? duration : 0}
        step={0.01}
        value={currentTime}
        onChange={seek}
        className="w-full h-1.5 accent-violet-600 cursor-pointer rounded-full"
      />
    </div>
  );
}
