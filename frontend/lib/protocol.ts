// Hermes JSON-RPC/WS protocol surface (mirrors the real `hermes serve` backend:
// tui_gateway/server.py dispatcher over /api/ws, newline-delimited JSON-RPC).
// See backend research notes in README for method/event sources.

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: "event";
  params?: GatewayEvent;
}

export interface GatewayEvent {
  type: GatewayEventName;
  session_id?: string;
  seq?: number;
  payload?: Record<string, unknown>;
}

export type GatewayEventName =
  | "gateway.ready"
  | "session.info"
  | "session.usage"
  | "message.start"
  | "message.delta"
  | "message.interim"
  | "message.complete"
  | "thinking.delta"
  | "reasoning.delta"
  | "reasoning.available"
  | "status.update"
  | "tool.start"
  | "tool.progress"
  | "tool.complete"
  | "tool.generating"
  | "todo.updated"
  | "clarify.request"
  | "approval.request"
  | "sudo.request"
  | "secret.request"
  | "background.complete"
  | "error"
  | (string & {});

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean;
  seq?: number;
}

export interface ToolActivity {
  id: string;
  kind: "tool" | "status" | "thinking" | "approval" | "done" | "error";
  label: string;
  detail?: string;
  state: "running" | "done" | "error";
  seq?: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  updated_at?: string;
  message_count?: number;
}

/** Human-friendly agent activity label derived from REAL Hermes events (never faked). */
export function activityLabelForEvent(ev: GatewayEvent): string {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "message.start":
      return "Thinking";
    case "thinking.delta":
    case "reasoning.delta":
      return "Thinking";
    case "status.update":
      return String(p["text"] ?? p["status"] ?? "Working");
    case "tool.start":
    case "tool.generating":
    case "tool.progress": {
      const tool = String(p["tool"] ?? p["name"] ?? "tool");
      if (/terminal|shell|command|exec/i.test(tool)) return "Running command";
      if (/read|cat|open/i.test(tool)) return "Reading file";
      if (/write|edit|apply|patch/i.test(tool)) return "Writing file";
      if (/search|grep|find|glob/i.test(tool)) return "Searching";
      return `Using tool: ${tool}`;
    }
    case "tool.complete":
      return "Finished";
    case "message.complete":
    case "background.complete":
      return "Finished";
    case "approval.request":
      return "Needs approval";
    case "error":
      return "Error";
    default:
      return String(ev.type);
  }
}
