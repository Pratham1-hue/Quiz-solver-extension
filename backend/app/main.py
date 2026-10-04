"""FastAPI backend for the Agentic AI Study Assistant (blueprint section 5)."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import llm
from .cache import SingleFlightCache
from .config import settings
from .schemas import AnalysisResult, QuestionPayload, SessionCreate, SessionOut

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("study_agent")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.")
    yield


app = FastAPI(title="AI Study Agent Backend", version="2.0.0", lifespan=lifespan)

# Only your own extension may call the API from a browser context. No credentials/cookies are used.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=settings.allowed_origin_regex,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@dataclass
class Session:
    id: str
    subject: str
    topic: str
    created_at: float
    analyses: int = 0


SESSIONS: dict[str, Session] = {}
MAX_SESSIONS = 5000
cache: SingleFlightCache[AnalysisResult] = SingleFlightCache(settings.cache_ttl_s, settings.cache_max_items)


def _norm(s: str) -> str:
    return " ".join(s.split()).lower()


def cache_key(q: QuestionPayload, session: Session) -> str:
    """Everything that can change the answer is part of the key (blueprint 5.3)."""
    parts = {
        "prompt_version": settings.prompt_version,
        "model": settings.model,
        "session": session.id,
        "subject": _norm(session.subject),
        "topic": _norm(session.topic),
        "kind": q.kind,
        "stem": _norm(q.stem_text),
        "options": sorted(_norm(o.text) for o in q.options),
        "latex": q.latex,
        "images": [hashlib.sha256(i.data_b64.encode()).hexdigest()[:16] for i in q.images],
        "visuals_total": q.visuals_total,
    }
    return hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _error(status: int, code: str, message: str, retry_after: int | None = None) -> HTTPException:
    headers = {"Retry-After": str(retry_after)} if retry_after else None
    return HTTPException(status_code=status, detail={"error_code": code, "message": message}, headers=headers)


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok", "prompt_version": settings.prompt_version}


@app.post("/v1/sessions", response_model=SessionOut)
async def create_session(body: SessionCreate) -> SessionOut:
    if len(SESSIONS) >= MAX_SESSIONS:
        SESSIONS.pop(next(iter(SESSIONS)))  # evict the oldest
    session = Session(id=secrets.token_urlsafe(16), subject=body.subject, topic=body.topic, created_at=time.time())
    SESSIONS[session.id] = session
    return SessionOut(
        session_id=session.id,
        prompt_version=settings.prompt_version,
        subject=session.subject,
        topic=session.topic,
        max_analyses=settings.max_analyses_per_session,
    )


@app.post("/v1/analyze", response_model=AnalysisResult)
async def analyze(q: QuestionPayload, prefetch: bool = Query(False)):
    session = SESSIONS.get(q.session_id)
    if session is None:
        raise _error(404, "session_not_found", "This study session no longer exists. Please start a new one.")

    key = cache_key(q, session)
    hit = cache.peek(key)

    if hit is None and not cache.in_flight(key):
        if session.analyses >= settings.max_analyses_per_session:
            raise _error(429, "session_limit_reached", "This session reached its analysis limit. Start a new session.")
        session.analyses += 1

    def factory():
        return llm.analyze(q, session.subject, session.topic, key)

    if prefetch:  # fire-and-forget: returns before Claude finishes
        if hit is not None:
            return JSONResponse(status_code=200, content={"status": "cached", "content_hash": key})
        cache.start(key, factory)
        return JSONResponse(status_code=202, content={"status": "accepted", "content_hash": key})

    try:
        result, was_cached = await cache.get_or_compute(key, factory)
    except llm.AnalysisError as e:
        raise _error(e.status, e.code, e.message, e.retry_after)
    return result.model_copy(update={"cached": was_cached})
