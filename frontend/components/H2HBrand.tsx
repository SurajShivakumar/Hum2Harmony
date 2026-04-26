import Link from "next/link";

type Size = "sm" | "md" | "lg";

/** Rounded mark: two Hs as a monogram (read with the wordmark as “H to H”). */
const markBox: Record<Size, string> = {
  sm: "h-7 w-8",
  md: "h-9 w-10",
  lg: "h-12 w-14",
};

const markHSize: Record<Size, string> = {
  sm: "text-[0.7rem]",
  md: "text-xs",
  lg: "text-sm",
};

const textSize: Record<Size, string> = {
  sm: "text-base",
  md: "text-lg",
  lg: "text-2xl md:text-3xl",
};

export function H2HBrand({ size = "md" }: { size?: Size }) {
  return (
    <Link
      href="/"
      aria-label="H2H — home"
      className="group flex items-center gap-2.5 rounded-2xl -ml-1 pl-1.5 pr-2 py-0.5 transition-colors hover:bg-violet-50/80"
    >
      <div
        className={`${markBox[size]} flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 via-violet-600 to-indigo-600 font-black text-white shadow-md shadow-violet-400/20 ring-1 ring-inset ring-white/15`}
        aria-hidden
      >
        <span
          className={`${markHSize[size]} inline-flex items-center leading-none tracking-[-0.18em]`}
        >
          <span>H</span>
          <span>H</span>
        </span>
      </div>
      <span
        className={`${textSize[size]} font-extrabold tracking-tight leading-none text-slate-900 inline-flex items-baseline gap-0`}
      >
        <span className="text-slate-800">H</span>
        <span className="text-violet-600 font-bold mx-px">2</span>
        <span className="text-slate-800">H</span>
      </span>
    </Link>
  );
}
