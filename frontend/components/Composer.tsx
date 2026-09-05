"use client";

import { useRef, useState } from "react";

interface Props {
  busy: boolean;
  connected: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onAttach?: (file: File) => void;
}

export default function Composer({ busy, connected, onSend, onStop, onAttach }: Props) {
  const [value, setValue] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function send() {
    const text = value.trim();
    if (!text || busy || !connected) return;
    onSend(text);
    setValue("");
  }

  return (
    <div className="border-t border-ink-700 bg-ink-950/80 p-3 backdrop-blur md:p-4">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border border-ink-700 bg-ink-900 focus-within:border-accent-600">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={3}
            placeholder={connected ? "Ask Hermes… (Enter to send, Shift+Enter for newline)" : "Connecting…"}
            disabled={!connected || busy}
            className="max-h-48 w-full resize-y bg-transparent px-4 pb-1 pt-3 font-mono text-sm text-slate-100 outline-none placeholder:font-sans placeholder:text-slate-600 disabled:opacity-50"
          />
          <div className="flex items-center gap-2 px-3 pb-2.5">
            {onAttach ? (
              <>
                <button
                  title="Attach a text file"
                  onClick={() => fileRef.current?.click()}
                  disabled={!connected || busy}
                  className="rounded-lg border border-ink-700 px-2 py-1 text-xs text-slate-400 hover:text-accent-400 disabled:opacity-40"
                >
                  📎
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  accept=".txt,.md,.json,.ts,.tsx,.js,.py,.yaml,.yml,.toml,.css,.html"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onAttach(f);
                    e.target.value = "";
                  }}
                />
              </>
            ) : null}
            <span className="font-mono text-[10px] text-slate-600">code-friendly · markdown · streaming</span>
            <div className="ml-auto flex gap-2">
              {busy ? (
                <button onClick={onStop} className="rounded-lg bg-red-500/90 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-400">
                  ■ Stop
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={!value.trim() || !connected}
                  className="rounded-lg bg-accent-500 px-5 py-1.5 text-sm font-semibold text-ink-950 hover:bg-accent-400 disabled:opacity-40"
                >
                  Send ⏎
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
