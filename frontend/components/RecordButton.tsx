"use client";

import { useRef, useState, useCallback } from "react";

interface RecordButtonProps {
  onRecordingComplete?: (blob: Blob) => void;
  onRecorded?: (file: File) => void;
  disabled?: boolean;
}

const MAX_DURATION_MS = 30_000;

function getSupportedMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

export default function RecordButton({ onRecordingComplete, onRecorded, disabled }: RecordButtonProps) {
  const [state, setState] = useState<"idle" | "recording" | "done">("idle");
  const [elapsed, setElapsed] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    setState("done");
  }, []);

  const startRecording = useCallback(async () => {
    chunksRef.current = [];
    setElapsed(0);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      alert("Microphone access denied. Please allow microphone access and try again.");
      return;
    }

    const mimeType = getSupportedMimeType();
    const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorderRef.current = mr;

    mr.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType || "audio/webm" });
      onRecordingComplete?.(blob);
      if (onRecorded) {
        const ext = (mimeType || "audio/webm").includes("ogg")
          ? "ogg"
          : (mimeType || "audio/webm").includes("mp4")
          ? "m4a"
          : "webm";
        const file = new File([blob], `recording.${ext}`, { type: blob.type });
        onRecorded(file);
      }
    };

    mr.start(100);
    setState("recording");

    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    autoStopRef.current = setTimeout(stopRecording, MAX_DURATION_MS);
  }, [onRecordingComplete, onRecorded, stopRecording]);

  const remaining = Math.max(0, 30 - elapsed);

  return (
    <div className="flex flex-col items-center gap-4">
      <button
        onClick={state === "recording" ? stopRecording : startRecording}
        disabled={disabled || state === "done"}
        className={[
          "relative flex items-center justify-center rounded-full w-36 h-36 text-white font-bold shadow-2xl transition-all duration-300 focus:outline-none focus:ring-4 focus:ring-offset-2",
          state === "recording"
            ? "bg-red-500 focus:ring-red-400 scale-110"
            : state === "done"
            ? "bg-gray-400 cursor-not-allowed"
            : "bg-violet-600 hover:bg-violet-500 hover:scale-105 focus:ring-violet-400",
        ].join(" ")}
        aria-label={state === "recording" ? "Stop recording" : "Start recording"}
      >
        {state === "recording" && (
          <>
            <span className="absolute inset-0 rounded-full bg-red-400 opacity-30 animate-ping" />
            <span className="absolute inset-0 rounded-full bg-red-400 opacity-20 animate-ping [animation-delay:0.4s]" />
          </>
        )}

        <span className="relative z-10 flex flex-col items-center gap-1">
          {state === "recording" ? (
            <>
              <span className="text-3xl">■</span>
              <span className="text-sm font-mono">{remaining}s</span>
            </>
          ) : (
            <span className="text-5xl">🎤</span>
          )}
        </span>
      </button>

      <p className="text-sm text-gray-500 text-center">
        {state === "idle" && "Click to start recording · max 30 seconds"}
        {state === "recording" && `Recording… ${elapsed}s / 30s — click to stop`}
        {state === "done" && "Recording captured ✓"}
      </p>
    </div>
  );
}
