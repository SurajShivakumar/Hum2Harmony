"use client";

import { useRef, useState, useCallback } from "react";

interface UploadZoneProps {
  onFileSelected?: (file: File) => void;
  onFile?: (file: File) => void;
  disabled?: boolean;
}

const ACCEPTED = ["audio/wav", "audio/mpeg", "audio/mp4", "audio/m4a", "audio/ogg", "audio/webm"];

function isAccepted(file: File) {
  return ACCEPTED.some((t) => file.type.startsWith(t.split("/")[0]) && file.type.includes(t.split("/")[1])) || file.name.match(/\.(wav|mp3|m4a|ogg|webm)$/i);
}

export default function UploadZone({ onFileSelected, onFile, disabled }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File) => {
      setError(null);
      if (!isAccepted(file)) {
        setError("Please upload a WAV, MP3, or M4A file.");
        return;
      }
      onFileSelected?.(file);
      onFile?.(file);
    },
    [onFileSelected, onFile]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={onDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      className={[
        "flex flex-col items-center justify-center gap-3 w-full rounded-2xl border-2 border-dashed p-10 cursor-pointer transition-colors duration-200",
        isDragging
          ? "border-violet-400 bg-violet-50"
          : "border-gray-300 hover:border-violet-400 hover:bg-gray-50",
        disabled ? "opacity-50 pointer-events-none" : "",
      ].join(" ")}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
      aria-label="Upload audio file"
    >
      <input
        ref={inputRef}
        type="file"
        accept=".wav,.mp3,.m4a,.ogg,.webm"
        className="hidden"
        onChange={onInputChange}
        disabled={disabled}
      />
      <span className="text-4xl">📁</span>
      <div className="text-center">
        <p className="font-medium text-gray-700">Drop an audio file here</p>
        <p className="text-sm text-gray-500 mt-1">WAV · MP3 · M4A · OGG · WebM</p>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
