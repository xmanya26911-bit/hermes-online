"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChatMessageView, { ActivityFeed } from "../components/ChatMessage";
import Composer from "../components/Composer";
import FilePanel from "../components/FilePanel";
import LoginGate from "../components/LoginGate";
import Sidebar from "../components/Sidebar";
import { apiFetch, checkHealth } from "../lib/api";
import { HermesSocket } from "../lib/hermes-socket";
import { activityLabelForEvent, type ChatMessage, type GatewayEvent, type SessionSummary, type ToolActivity } from "../lib/protocol";

let uid = 0;
const nid = (p: string) => `${p}-${Date.now()}-${(uid += 1)}`;

interface PendingApproval {
  id: string;
  sessionId: string;
  command?: string;
  choices: string[];
}

function normalizeSessions(raw: unknown): SessionSummary[] {
  const arr = Array.isArray(raw) ? raw : (raw as { sessions?: unknown[] })?.sessions ?? [];
  return (arr as Record<string, unknown>[]).map((s, i) => ({
    id: String(s["id"] ?? s["session_id"] ?? s["stored_session_id"] ?? `s-${i}`),
    title: String(s["title"] ?? s["name"] ?? "Untitled"),
    updated_at: (s["updated_at"] ?? s["updatedAt"] ?? "") as string,
    message_count: Number(s["message_count"] ?? s["messageCount"] ?? 0),
  }));
}

function normalizeHistory(raw: unknown): ChatMessage[] {
  const arr = Array.isArray(raw) ? raw : (raw as { messages?: unknown[] })?.messages ?? [];
  return (arr as Record<string, unknown>[]).map((m, i) => {
    const role = String(m["role"] ?? "assistant");
    const text = String(m["content"] ?? m["text"] ?? m["body"] ?? "");
    return { id: `h-${i}`, role: role === "user" ? "user" : "assistant", text };
  });
}

export default function Home() {
  const [authed, setAuthed] = useState(false);
  const [conn, setConn] = useState("idle");
  const [readyInfo, setReadyInfo] = useState<{ model: string; provider: string } | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [activities, setActivities] = useState<Record<string, ToolActivity[]>>({});
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState("");
  const [query, setQuery] = useState("");
  const [sideOpen, setSideOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [coldStart, setColdStart] = useState(false);
  const socketRef = useRef<HermesSocket | null>(null);
  const activeRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  activeRef.current = activeId;
  const activeMessages = useMemo(() => (activeId ? messages[activeId] ?? [] : []), [messages, activeId]);
  const activeActivities = useMemo(() => (activeId ? activities[activeId] ?? [] : []), [activities, activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeMessages.length, activeId]);

  const pushActivity = useCallback((sid: string, a: ToolActivity) => {
    setActivities((prev) => {
      const list = [...(prev[sid] ?? [])];
      const idx = list.findIndex((x) => x.id === a.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...a };
      else list.push(a);
      return { ...prev, [sid]: list.slice(-30) };
    });
  }, []);

  const appendDelta = useCallback((sid: string, kind: "assistant" | "thinking", text: string) => {
    if (!text) return;
    setMessages((prev) => {
      const list = [...(prev[sid] ?? [])];
      const last = list[list.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        last.text += text;
        return { ...prev, [sid]: list };
      }
      list.push({ id: nid("m"), role: "assistant", text, streaming: true });
      return { ...prev, [sid]: list };
    });
  }, []);

  const finalizeStream = useCallback((sid: string) => {
    setMessages((prev) => {
      const list = (prev[sid] ?? []).map((m) => (m.streaming ? { ...m, streaming: false } : m));
      return { ...prev, [sid]: list };
    });
    setBusy(false);
  }, []);

  const handleEvent = useCallback(
    (ev: GatewayEvent) => {
      const sid = ev.session_id ?? activeRef.current ?? "";
      if (!sid) return;
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      switch (ev.type) {
        case "message.delta":
          appendDelta(sid, "assistant", String(p["text"] ?? p["delta"] ?? ""));
          pushActivity(sid, { id: `stream-${sid}`, kind: "thinking", label: "Writing", state: "running" });
          break;
        case "message.interim":
          appendDelta(sid, "assistant", String(p["text"] ?? ""));
          break;
        case "thinking.delta":
        case "reasoning.delta":
          pushActivity(sid, { id: `think-${sid}`, kind: "thinking", label: "Thinking", detail: String(p["text"] ?? "").slice(0, 120), state: "running" });
          break;
        case "status.update":
          pushActivity(sid, { id: `status-${sid}`, kind: "status", label: activityLabelForEvent(ev), detail: String(p["text"] ?? p["status"] ?? "").slice(0, 160), state: "running" });
          break;
        case "tool.start":
        case "tool.generating":
        case "tool.progress": {
          const tool = String(p["tool"] ?? p["name"] ?? "tool");
          const tid = String(p["tool_call_id"] ?? p["id"] ?? tool);
          pushActivity(sid, { id: `tool-${tid}`, kind: "tool", label: activityLabelForEvent(ev), detail: JSON.stringify(p["args"] ?? p["input"] ?? "").slice(0, 160), state: "running" });
          break;
        }
        case "tool.complete": {
          const tool = String(p["tool"] ?? p["name"] ?? "tool");
          const tid = String(p["tool_call_id"] ?? p["id"] ?? tool);
          const ok = p["error"] == null && p["ok"] !== false;
          pushActivity(sid, { id: `tool-${tid}`, kind: "tool", label: ok ? "Finished" : "Tool error", detail: ok ? tool : String(p["error"] ?? "failed").slice(0, 200), state: ok ? "done" : "error" });
          break;
        }
        case "todo.updated": {
          const items = Array.isArray(p["todos"]) ? (p["todos"] as { text?: string; status?: string }[]) : [];
          const open = items.filter((t) => t.status !== "done").length;
          pushActivity(sid, { id: `todo-${sid}`, kind: "status", label: open ? `Plan: ${open} open` : "Plan complete", state: open ? "running" : "done" });
          break;
        }
        case "message.complete":
        case "background.complete":
          pushActivity(sid, { id: `stream-${sid}`, kind: "done", label: "Finished", state: "done" });
          finalizeStream(sid);
          void refreshSessions();
          break;
        case "approval.request":
        case "sudo.request":
        case "secret.request":
          setApprovals((prev) => [
            ...prev,
            { id: String(p["approval_id"] ?? p["id"] ?? nid("appr")), sessionId: sid, command: String(p["command"] ?? p["prompt"] ?? ""), choices: (p["choices"] as string[]) ?? ["once", "deny"] },
          ]);
          pushActivity(sid, { id: `appr-${sid}`, kind: "approval", label: "Needs approval", detail: String(p["command"] ?? "").slice(0, 160), state: "running" });
          break;
        case "session.info":
          if (p["title"]) {
            const title = String(p["title"]);
            setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, title } : s)));
          }
          break;
        case "error":
          setBanner(String(p["message"] ?? "Hermes reported an error."));
          pushActivity(sid, { id: `err-${Date.now()}`, kind: "error", label: "Error", detail: String(p["message"] ?? "").slice(0, 200), state: "error" });
          setBusy(false);
          break;
        default:
          break;
      }
    },
    [appendDelta, finalizeStream, pushActivity]
  );

  const refreshSessions = useCallback(async () => {
    try {
      const data = await apiFetch<unknown>("/api/sessions?limit=50");
      setSessions(normalizeSessions(data));
    } catch {
      /* sidebar keeps WS-created entries */
    }
  }, []);

  const init = useCallback(async () => {
    setBanner("");
    try {
      const pub = await apiFetch<{ model: string; provider: string }>("/api/config/public");
      setReadyInfo({ model: pub.model, provider: pub.provider });
    } catch {
      /* non-fatal */
    }
    try {
      const h = await checkHealth();
      if (!h.hermes_ready) setColdStart(true);
    } catch {
      /* socket reconnect loop surfaces it */
    }
    await refreshSessions();
    const sock = new HermesSocket();
    socketRef.current = sock;
    sock.onEvent = handleEvent;
    sock.onState = (s) => {
      setConn(s);
      if (s === "ready") setColdStart(false);
      if (s === "failed") setBusy(false);
    };
    sock.onError = (m) => setBanner(m);
    sock.connect();
  }, [handleEvent, refreshSessions]);

  useEffect(() => {
    const t = window.sessionStorage.getItem("hermes.authToken");
    if (!t) return;
    apiFetch("/api/auth/verify", { method: "POST", body: "{}" })
      .then(() => {
        setAuthed(true);
        void init();
      })
      .catch(() => window.sessionStorage.removeItem("hermes.authToken"));
    return () => socketRef.current?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureSession(): Promise<string> {
    const sock = socketRef.current;
    if (!sock) throw new Error("Not connected.");
    if (activeRef.current) return activeRef.current;
    const res = (await sock.createSession()) as { session_id: string };
    const sid = res.session_id;
    setSessions((prev) => [{ id: sid, title: "New conversation" }, ...prev]);
    setActiveId(sid);
    setMessages((prev) => ({ ...prev, [sid]: [] }));
    return sid;
  }

  async function onNew() {
    try {
      const sock = socketRef.current;
      if (!sock) return;
      const res = (await sock.createSession()) as { session_id: string };
      const sid = res.session_id;
      setSessions((prev) => [{ id: sid, title: "New conversation" }, ...prev]);
      setActiveId(sid);
      setMessages((prev) => ({ ...prev, [sid]: [] }));
      setActivities((prev) => ({ ...prev, [sid]: [] }));
      setBanner("");
    } catch (e) {
      setBanner(e instanceof Error ? e.message : "Could not create session.");
    }
  }

  async function onSelect(id: string) {
    setActiveId(id);
    setBanner("");
    const sock = socketRef.current;
    try {
      const data = await apiFetch<unknown>(`/api/sessions/${encodeURIComponent(id)}/messages?limit=200&order=latest`);
      const hist = normalizeHistory(data);
      setMessages((prev) => ({ ...prev, [id]: prev[id]?.length ? prev[id] : hist }));
    } catch {
      /* history is best-effort; live events still stream */
    }
    try {
      await sock?.resumeSession(id);
      const since = await sock?.eventsSince(id, 0);
      since?.events?.forEach(handleEvent);
    } catch {
      /* ignore */
    }
  }

  async function onSend(text: string) {
    setBanner("");
    try {
      const sid = await ensureSession();
      const sock = socketRef.current!;
      setMessages((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), { id: nid("m"), role: "user", text }] }));
      setMessages((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), { id: nid("m"), role: "assistant", text: "", streaming: true }] }));
      setBusy(true);
      await sock.submitPrompt(sid, text);
    } catch (e) {
      setBusy(false);
      setBanner(e instanceof Error ? e.message : "Send failed.");
    }
  }

  async function onStop() {
    const sid = activeRef.current;
    if (!sid) return;
    try {
      await socketRef.current?.interrupt(sid);
    } finally {
      finalizeStream(sid);
    }
  }

  async function onRegenerate() {
    const sid = activeRef.current;
    if (!sid || busy) return;
    const list = messages[sid] ?? [];
    const lastUser = [...list].reverse().find((m) => m.role === "user");
    if (lastUser) await onSend(lastUser.text);
  }

  async function onRename(id: string) {
    const cur = sessions.find((s) => s.id === id)?.title ?? "";
    const title = window.prompt("Rename conversation", cur);
    if (!title || !title.trim()) return;
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title: title.trim() }) });
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: title.trim() } : s)));
    } catch (e) {
      setBanner(e instanceof Error ? e.message : "Rename failed.");
    }
  }

  async function onDelete(id: string) {
    if (!window.confirm("Delete this conversation?")) return;
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (activeId === id) {
        const sock = socketRef.current;
        await sock?.closeSession(id).catch(() => null);
        setActiveId(null);
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (e) {
      setBanner(e instanceof Error ? e.message : "Delete failed.");
    }
  }

  async function onApproval(a: PendingApproval, choice: string) {
    try {
      await socketRef.current?.respondApproval(a.sessionId, choice, a.id);
      setApprovals((prev) => prev.filter((x) => x.id !== a.id));
    } catch (e) {
      setBanner(e instanceof Error ? e.message : "Approval response failed.");
    }
  }

  async function onAttach(file: File) {
    const text = (await file.text()).slice(0, 24000);
    const fenced = `\n\nAttached file \`${file.name}\`:\n\`\`\`\n${text}\n\`\`\``;
    await onSend(`Please use this file context.${fenced}`);
  }

  function signOut() {
    socketRef.current?.disconnect();
    window.sessionStorage.removeItem("hermes.authToken");
    setAuthed(false);
    setSessions([]);
    setMessages({});
    setActiveId(null);
  }

  if (!authed) {
    return (
      <LoginGate
        onAuthed={() => {
          setAuthed(true);
          void init();
        }}
      />
    );
  }

  const connLabel = conn === "ready" ? "connected" : conn === "connecting" ? "connecting…" : conn === "reconnecting" ? "reconnecting…" : conn === "failed" ? "failed" : "idle";

  return (
    <div className="flex h-screen overflow-hidden bg-ink-950">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        query={query}
        onQuery={setQuery}
        onSelect={(id) => void onSelect(id)}
        onNew={() => void onNew()}
        onRename={(id) => void onRename(id)}
        onDelete={(id) => void onDelete(id)}
        onSignOut={signOut}
        open={sideOpen}
        onClose={() => setSideOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex items-center gap-2 border-b border-ink-700 bg-ink-900/70 px-3 py-2.5 backdrop-blur">
          <button onClick={() => setSideOpen(true)} className="rounded-lg border border-ink-700 px-2 py-1 text-sm text-slate-300 md:hidden">☰</button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">{sessions.find((s) => s.id === activeId)?.title ?? "Hermes Agent"}</div>
            <div className="flex items-center gap-2 font-mono text-[10px] text-slate-500">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${conn === "ready" ? "bg-emerald-400" : conn === "failed" ? "bg-red-400" : "animate-pulse bg-amber-400"}`} />
              {connLabel}
              {readyInfo ? <span>· {readyInfo.provider}/{readyInfo.model}</span> : null}
            </div>
          </div>
          <div className="ml-auto flex gap-2">
            {busy ? (
              <button onClick={() => void onStop()} className="rounded-lg border border-red-500/50 px-2.5 py-1 text-xs text-red-300">■ Stop</button>
            ) : (
              <button onClick={() => void onRegenerate()} disabled={!activeId} className="rounded-lg border border-ink-700 px-2.5 py-1 text-xs text-slate-300 hover:text-accent-400 disabled:opacity-40">
                ⟳ Regenerate
              </button>
            )}
            <button onClick={() => setFilesOpen((v) => !v)} className={`rounded-lg border px-2.5 py-1 text-xs ${filesOpen ? "border-accent-600 text-accent-400" : "border-ink-700 text-slate-300"}`}>
              Files
            </button>
          </div>
        </header>

        {(banner || coldStart) && (
          <div className="border-b border-ink-700 bg-ink-900 px-4 py-2 text-xs">
            {coldStart ? <p className="text-amber-300">Render is cold-starting Hermes — first response can take ~60s. Stay on this page.</p> : null}
            {banner ? <p className="mt-0.5 text-red-300">{banner}</p> : null}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* Chat column */}
          <main className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl space-y-4 px-3 py-5 md:px-4">
                {activeId == null ? (
                  <div className="rounded-2xl border border-ink-700 bg-ink-900 p-6 text-center">
                    <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-500/15 font-mono text-2xl text-accent-400">☤</div>
                    <h2 className="text-base font-semibold text-white">Start a Hermes session</h2>
                    <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">
                      Hermes runs on Render with tools, memory, skills and streaming — powered by OpenCode Zen
                      (<span className="font-mono text-accent-400">muse-spark-1.3-contributor-free</span>). Type below to begin.
                    </p>
                    <button onClick={() => void onNew()} className="mt-4 rounded-lg bg-accent-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-400">
                      + New chat
                    </button>
                  </div>
                ) : (
                  <>
                    <ActivityFeed items={activeActivities.filter((a) => a.state === "running").slice(-6)} />
                    {activeMessages.map((m) => (
                      <ChatMessageView key={m.id} message={m} />
                    ))}
                    {approvals
                      .filter((a) => a.sessionId === activeId)
                      .map((a) => (
                        <div key={a.id} className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                          <div className="font-semibold text-amber-200">Hermes requests approval</div>
                          {a.command ? <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-amber-100/90">{a.command}</pre> : null}
                          <div className="mt-2 flex gap-2">
                            {a.choices.map((c) => (
                              <button key={c} onClick={() => void onApproval(a, c)} className="rounded-lg border border-amber-500/50 px-3 py-1 text-xs text-amber-100 hover:bg-amber-500/20">
                                {c}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    <div ref={bottomRef} />
                  </>
                )}
              </div>
            </div>
            <Composer busy={busy} connected={conn === "ready"} onSend={(t) => void onSend(t)} onStop={() => void onStop()} onAttach={(f) => void onAttach(f)} />
          </main>

          {/* File panel */}
          {filesOpen ? (
            <div className="hidden w-80 shrink-0 md:block">
              <FilePanel onInsertPath={(p) => void onSend(`Please look at \`${p}\` in the workspace.`)} />
            </div>
          ) : null}
        </div>
        {filesOpen ? (
          <div className="max-h-64 overflow-y-auto border-t border-ink-700 md:hidden">
            <FilePanel onInsertPath={(p) => void onSend(`Please look at \`${p}\` in the workspace.`)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
