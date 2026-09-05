# Hermes Online backend — Hermes agent + auth/CORS edge on Render.
# Installs the real Hermes agent from upstream (shallow-tagged clone, not
# vendored) and runs it as a loopback-only subprocess behind backend/proxy.py
# (which binds 0.0.0.0:$PORT).
#
# Install method note: upstream deliberately BLOCKS `pip install hermes-agent`
# (non-editable wheel builds raise "Building wheels or sdists for hermes-agent
# is not supported"). The supported source flows are the shell installer,
# their Docker image, Nix, or an editable install (`uv sync` /
# `uv pip install -e .`). We mirror their own Dockerfile: `uv sync` against
# the committed uv.lock. The edge runs inside the same venv (its 5 deps are
# already pinned there), so there is exactly one Python environment.
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_HTTP_TIMEOUT=300 \
    HERMES_HOME=/data/.hermes \
    HERMES_WORKSPACE=/data/workspace \
    HERMES_PORT=12719 \
    HERMES_BIN=/opt/hermes-src/.venv/bin/hermes \
    PATH="/opt/hermes-src/.venv/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# System deps Hermes tools expect (shell/files/search/browser-lite) + Node for web_dist build steps.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep ffmpeg procps openssh-client xz-utils \
      gcc g++ make cmake python3-dev libffi-dev \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# uv (same version family upstream pins in docker/uv_source) + pinned
# upstream source. [web] = `serve` dashboard deps; core already brings the
# agent loop, OpenAI-compatible transports (opencode-zen) and file/shell tools.
RUN pip install --no-cache-dir "uv==0.11.6" \
    && git clone --depth 1 --branch v2026.8.31 https://github.com/NousResearch/hermes-agent.git /opt/hermes-src

WORKDIR /opt/hermes-src
RUN uv sync --frozen --extra web

WORKDIR /app

# Edge sources. backend/requirements.txt records the pin coupling with
# hermes-agent (all 5 are already satisfied inside the venv above).
COPY backend/ backend/
RUN chmod +x backend/start.sh

# Persistent disk mount point (Render disk mounted at /data).
VOLUME ["/data"]

# Render sets $PORT; the edge binds 0.0.0.0:$PORT, Hermes stays on 127.0.0.1:$HERMES_PORT.
# PATH puts the hermes venv first, so `python`/`hermes` resolve into it.
CMD ["bash", "backend/start.sh"]
