"use client";

import type { SessionSummary } from "../lib/protocol";

interface Props {
  sessions: SessionSummary[];
  activeId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onSignOut: () => void;
  open: boolean;
  onClose: () => void;
}

export default function Sidebar(p: Props) {
  const filtered = p.sessions.filter((s) => s.title.toLowerCase().includes(p.query.toLowerCase()));
  return (
    <>
      <div
        className={`fixed inset-0 z-30 bg-black/60 md:hidden ${p.open ? "" : "hidden"}`}
        onClick={p.onClose}
        aria-hidden
      />
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-ink-700 bg-ink-900 transition-transform md:static md:translate-x-0 ${
          p.open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-500/15 font-mono text-lg text-accent-400">☤</div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">Hermes Online</div>
            <div className="truncate font-mono text-[10px] text-slate-500">muse-spark-1.3 · zen</div>
          </div>
          <button onClick={p.onNew} title="New chat" className="ml-auto rounded-lg border border-ink-700 px-2.5 py-1.5 text-xs text-slate-200 hover:border-accent-600 hover:text-accent-400">
            + New
          </button>
        </div>
        <div className="px-4 pb-2">
          <input
            value={p.query}
            onChange={(e) => p.onQuery(e.target.value)}
            placeholder="Search conversations…"
            className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-accent-600"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-slate-500">No conversations yet.</p>
          ) : (
            filtered.map((s) => (
              <div
                key={s.id}
                className={`group mb-0.5 flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-2 text-sm hover:bg-ink-800 ${
                  s.id === p.activeId ? "bg-ink-800 text-white" : "text-slate-300"
                }`}
                onClick={() => {
                  p.onSelect(s.id);
                  p.onClose();
                }}
                title={s.title}
              >
                <span className="min-w-0 flex-1 truncate">{s.title || "Untitled"}</span>
                <button
                  title="Rename"
                  className="hidden rounded px-1 text-slate-500 hover:text-accent-400 group-hover:block"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onRename(s.id);
                  }}
                >
                  ✎
                </button>
                <button
                  title="Delete"
                  className="hidden rounded px-1 text-slate-500 hover:text-red-400 group-hover:block"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onDelete(s.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
        <div className="border-t border-ink-700 p-3">
          <button onClick={p.onSignOut} className="w-full rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-slate-400 hover:text-red-300">
            Sign out (forget token)
          </button>
        </div>
      </aside>
    </>
  );
}
