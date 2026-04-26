import type { Metadata } from "next";
import "./globals.css";
import { H2HBrand } from "@/components/H2HBrand";

export const metadata: Metadata = {
  title: "H2H",
  description: "H2H — hum a melody, get a full choral score.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gradient-to-br from-slate-50 via-violet-50/40 to-slate-100 text-gray-900 antialiased">
        <header className="border-b border-slate-200/60 bg-white/80 backdrop-blur-md sticky top-0 z-10">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-start">
            <H2HBrand size="md" />
          </div>
        </header>
        <main className="max-w-4xl mx-auto px-4 sm:px-6 py-10 md:py-12">{children}</main>
        <footer className="text-center text-xs text-slate-400 pb-10 max-w-4xl mx-auto px-6">
          <span className="text-slate-500 font-medium">H2H</span>
          <span className="mx-2">·</span>
          <span>Built at UWB Hacks 2026</span>
        </footer>
      </body>
    </html>
  );
}
