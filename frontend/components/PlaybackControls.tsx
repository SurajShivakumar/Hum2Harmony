"use client";

interface Props {
  onPlay: () => void;
  onStop: () => void;
  onDownload: () => void;
  onReset: () => void;
}

export default function PlaybackControls({ onPlay, onStop, onDownload, onReset }: Props) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      <button
        onClick={onPlay}
        className="px-5 py-2.5 rounded-full bg-yellow-300 text-black font-bold hover:bg-yellow-200 transition-colors"
      >
        ▶ Play
      </button>
      <button
        onClick={onStop}
        className="px-5 py-2.5 rounded-full bg-zinc-700 text-white font-semibold hover:bg-zinc-600 transition-colors"
      >
        ■ Stop
      </button>
      <button
        onClick={onDownload}
        className="px-5 py-2.5 rounded-full bg-emerald-400 text-black font-bold hover:bg-emerald-300 transition-colors"
      >
        ⬇ Download MIDI
      </button>
      <button
        onClick={onReset}
        className="px-5 py-2.5 rounded-full border border-zinc-500 text-zinc-200 font-medium hover:bg-zinc-800 transition-colors"
      >
        Try Again
      </button>
    </div>
  );
}

