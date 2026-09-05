# Hermes Online — browser version of the Hermes Agent

Production-ready split deployment: a Next.js browser frontend on Vercel talks to
the **real Hermes agent** on Render, which calls **OpenCode Zen**.

```text
hermesonline.vercel.app
        ↓ HTTPS + WSS (Bearer HERMES_AUTH_TOKEN, CORS allowlisted)
      Vercel (frontend/, Next.js + React + TypeScript + Tailwind)
        ↓
     Render (backend/, Docker Web Service, 0.0.0.0:$PORT)
        ↓ loopback only (X-Hermes-Session-Token, never exposed)
  Hermes Agent (`hermes serve --host 127.0.0.1 --port 12719`, headless)
        ↓ OPENCODE_ZEN_API_KEY (server-side only)
 OpenCode Zen https://opencode.ai/zen/v1
        ↓ POST /responses (Responses API, auto-routed by Hermes)
muse-spark-1.3-contributor-free
```

> **Security note:** API tokens were shared in chat during setup. Treat any key
> pasted into chat as potentially exposed: rotate `OPENCODE_ZEN_API_KEY`,
> `HERMES_AUTH_TOKEN`, the Render API key and the Vercel token after deploying,
> and never commit real values (only `.env.example` placeholders live in git).

## What was verified against CURRENT upstream (Sep 2026)

**Hermes** (`https://github.com/NousResearch/hermes-agent`, cloned depth-1 during build):

- `hermes serve` is the headless FastAPI + WS JSON-RPC backend ("what the desktop
  app and remote backends run", `hermes_cli/subcommands/dashboard.py:1-7`). Flags:
  `--host` (default `127.0.0.1`), `--port` (default `9119`, `0` = OS auto-assign).
  `--insecure` is a deprecated NO-OP — a public bind always requires auth.
- WS mount is `@router.websocket("/api/ws")` (`hermes_cli/web_routers/chat_ws.py:541`),
  reusing `tui_gateway/ws.py:handle_ws` — newline-delimited JSON-RPC both ways,
  `gateway.ready` right after accept, `gateway.ping` heartbeat. Side channels:
  `/api/console`, `/api/pty`, `/api/pub`, `/api/events`.
- Real methods: `session.create/resume/list/delete/title/close/interrupt/compress`,
  `prompt.submit`, `approval.respond`, `session.events.since/stats`, `config.get/set`,
  `projects.*`, `file.attach/image.attach/pdf.attach`, `shell.exec/cli.exec`, etc.
- Real events: `message.start/delta/interim/complete`, `thinking.delta`,
  `reasoning.delta`, `status.update`, `tool.start/progress/complete/generating`,
  `todo.updated`, `clarify.request`, `approval.request`, `session.info/usage`, `error`.
  The frontend maps these verbatim to Thinking / Using tool / Running command /
  Reading file / Writing file / Searching / Finished — nothing is faked.
- Auth: `X-Hermes-Session-Token` header or `?token=` (loopback) /
  `?ticket=` single-use 30s via `POST /api/auth/ws-ticket` (gated). WS close codes
  `4401/4403/4404/4408`. CORS is loopback-only by default
  (`allow_origin_regex=^https?://(localhost|127.0.0.1)(:\d+)?$`) — hence the edge
  proxy below instead of exposing Hermes directly.
- Desktop (`apps/desktop/electron/backend-command.ts:18-22`) spawns
  `serve --host 127.0.0.1 --port 0` and dials `ws://127.0.0.1:{port}/api/ws?token=…`.
  The web dashboard (`web/`, React 19 + Vite + Tailwind) connects the same way via
  `GatewayClient extends JsonRpcGatewayClient` (`@hermes/shared`).
- Persistence root: `$HERMES_HOME` (`~/.hermes` POSIX, `%LOCALAPPDATA%\hermes`
  Windows, `/opt/data` in upstream Docker). Persistent state: `state.db`,
  `sessions/`, `MEMORY.md`/`USER.md`, `memories/`, `skills/`, `config.yaml`, `.env`,
  `auth.json`, `cron/jobs.json` + `cron/output/`, `logs/`, `cache/`, `backups/`,
  `profiles/`. Workspace/files root via `HERMES_DASHBOARD_FILES_ROOT` or cwd.
- **No `hermes serve` flags were invented** — all of the above is quoted from source.

**OpenCode Zen** (`https://opencode.ai/docs/zen`, fetched Sep 2026):

- Base URL `https://opencode.ai/zen/v1`, model list endpoint `/zen/v1/models`.
- `Muse Spark 1.3 Contributor Free` — Model ID `muse-spark-1.3-contributor-free`,
  endpoint `https://opencode.ai/zen/v1/responses`, SDK `@ai-sdk/openai`, Free/Free
  pricing. Contributor tier trains on prompts/completions (see Zen privacy section).
- Hermes natively supports it: provider `opencode-zen`, env `OPENCODE_ZEN_API_KEY`
  in `$HERMES_HOME/.env`, `inference_base_url='https://opencode.ai/zen/v1'`
  (`hermes_cli/auth.py`), profile base `https://opencode.ai/zen/v1`
  (`plugins/model-providers/opencode-zen/__init__.py`). Model IDs starting with
  `muse-spark` auto-route to `codex_responses` → `POST {base}/responses`
  (`hermes_cli/models.py:2026-2049`). **No custom provider adapter was needed** —
  the edge only maps our env into Hermes' native config.

## Repository layout

```text
hermes-online/
├── frontend/            # Vercel: Next.js 14 + React 18 + TS + Tailwind
│   ├── app/             # layout, globals.css, page.tsx (chat orchestrator)
│   ├── components/      # LoginGate, Sidebar, ChatMessage, Composer, FilePanel
│   └── lib/             # protocol.ts, api.ts, hermes-socket.ts
├── backend/             # Render: edge proxy + Hermes bootstrap
│   ├── proxy.py         # FastAPI: CORS, Bearer auth, /api/health|ready, REST+WS proxy
│   ├── bootstrap.py     # writes $HERMES_HOME/config.yaml + .env (idempotent)
│   ├── start.sh         # Render entrypoint (0.0.0.0:$PORT)
│   ├── Dockerfile       # python:3.11 + real Hermes from upstream git
│   └── requirements.txt
├── render.yaml          # Render blueprint (service + 10GB disk + env)
├── .env.example         # placeholders only
└── README.md
```

The Electron desktop app is **not** deployed to Vercel. Vercel serves only the
custom browser frontend; the agent runtime lives on Render.

## Deployment

### 1. GitHub

```bash
git init -b main
git add -A
git commit -m "Hermes Online: Vercel frontend + Render Hermes backend (OpenCode Zen)"
git remote add origin https://github.com/<you>/hermes-online.git
git push -u origin main
```

### 2. Render backend (Blueprint)

1. Render dashboard → **New → Blueprint** → select the repo (uses `render.yaml`).
   OrKeep manual alternative: **New → Web Service** → Docker, `dockerfilePath ./backend/Dockerfile`, `dockerContext .`.
2. Plan: **Standard** (≥1GB RAM recommended for agent + tools).
3. Disk: blueprint creates `hermes-data` 10GB mounted at `/data`
   (`HERMES_HOME=/data/.hermes`, workspace `/data/workspace`). These exact dirs
   persist: `state.db`, `sessions/`, `MEMORY.md`/`USER.md`, `memories/`,
   `skills/`, `config.yaml`, `.env`, `cron/`, `logs/`, `cache/`, `backups/`,
   `profiles/`. Nothing persistent lives on the ephemeral container FS.
4. Health check path: `/api/health` (edge always 200; body has `hermes_ready`).
   Frontend polls `/api/ready` (503 until `hermes serve` answers) for cold-start UX.
5. Note the service URL, e.g. `https://hermes-backend-xxxx.onrender.com`.

### 3. Render environment variables (dashboard → Environment, all server-side)

| Key | Value |
| --- | --- |
| `OPENCODE_ZEN_API_KEY` | **secret** — OpenCode Zen key (https://opencode.ai/auth) |
| `HERMES_AUTH_TOKEN` | **secret** — `openssl rand -hex 32` (min 16 chars; edge fails closed without it) |
| `HERMES_DASHBOARD_SESSION_TOKEN` | optional secret — if unset the edge generates one at boot |
| `FRONTEND_ORIGIN` | `https://hermesonline.vercel.app` |
| `HERMES_MODEL` | `muse-spark-1.3-contributor-free` |
| `HERMES_PROVIDER` | `opencode-zen` |
| `OPENCODE_ZEN_BASE_URL` | `https://opencode.ai/zen/v1` |
| `HERMES_HOME` | `/data/.hermes` |
| `HERMES_WORKSPACE` | `/data/workspace` |
| `HERMES_PORT` | `12719` |
| `ENV` | `production` |

No `NEXT_PUBLIC_*` variable exists on Render. The OpenCode key never leaves the server.

### 4. Vercel frontend

1. Vercel → **Add New → Project** → import the same repo.
2. **Root Directory = `frontend`** (monorepo: backend Dockerfile must not be built by Vercel).
3. Framework preset: Next.js. Build command `next build` (default).
4. Environment variable: `NEXT_PUBLIC_HERMES_BACKEND_URL=https://<your-render-service>.onrender.com`.
5. Deploy, then add the domain `hermesonline.vercel.app` (or it is assigned automatically
   if the project is named `hermesonline`).

### 5. CORS

Enforced in `backend/proxy.py` (Hermes' own CORS stays loopback-only; the edge is
the production boundary):

- `FRONTEND_ORIGIN=https://hermesonline.vercel.app` (comma-separated allowlist).
- Non-production automatically also allows `http://localhost:3000`.
- Non-allowlisted `Origin` → `403 cors_forbidden` (REST) / WS close `4403`.
- No wildcard in production.

### 6. Authentication

```text
User --Bearer HERMES_AUTH_TOKEN--> edge --X-Hermes-Session-Token--> hermes serve
```

- Browser holds **only** `HERMES_AUTH_TOKEN` (sessionStorage, login screen).
- WS uses `?auth=` (browsers can't set headers); the edge strips it and dials Hermes
  with the internal `?token=`. REST `Authorization` is likewise never forwarded.
- Hermes internal token (`HERMES_DASHBOARD_SESSION_TOKEN`) never reaches the browser.
- Missing/short `HERMES_AUTH_TOKEN` → edge returns `401/503` fail-closed.
- Anonymous users cannot execute tools, read files, or open sessions.

### 7. OpenCode Zen configuration

Native Hermes provider (no adapter fork):

```yaml
# $HERMES_HOME/config.yaml (written by backend/bootstrap.py, only if missing)
model:
  provider: opencode-zen
  default: muse-spark-1.3-contributor-free
  base_url: https://opencode.ai/zen/v1
```

```ini
# $HERMES_HOME/.env (mode 0600, key merged, value never logged)
OPENCODE_ZEN_API_KEY=<from Render env>
```

- Model ID used: **`muse-spark-1.3-contributor-free`**
- Transport: Hermes derives `codex_responses` from the `muse-spark` prefix and
  `POST`s to `https://opencode.ai/zen/v1/responses` with `x-opencode-session`
  affinity headers. Aux tasks default to `gemini-3-flash` per Hermes' profile.
- Backend URL format (browser → edge): `https://<service>.onrender.com/api/*`,
  WS `wss://<service>.onrender.com/api/ws?auth=<HERMES_AUTH_TOKEN>`.

### 8. Testing checklist

Backend: `hermes serve` boots on `127.0.0.1:$HERMES_PORT`; edge binds `0.0.0.0:$PORT`;
`GET /api/health` 200; `POST /api/auth/verify` 401→200; Zen call streams;
`sessions/files` persist across restarts (disk at `/data`).
Frontend: `next build` passes; login → `gateway.ready` → `session.create` →
`prompt.submit` streams `message.delta`; `tool.*` rows appear live; disconnect →
backoff reconnect; `session.events.since` backfills; cold-start banner shows while
`/api/ready` is 503.
Security: devtools Network shows only `Authorization: Bearer <gate token>`;
no `OPENCODE_*` string in JS bundles; unauthenticated `curl /api/sessions` → 401;
CORS from other origins → 403; secrets absent from logs and git history.

## Local development

```bash
# Backend edge + local Hermes (needs `hermes` on PATH or the repo importable):
set HERMES_AUTH_TOKEN=dev-token-min-16-chars
set OPENCODE_ZEN_API_KEY=your_key_here
set FRONTEND_ORIGIN=http://localhost:3000
set ENV=development
set PORT=8000
python backend/bootstrap.py
bash backend/start.sh        # edge on http://localhost:8000, Hermes on 127.0.0.1:12719

# Frontend:
cd frontend
npm install
set NEXT_PUBLIC_HERMES_BACKEND_URL=http://localhost:8000
npm run dev                  # http://localhost:3000
```

## Production commands

```bash
# Pin a Hermes release in backend/Dockerfile before going live, e.g.:
#   RUN pip install "git+https://github.com/NousResearch/hermes-agent.git@v0.21.0[all]"
docker build -f backend/Dockerfile -t hermes-online:local .
docker run --rm -p 8000:8000 \
  -e PORT=8000 -e ENV=production \
  -e HERMES_AUTH_TOKEN=local-test-token-0123456789abcdef \
  -e OPENCODE_ZEN_API_KEY=dummy \
  -e FRONTEND_ORIGIN=https://hermesonline.vercel.app \
  -v hermes-data:/data hermes-online:local

cd frontend && npm ci && npm run build
```

## Limitations (browser-exposed Hermes)

- PTY/console (`/api/pty`, `/api/console`) are proxied but the current UI does not
  render a full xterm; shell work surfaces as tool events + text output.
- Hermes messaging integrations (Telegram/Discord/Slack/WhatsApp, cron delivery,
  voice) keep running server-side but have no browser UI here.
- Long Hermes replies use `prompt.submit` timeout 30 min; Render free-tier sleep
  still drops idle sockets — the client reconnects and backfills via
  `session.events.since`.
- `muse-spark-1.3-contributor-free` is a **contributor tier**: OpenCode may use
  prompts/completions for training (see Zen privacy docs). Disable the model
  per-workspace in OpenCode admin if that matters.
- Multi-user isolation is a single shared gate token; per-user Hermes profiles /
  OAuth are future work — do not share one deployment across trust boundaries.
