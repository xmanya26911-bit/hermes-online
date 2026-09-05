"use client";

import { useState } from "react";
import { apiFetch, backendUrl } from "../lib/api";

export default function LoginGate({ onAuthed }: { onAuthed: (token: string) => void }) {
  const [token, setToken] = useState("");
  const [backend, setBackend] = useState(backendUrl());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!token.trim()) {
      setError("Enter the HERMES_AUTH_TOKEN from Render.");
      return;
    }
    const base = (backend || backendUrl()).trim().replace(/\/+$/, "");
    if (!base) {
      setError("Backend URL is missing. Set NEXT_PUBLIC_HERMES_BACKEND_URL.");
      return;
    }
    setBusy(true);
    try {
      window.sessionStorage.setItem("hermes.backendUrl", base);
      window.sessionStorage.setItem("hermes.authToken", token.trim());
      await apiFetch("/api/auth/verify", { method: "POST", body: "{}" });
      onAuthed(token.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 p-6">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-ink-700 bg-ink-900 p-8 shadow-2xl">
        <div className="mb-1 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-500/15 font-mono text-xl text-accent-400">☤</div>
          <div>
            <h1 className="text-lg font-semibold text-white">Hermes Online</h1>
            <p className="text-xs text-slate-400">Private gateway · Vercel → Render → Hermes → OpenCode Zen</p>
          </div>
        </div>
        <p className="mb-5 mt-4 text-sm leading-relaxed text-slate-300">
          This backend can execute code. Sign in with the shared <span className="font-mono text-accent-400">HERMES_AUTH_TOKEN</span> to
          continue. The model key stays on Render and is never sent to the browser.
        </p>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Backend URL</label>
        <input
          value={backend}
          onChange={(e) => setBackend(e.target.value)}
          placeholder="https://YOUR-RENDER-SERVICE.onrender.com"
          spellCheck={false}
          className="mb-4 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-accent-600"
        />
        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">Auth token</label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="HERMES_AUTH_TOKEN"
          autoComplete="current-password"
          className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-accent-600"
        />
        {error ? <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="mt-5 w-full rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-accent-400 disabled:opacity-50"
        >
          {busy ? "Verifying…" : "Connect to Hermes"}
        </button>
        <p className="mt-4 text-center text-[11px] text-slate-500">Cold starts on Render can take ~60s on first connect.</p>
      </form>
    </div>
  );
}
