import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hermes Online — AI Coding Agent",
  description: "Browser frontend for the Hermes agent (Render backend, OpenCode Zen).",
};

export const viewport: Viewport = {
  themeColor: "#0a0e14",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-ink-950 text-slate-100 antialiased">{children}</body>
    </html>
  );
}
