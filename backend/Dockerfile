# Hermes Online backend — Hermes agent + auth/CORS edge on Render.
# Installs the real Hermes agent from upstream (not vendored) and runs it as a
# loopback-only subprocess behind backend/proxy.py (which binds 0.0.0.0:$PORT).
FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HERMES_HOME=/data/.hermes \
    HERMES_WORKSPACE=/data/workspace \
    HERMES_PORT=12719

# System deps Hermes tools expect (shell/files/search/browser-lite) + Node for web_dist build steps.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep ffmpeg procps openssh-client xz-utils \
      gcc g++ make cmake python3-dev libffi-dev \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Edge deps first (better layer cache). Pins match hermes-agent v0.21.0.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --upgrade pip && pip install -r backend/requirements.txt

# Real Hermes agent from upstream (pinned tag for reproducible deploys).
# [web] = serve dashboard deps; core already brings the agent loop,
# OpenAI-compatible transports (opencode-zen) and file/shell tools.
RUN pip install "hermes-agent[web] @ git+https://github.com/NousResearch/hermes-agent.git@v0.21.0"

COPY backend/ backend/
RUN chmod +x backend/start.sh

# Persistent disk mount point (Render disk mounted at /data).
VOLUME ["/data"]

# Render sets $PORT; the edge binds 0.0.0.0:$PORT, Hermes stays on 127.0.0.1:$HERMES_PORT.
CMD ["bash", "backend/start.sh"]
