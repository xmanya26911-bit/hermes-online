// Authenticated REST helper. The browser only ever holds HERMES_AUTH_TOKEN
// (a gate secret), never the OpenCode key or Hermes internal session token.

export function backendUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_HERMES_BACKEND_URL ?? "").trim().replace(/\/+$/, "");
  if (typeof window !== "undefined") {
    const override = window.sessionStorage.getItem("hermes.backendUrl")?.trim();
    if (override) return override.replace(/\/+$/, "");
  }
  return raw;
}

export function authToken(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem("hermes.authToken") ?? "";
}

export class BackendError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function friendlyMessage(status: number, code: string, fallback: string): string {
  if (status === 401) return "Invalid auth token. Check HERMES_AUTH_TOKEN and sign in again.";
  if (status === 403) return "Origin not allowed by the backend (CORS).";
  if (status === 503 && code === "backend_starting")
    return "Render is cold-starting Hermes. Wait ~30–60s and retry.";
  if (status === 502 && code === "provider_auth")
    return "Model provider rejected its API key. Check OPENCODE_ZEN_API_KEY on Render.";
  if (status === 502 && code === "provider_rate_limited")
    return "Model provider rate limit reached. Wait a moment and retry.";
  if (status === 504) return "Backend timed out. Retry shortly.";
  return fallback || `Request failed (${status}).`;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const base = backendUrl();
  if (!base) throw new BackendError(0, "no_backend", "Backend URL is not configured.");
  const token = authToken();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } })?.error ?? {};
    throw new BackendError(res.status, err.code ?? "http_error", friendlyMessage(res.status, err.code ?? "", err.message ?? text));
  }
  return data as T;
}

export async function checkHealth(): Promise<{ ok: boolean; hermes_ready: boolean }> {
  const base = backendUrl();
  const res = await fetch(`${base}/api/health`, { cache: "no-store" });
  if (!res.ok) throw new Error(`health ${res.status}`);
  return (await res.json()) as { ok: boolean; hermes_ready: boolean };
}

export async function checkReady(): Promise<boolean> {
  try {
    const base = backendUrl();
    const res = await fetch(`${base}/api/ready`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}
