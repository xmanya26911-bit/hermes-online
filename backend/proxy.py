"""Hermes Online edge proxy (Render Web Service).

Architecture:
  Browser (Vercel) --HTTPS/WSS, Bearer HERMES_AUTH_TOKEN--> this edge (:$PORT)
      --loopback, X-Hermes-Session-Token--> `hermes serve` (:HERMES_PORT)
      --OPENCODE_ZEN_API_KEY--> https://opencode.ai/zen/v1/responses (muse-spark-1.3-contributor-free)

Why an edge instead of exposing `hermes serve` directly:
  * Hermes' dashboard server allowlists CORS to loopback only (see
    hermes_cli/web_server.py allow_origin_regex) and its WS auth is a single
    shared session token. The edge adds a production auth boundary (our
    HERMES_AUTH_TOKEN), strict CORS for the Vercel origin, health/readiness
    for Render + cold-start UX, and never forwards provider secrets.
  * Hermes itself stays the agent: every /api/* REST call and /api/ws
    JSON-RPC frame (session.create, prompt.submit, message.delta,
    tool.start/progress/complete, approval.request, session.events.since,
    ...) is proxied verbatim. No mocked responses, no fake tool events.

Endpoints (outer):
  GET  /api/health         public, always 200 when edge is alive
  GET  /api/ready          public, 200 only when hermes serve is reachable
  GET  /api/config/public  public, safe browser config (no secrets)
  POST /api/auth/verify    Bearer check, 200 {ok:true} or 401
  ALL  /api/*              Bearer required, proxied to hermes serve
  WS   /api/ws, /api/events, /api/pub, /api/console, /api/pty
                           Bearer via ?auth= query (browsers cannot set WS
                           headers), proxied with ?token=<internal>
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import shutil
import subprocess
import time
from pathlib import Path
from typing import Awaitable, Callable, Optional
from urllib.parse import urlencode

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response, StreamingResponse
import websockets.client as ws_client

log = logging.getLogger("hermes-edge")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

HERMES_PORT = int(os.getenv("HERMES_PORT", "12719"))
HERMES_HOST = "127.0.0.1"
HERMES_BASE = f"http://{HERMES_HOST}:{HERMES_PORT}"
BOOT_TIMEOUT_S = float(os.getenv("HERMES_BOOT_TIMEOUT_S", "180"))
START_TIME = time.time()

# --- secrets (server-side only) ------------------------------------------------
AUTH_TOKEN = (os.getenv("HERMES_AUTH_TOKEN", "") or "").strip()
INTERNAL_TOKEN = (os.getenv("HERMES_DASHBOARD_SESSION_TOKEN", "") or "").strip()
if not INTERNAL_TOKEN:
    INTERNAL_TOKEN = secrets.token_urlsafe(32)
    os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = INTERNAL_TOKEN

HERMES_MODEL = (os.getenv("HERMES_MODEL", "muse-spark-1.3-contributor-free") or "").strip()
HERMES_PROVIDER = (os.getenv("HERMES_PROVIDER", "opencode-zen") or "").strip()
ZEN_BASE_URL = (os.getenv("OPENCODE_ZEN_BASE_URL", "https://opencode.ai/zen/v1") or "").strip()

ENV_NAME = (os.getenv("ENV", os.getenv("RENDER_ENV", "production")) or "production").lower()


def allowed_origins() -> list[str]:
    raw = (os.getenv("FRONTEND_ORIGIN", "") or "").strip()
    origins = [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
    if ENV_NAME != "production":
        for local in ("http://localhost:3000", "http://127.0.0.1:3000"):
            if local not in origins:
                origins.append(local)
    return origins


def _is_origin_allowed(origin: str | None) -> bool:
    if not origin:
        return True  # same-origin / curl / health probes
    origin = origin.rstrip("/")
    return origin in allowed_origins()


def _cors_headers(origin: str | None) -> dict[str, str]:
    headers: dict[str, str] = {"Vary": "Origin"}
    if origin and _is_origin_allowed(origin):
        headers["Access-Control-Allow-Origin"] = origin
    return headers


def _auth_ok(request: Request) -> bool:
    if not AUTH_TOKEN:
        return False  # fail closed: refuse everything until configured
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        import hmac

        return hmac.compare_digest(header[7:].strip(), AUTH_TOKEN)
    # Browsers cannot set headers on WebSocket handshakes -> allow ?auth=
    query_token = request.query_params.get("auth", "")
    if query_token:
        import hmac

        return hmac.compare_digest(query_token.strip(), AUTH_TOKEN)
    return False


def _json_error(status: int, code: str, message: str, origin: str | None = None):
    payload = {"ok": False, "error": {"code": code, "message": message}}
    return JSONResponse(status_code=status, content=payload, headers=_cors_headers(origin))


# --- hermes serve lifecycle -----------------------------------------------------
_hermes_proc: Optional[subprocess.Popen] = None
_hermes_ready = asyncio.Event()
_http = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0))


def _hermes_bin() -> str:
    found = shutil.which("hermes")
    if found:
        return found
    # Managed installs (install.sh / Docker) put it on PATH via venv; fall back to module.
    return ""


async def _wait_for_hermes() -> None:
    deadline = time.time() + BOOT_TIMEOUT_S
    headers = {"X-Hermes-Session-Token": INTERNAL_TOKEN}
    while time.time() < deadline:
        try:
            r = await _http.get(f"{HERMES_BASE}/api/health", headers=headers)
            if r.status_code < 500:
                _hermes_ready.set()
                log.info("hermes serve is reachable (status=%s)", r.status_code)
                return
        except Exception:
            pass
        await asyncio.sleep(2.0)
    log.error("hermes serve did not become ready within %ss", BOOT_TIMEOUT_S)


async def _spawn_hermes() -> None:
    global _hermes_proc
    hermes_home = os.getenv("HERMES_HOME", "/data/.hermes")
    workspace = os.getenv("HERMES_WORKSPACE", "/data/workspace")
    Path(hermes_home).mkdir(parents=True, exist_ok=True)
    Path(workspace).mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env["HERMES_DASHBOARD_SESSION_TOKEN"] = INTERNAL_TOKEN

    bin_path = _hermes_bin()
    if bin_path:
        cmd = [bin_path, "serve", "--host", HERMES_HOST, "--port", str(HERMES_PORT)]
    else:
        cmd = ["python", "-m", "hermes_cli.main", "serve", "--host", HERMES_HOST, "--port", str(HERMES_PORT)]
    log.info("spawning hermes: %s (HERMES_HOME=%s)", " ".join(cmd), hermes_home)
    _hermes_proc = subprocess.Popen(cmd, env=env)  # noqa: S603 - fixed argv, no shell
    await _wait_for_hermes()


# --- app ------------------------------------------------------------------------
app = FastAPI(title="hermes-online-edge", version="1.0.0", docs_url=None, redoc_url=None)


@app.middleware("http")
async def cors_and_logging(request: Request, call_next: Callable[[Request], Awaitable[Response]]):
    origin = request.headers.get("origin")
    if request.method == "OPTIONS":
        headers = {
            **_cors_headers(origin),
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Max-Age": "600",
        }
        return Response(status_code=204, headers=headers)
    if origin and not _is_origin_allowed(origin):
        return _json_error(403, "cors_forbidden", "Origin not allowed.", origin)
    try:
        response = await call_next(request)
    except Exception:  # never leak tracebacks/secrets
        log.exception("edge request failed: %s %s", request.method, request.url.path)
        return _json_error(502, "bad_gateway", "Backend request failed.", origin)
    if origin and _is_origin_allowed(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    return response


@app.on_event("startup")
async def on_startup() -> None:
    if not AUTH_TOKEN or len(AUTH_TOKEN) < 16:
        log.warning("HERMES_AUTH_TOKEN missing/short: all /api/* calls will return 401 until set")
    asyncio.create_task(_spawn_hermes())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await _http.aclose()
    if _hermes_proc and _hermes_proc.poll() is None:
        _hermes_proc.terminate()


# --- public endpoints -------------------------------------------------------------
@app.get("/api/health")
async def health(request: Request):
    return JSONResponse(
        {
            "ok": True,
            "edge": "up",
            "hermes_ready": _hermes_ready.is_set(),
            "uptime_s": int(time.time() - START_TIME),
        },
        headers=_cors_headers(request.headers.get("origin")),
    )


@app.get("/api/ready")
async def ready(request: Request):
    if not _hermes_ready.is_set():
        return JSONResponse(
            {"ok": False, "hermes_ready": False, "hint": "Render cold start: Hermes is still booting."},
            status_code=503,
            headers=_cors_headers(request.headers.get("origin")),
        )
    return JSONResponse({"ok": True, "hermes_ready": True}, headers=_cors_headers(request.headers.get("origin")))


@app.get("/api/config/public")
async def public_config(request: Request):
    return JSONResponse(
        {
            "model": HERMES_MODEL,
            "provider": HERMES_PROVIDER,
            "providerBaseUrl": ZEN_BASE_URL,
            "features": {
                "streaming": True,
                "tools": True,
                "sessions": True,
                "files": True,
                "attachments": True,
            },
        },
        headers=_cors_headers(request.headers.get("origin")),
    )


@app.post("/api/auth/verify")
async def auth_verify(request: Request):
    if not _auth_ok(request):
        return _json_error(401, "unauthorized", "Invalid or missing auth token.", request.headers.get("origin"))
    return JSONResponse({"ok": True}, headers=_cors_headers(request.headers.get("origin")))


# --- authenticated REST proxy -------------------------------------------------------
HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"}


def _require_auth(request: Request) -> Optional[JSONResponse]:
    if not AUTH_TOKEN:
        return _json_error(503, "auth_not_configured", "Server auth is not configured.", request.headers.get("origin"))
    if not _auth_ok(request):
        return _json_error(401, "unauthorized", "Invalid or missing auth token.", request.headers.get("origin"))
    if not _hermes_ready.is_set():
        return _json_error(503, "backend_starting", "Hermes is still starting (Render cold start). Retry shortly.", request.headers.get("origin"))
    return None


def _map_provider_error(status: int, body: str) -> tuple[str, str]:
    lowered = (body or "").lower()
    if status == 401 or "invalid api key" in lowered or "incorrect api key" in lowered:
        return ("provider_auth", "Model provider rejected the API key. Check OPENCODE_ZEN_API_KEY on Render.")
    if status == 429 or "rate limit" in lowered or "too many requests" in lowered:
        return ("provider_rate_limited", "Model provider rate limit reached. Wait and retry.")
    if "overloaded" in lowered or status == 529:
        return ("provider_overloaded", "Model provider is overloaded. Retry shortly.")
    if status >= 500:
        return ("provider_error", "Model provider returned an error. Retry shortly.")
    return ("upstream_error", "Hermes backend returned an error.")


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def rest_proxy(path: str, request: Request):
    if path in ("health", "ready", "config/public", "auth/verify"):
        return _json_error(404, "not_found", "Unknown endpoint.", request.headers.get("origin"))
    denied = _require_auth(request)
    if denied:
        return denied

    # Rebuild target URL, translating our ?auth= into nothing (never forward it)
    # and ensuring Hermes ?token= download endpoints get the internal token.
    query = dict(request.query_params)
    query.pop("auth", None)
    if path.startswith("files/download") or "download" in path:
        query.setdefault("token", INTERNAL_TOKEN)
    target = f"{HERMES_BASE}/api/{path}"
    if query:
        target += "?" + urlencode(query)

    body = await request.body()
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
    headers["X-Hermes-Session-Token"] = INTERNAL_TOKEN
    headers.pop("authorization", None)

    try:
        upstream = await _http.request(request.method, target, content=body or None, headers=headers)
    except httpx.ConnectError:
        return _json_error(502, "backend_unreachable", "Hermes backend is unreachable.", request.headers.get("origin"))
    except httpx.TimeoutException:
        return _json_error(504, "backend_timeout", "Hermes backend timed out.", request.headers.get("origin"))

    if upstream.status_code in (401, 429, 502, 529) or upstream.status_code >= 500:
        try:
            text = upstream.text[:2000]
        except Exception:
            text = ""
        code, message = _map_provider_error(upstream.status_code, text)
        # Only remap when the body looks like a provider/model failure; otherwise proxy verbatim.
        if any(k in text.lower() for k in ("api key", "rate limit", "overloaded", "model", "provider")):
            return JSONResponse({"ok": False, "error": {"code": code, "message": message}}, status_code=502)

    resp_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP_BY_HOP and k.lower() != "content-encoding"}
    return Response(content=upstream.content, status_code=upstream.status_code, headers=resp_headers, media_type=upstream.headers.get("content-type"))


# --- authenticated WS proxy -----------------------------------------------------------
WS_PATHS = {"/api/ws", "/api/events", "/api/pub", "/api/console", "/api/pty"}


async def _relay_ws(client_ws: WebSocket, hermes_url: str) -> None:
    try:
        async with ws_client.connect(hermes_url, max_size=384 * 1024 * 1024, ping_interval=None) as upstream:
            async def client_to_upstream():
                try:
                    while True:
                        msg = await client_ws.receive()
                        if msg.get("type") == "websocket.disconnect":
                            break
                        if "bytes" in msg and msg["bytes"] is not None:
                            await upstream.send(msg["bytes"])
                        elif "text" in msg and msg["text"] is not None:
                            await upstream.send(msg["text"])
                except (WebSocketDisconnect, Exception):
                    pass

            async def upstream_to_client():
                try:
                    async for data in upstream:
                        if isinstance(data, (bytes, bytearray)):
                            await client_ws.send_bytes(bytes(data))
                        else:
                            await client_ws.send_text(data)
                except Exception:
                    pass

            pump_a = asyncio.create_task(client_to_upstream())
            pump_b = asyncio.create_task(upstream_to_client())
            done, pending = await asyncio.wait({pump_a, pump_b}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
    except Exception as exc:  # handshake / dial failure -> WS close, never leak internals
        log.warning("ws upstream dial failed: %s", type(exc).__name__)
        try:
            await client_ws.close(code=1011)
        except Exception:
            pass


for _ws_path in WS_PATHS:

    @app.websocket(_ws_path)
    async def _ws_endpoint(client_ws: WebSocket, _path: str = _ws_path):  # type: ignore[no-redef]
        origin = client_ws.headers.get("origin")
        if origin and not _is_origin_allowed(origin):
            await client_ws.close(code=4403)
            return
        if not AUTH_TOKEN or not _auth_ok(client_ws):  # type: ignore[arg-type]
            await client_ws.close(code=4401)
            return
        if not _hermes_ready.is_set():
            await client_ws.close(code=1013)
            return
        await client_ws.accept(subprotocol=None)
        # Preserve ticket/pty/channel params; swap our auth for Hermes' internal token.
        params = dict(client_ws.query_params)
        params.pop("auth", None)
        params["token"] = INTERNAL_TOKEN
        hermes_url = f"ws://{HERMES_HOST}:{HERMES_PORT}{_path}?{urlencode(params)}"
        await _relay_ws(client_ws, hermes_url)
