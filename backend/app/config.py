"""Runtime configuration, read once from the environment (and an optional .env file)."""
from __future__ import annotations

import os
from dataclasses import dataclass

try:  # optional at import time so unit tests can run without python-dotenv
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover
    pass


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    return default if raw is None else raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    anthropic_api_key: str
    model: str
    escalation_model: str
    escalate_low_confidence: bool
    confidence_threshold: float
    max_tokens: int
    request_timeout_s: float
    max_concurrent_claude_calls: int
    max_analyses_per_session: int
    cache_ttl_s: int
    cache_max_items: int
    allowed_origin_regex: str
    prompt_version: str


def load_settings() -> Settings:
    return Settings(
        # The key is read from the environment ONLY. There is deliberately no default.
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", "").strip(),
        model=os.getenv("CLAUDE_MODEL", "claude-sonnet-5-5"),
        escalation_model=os.getenv("CLAUDE_ESCALATION_MODEL", "claude-opus-5-5"),
        escalate_low_confidence=_env_bool("ESCALATE_LOW_CONFIDENCE", True),
        confidence_threshold=float(os.getenv("CONFIDENCE_THRESHOLD", "0.7")),
        max_tokens=int(os.getenv("MAX_TOKENS", "1200")),
        request_timeout_s=float(os.getenv("REQUEST_TIMEOUT_S", "60")),
        max_concurrent_claude_calls=int(os.getenv("MAX_CONCURRENT_CLAUDE_CALLS", "4")),
        max_analyses_per_session=int(os.getenv("MAX_ANALYSES_PER_SESSION", "200")),
        cache_ttl_s=int(os.getenv("CACHE_TTL_S", str(7 * 24 * 3600))),
        cache_max_items=int(os.getenv("CACHE_MAX_ITEMS", "5000")),
        allowed_origin_regex=os.getenv("ALLOWED_ORIGIN_REGEX", r"^chrome-extension://[a-p]{32}$"),
        prompt_version="v2",
    )


settings = load_settings()
