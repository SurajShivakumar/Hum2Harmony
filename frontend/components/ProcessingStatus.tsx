"use client";

type Status = "transcribing" | "notes_ready" | "harmonizing" | "complete" | "failed";

interface Step {
  label: string;
  activeOn: Status[];
  doneOn: Status[];
}

const STEPS: Step[] = [
  {
    label: "Detecting chords…",
    activeOn: ["harmonizing"],
    doneOn: ["complete"],
  },
  {
    label: "Assigning voice parts…",
    activeOn: ["harmonizing"],
    doneOn: ["complete"],
  },
  {
    label: "Generating MusicXML…",
    activeOn: ["harmonizing"],
    doneOn: ["complete"],
  },
];

export default function ProcessingStatus({ status }: { status: Status }) {
  return (
    <div className="flex flex-col gap-5 w-full max-w-sm">
      {STEPS.map((step, i) => {
        const done = step.doneOn.includes(status);
        const active = step.activeOn.includes(status);

        return (
          <div key={i} className="flex items-center gap-4">
            <div
              className={[
                "flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold transition-all duration-500",
                done
                  ? "bg-violet-600 text-white"
                  : active
                  ? "bg-violet-100 text-violet-600 border-2 border-violet-400"
                  : "bg-gray-100 text-gray-400",
              ].join(" ")}
            >
              {done ? "✓" : active ? <span className="animate-spin inline-block">◌</span> : i + 1}
            </div>
            <span
              className={[
                "text-base font-medium transition-colors duration-300",
                done ? "text-violet-700" : active ? "text-gray-900" : "text-gray-400",
              ].join(" ")}
            >
              {step.label}
            </span>
          </div>
        );
      })}

      {status === "failed" && (
        <p className="text-sm text-red-500 mt-2 text-center">
          Harmonization failed. Please go back and try again.
        </p>
      )}
    </div>
  );
}
