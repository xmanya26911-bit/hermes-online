"""Bootstrap Hermes home on Render (idempotent, never overwrites user data).

Reads server-side env only:
  OPENCODE_ZEN_API_KEY   -> written to $HERMES_HOME/.env (Hermes native provider env)
  OPENCODE_ZEN_BASE_URL  -> optional override, defaults to https://opencode.ai/zen/v1
  HERMES_MODEL           -> defaults to muse-spark-1.3-contributor-free
  HERMES_PROVIDER        -> defaults to opencode-zen
  HERMES_HOME            -> defaults to /data/.hermes
  HERMES_WORKSPACE       -> defaults to /data/workspace

Writes (only if missing):
  $HERMES_HOME/config.yaml  (model/provider/terminal/memory)
  $HERMES_HOME/.env         (OPENCODE_ZEN_API_KEY + mirror, mode 0600)
Ensures workspace + skills/memory/cron/log dirs exist for the persistent disk.
Prints no secrets.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import yaml

DEFAULT_MODEL = "muse-spark-1.3-contributor-free"
DEFAULT_PROVIDER = "opencode-zen"
DEFAULT_BASE_URL = "https://opencode.ai/zen/v1"


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name, default) or default).strip()


def main() -> None:
    home = Path(_env("HERMES_HOME", "/data/.hermes")).expanduser()
    workspace = Path(_env("HERMES_WORKSPACE", "/data/workspace")).expanduser()
    model = _env("HERMES_MODEL", DEFAULT_MODEL) or DEFAULT_MODEL
    provider = _env("HERMES_PROVIDER", DEFAULT_PROVIDER) or DEFAULT_PROVIDER
    base_url = _env("OPENCODE_ZEN_BASE_URL", DEFAULT_BASE_URL) or DEFAULT_BASE_URL
    zen_key = _env("OPENCODE_ZEN_API_KEY", "")

    for d in (
        home,
        workspace,
        home / "skills",
        home / "memories",
        home / "sessions",
        home / "cron",
        home / "logs",
        home / "cache",
    ):
        d.mkdir(parents=True, exist_ok=True)

    config_path = home / "config.yaml"
    if not config_path.exists():
        config = {
            "model": {
                "provider": provider,
                "default": model,
                "base_url": base_url,
                # Hermes re-derives api_mode per OpenCode model (muse-spark -> codex_responses
                # i.e. POST {base_url}/responses). Explicit api_mode is intentionally omitted
                # so upgrades to Hermes' routing table keep working.
            },
            "terminal": {"backend": "local", "cwd": str(workspace), "timeout": 180},
            "memory": {
                "memory_enabled": True,
                "user_profile_enabled": True,
            },
        }
        config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
        print(f"bootstrap: wrote {config_path} provider={provider} model={model}", flush=True)
    else:
        print(f"bootstrap: keeping existing {config_path}", flush=True)

    if zen_key:
        env_path = home / ".env"
        # Merge: preserve any existing keys the user set via other means.
        existing: dict[str, str] = {}
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    existing[k.strip()] = v.strip()
        existing["OPENCODE_ZEN_API_KEY"] = zen_key
        if "OPENCODE_ZEN_BASE_URL" not in existing and base_url != DEFAULT_BASE_URL:
            existing["OPENCODE_ZEN_BASE_URL"] = base_url
        env_path.write_text(
            "".join(f"{k}={v}\n" for k, v in sorted(existing.items())), encoding="utf-8"
        )
        try:
            os.chmod(env_path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass
        print(f"bootstrap: synced OPENCODE_ZEN_API_KEY into {env_path} (value hidden)", flush=True)
    else:
        print("bootstrap: WARNING OPENCODE_ZEN_API_KEY is not set; model calls will fail", flush=True)

    print(f"bootstrap: HERMES_HOME={home} workspace={workspace}", flush=True)


if __name__ == "__main__":
    main()
