// Hermes WS client speaking the REAL `hermes serve` JSON-RPC protocol over
// /api/ws (same surface the Desktop app uses: session.create, prompt.submit,
// session.interrupt, session.events.since, gateway.ping + message.delta /
// tool.* / status.update / approval.request events).
//
// Auth: our edge expects ?auth=<HERMES_AUTH_TOKEN> (browsers can't set WS
// headers) and translates it to Hermes' internal ?token= server-side.

import { authToken, backendUrl } from "./api";
import type { GatewayEvent, JsonRpcId, JsonRpcResponse } from "./protocol";

export type ConnectionState = "idle" | "connecting" | "ready" | "reconnecting" | "failed";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function toWs(base: string): string {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/+$/, "");
}

export class HermesSocket {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<JsonRpcId, Pending>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private hbCount = 0;
  private wantClose = false;
  private reconnectAttempt = 0;
  private lastSeenSeq = 0;

  state: ConnectionState = "idle";
  onEvent: (ev: GatewayEvent) => void = () => {};
  onState: (s: ConnectionState) => void = () => {};
  onError: (msg: string) => void = () => {};

  get lastSeen(): number {
    return this.lastSeenSeq;
  }

  connect(): void {
    this.wantClose = false;
    this.reconnectAttempt = 0;
    this.dial();
  }

  disconnect(): void {
    this.wantClose = true;
    this.cleanup();
    this.setState("idle");
  }

  private setState(s: ConnectionState) {
    this.state = s;
    this.onState(s);
  }

  private dial() {
    const base = backendUrl();
    const token = authToken();
    if (!base || !token) {
      this.setState("failed");
      this.onError("Missing backend URL or auth token.");
      return;
    }
    this.cleanupSocketOnly();
    this.setState(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    const url = `${toWs(base)}/api/ws?auth=${encodeURIComponent(token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      // Wait for gateway.ready before declaring ready (with timeout -> reconnect).
      setTimeout(() => {
        if (this.state === "connecting" || this.state === "reconnecting") {
          // Still no gateway.ready; keep waiting briefly, heartbeat will catch dead sockets.
        }
      }, 5000);
    };
    ws.onmessage = (msg) => this.handleFrame(String(msg.data));
    ws.onerror = () => {
      this.onError("Connection error. Retrying…");
    };
    ws.onclose = (ev) => {
      this.cleanupSocketOnly();
      if (this.wantClose) return;
      if (ev.code === 4401) {
        this.setState("failed");
        this.onError("Authentication failed (code 4401). Sign in again.");
        return;
      }
      if (ev.code === 4403) {
        this.setState("failed");
        this.onError("Origin rejected by backend (code 4403).");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.wantClose) return;
    this.reconnectAttempt += 1;
    const backoff = Math.min(1000 * 2 ** Math.min(this.reconnectAttempt, 5), 15000);
    this.setState("reconnecting");
    setTimeout(() => {
      if (!this.wantClose) this.dial();
    }, backoff);
  }

  private cleanupSocketOnly() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }

  private cleanup() {
    this.cleanupSocketOnly();
    this.pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(new Error("disconnected"));
    });
    this.pending.clear();
  }

  private startHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.hbCount += 1;
      try {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: `heartbeat-${this.hbCount}`, method: "gateway.ping", params: {} }));
      } catch {
        /* reconnect loop handles it */
      }
    }, 15000);
  }

  private handleFrame(raw: string) {
    let frame: JsonRpcResponse;
    try {
      frame = JSON.parse(raw) as JsonRpcResponse;
    } catch {
      this.onError("Received a malformed event from the backend (ignored).");
      return;
    }
    if (frame.method === "event" && frame.params) {
      const ev = frame.params;
      if (typeof ev.seq === "number" && ev.seq > this.lastSeenSeq) this.lastSeenSeq = ev.seq;
      if (ev.type === "gateway.ready") {
        this.reconnectAttempt = 0;
        this.setState("ready");
        this.startHeartbeat();
      }
      try {
        this.onEvent(ev);
      } catch {
        /* never let UI handlers kill the socket */
      }
      return;
    }
    if (frame.id !== undefined && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id)!;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.error) p.reject(new Error(frame.error.message || `RPC error ${frame.error.code}`));
      else p.resolve(frame.result ?? null);
    }
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 60000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected. Waiting for reconnect…"));
        return;
      }
      this.seq += 1;
      const id: JsonRpcId = `w${this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error("send failed"));
      }
    });
  }

  // ---- typed helpers (real Hermes methods) ----
  createSession(cwd?: string): Promise<{ session_id: string } & Record<string, unknown>> {
    return this.call("session.create", cwd ? { cwd } : {}) as Promise<{ session_id: string } & Record<string, unknown>>;
  }
  resumeSession(session_id: string): Promise<unknown> {
    return this.call("session.resume", { session_id });
  }
  submitPrompt(session_id: string, text: string): Promise<unknown> {
    return this.call("prompt.submit", { session_id, text }, 1_800_000);
  }
  interrupt(session_id: string): Promise<unknown> {
    return this.call("session.interrupt", { session_id }, 15000);
  }
  closeSession(session_id: string): Promise<unknown> {
    return this.call("session.close", { session_id }, 15000).catch(() => null);
  }
  eventsSince(session_id: string, last_seen: number): Promise<{ events: GatewayEvent[] }> {
    return this.call("session.events.since", { session_id, last_seen }, 20000) as Promise<{ events: GatewayEvent[] }>;
  }
  respondApproval(session_id: string, choice: string, approval_id?: string): Promise<unknown> {
    return this.call("approval.respond", { session_id, choice, ...(approval_id ? { approval_id } : {}) }, 30000);
  }
}
