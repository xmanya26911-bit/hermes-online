"use client";

import { useState } from "react";
import { apiFetch } from "../lib/api";

interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
}

export default function FilePanel({ onInsertPath }: { onInsertPath: (path: string) => void }) {
  const [cwd, setCwd] = useState(".");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function list(path: string) {
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch<{ entries?: Entry[]; files?: Entry[] }>(`/api/files?path=${encodeURIComponent(path)}`);
      setEntries(data.entries ?? data.files ?? []);
      setCwd(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "File listing failed.");
    } finally {
      setBusy(false);
    }
  }

  async function read(path: string) {
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch<{ content?: string; text?: string }>(`/api/files/read?path=${encodeURIComponent(path)}`);
      setPreview((data.content ?? data.text ?? "").slice(0, 8000));
    } catch (e) {
      setError(e instanceof Error ? e.message : "File read failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col border-l border-ink-700 bg-ink-900">
      <div className="border-b border-ink-700 p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Project files</div>
        <div className="flex gap-1.5">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void list(cwd);
            }}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-accent-600"
          />
          <button onClick={() => void list(cwd)} disabled={busy} className="rounded-md border border-ink-700 px-2 text-xs text-slate-300 hover:text-accent-400">
            Go
          </button>
        </div>
        {error ? <p className="mt-2 text-[11px] text-red-300">{error}</p> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {entries.map((e) => (
          <button
            key={e.path}
            onClick={() => (e.is_dir ? void list(e.path) : void read(e.path))}
            onDoubleClick={() => onInsertPath(e.path)}
            title="Click to open · double-click to insert path"
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[12px] text-slate-300 hover:bg-ink-800"
          >
            <span>{e.is_dir ? "📁" : "📄"}</span>
            <span className="truncate">{e.name}</span>
          </button>
        ))}
        {entries.length === 0 && !error ? <p className="p-3 text-[11px] text-slate-600">Press Go to list the workspace.</p> : null}
        {preview ? <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-ink-700 bg-black/40 p-2 font-mono text-[11px] text-slate-300">{preview}</pre> : null}
      </div>
    </div>
  );
}
