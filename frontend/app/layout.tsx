import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hum to Harmony",
  description: "Hum a melody. Get a full SATB choral arrangement in seconds.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gradient-to-br from-slate-50 via-violet-50 to-slate-100 text-gray-900 antialiased">
        <header className="border-b border-violet-100 bg-white/70 backdrop-blur-md sticky top-0 z-10">
          <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-3">
            <span className="text-2xl">🎵</span>
            <span className="text-xl font-bold text-violet-700 tracking-tight">Hum to Harmony</span>
            <span className="hidden sm:inline text-sm text-gray-400 ml-2">
              AI-powered SATB arranger
            </span>
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-6 py-12">{children}</main>
        <footer className="text-center text-xs text-gray-400 pb-8">
          Built at UWB Hacks 2026 · No paid APIs · No accounts needed
        </footer>
      </body>
    </html>
  );
}
