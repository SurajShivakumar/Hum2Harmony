"use client";

export default function ProgressBar({ progress }: { progress: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));

  return (
    <div className="w-full">
      <div className="w-full h-4 rounded-full bg-zinc-800 border border-zinc-700 overflow-hidden">
        <div
          className="h-full bg-emerald-400 transition-all duration-200 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-sm text-emerald-300 text-center">{pct}%</p>
    </div>
  );
}

