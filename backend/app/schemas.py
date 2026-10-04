"""Pydantic models for the HTTP API (blueprint section 5.2)."""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def _norm(s: str) -> str:
    return " ".join(s.split()).lower()


class SessionCreate(BaseModel):
    subject: str = Field(min_length=1, max_length=120)
    topic: str = Field(min_length=1, max_length=120)

    @field_validator("subject", "topic")
    @classmethod
    def _clean(cls, v: str) -> str:
        v = " ".join(_CONTROL.sub(" ", v).split())
        if not v:
            raise ValueError("must not be blank")
        return v


class SessionOut(BaseModel):
    session_id: str
    prompt_version: str
    subject: str
    topic: str
    max_analyses: int


class OptionIn(BaseModel):
    opt_hash: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=2000)


class ImageIn(BaseModel):
    image_id: str = Field(max_length=32)
    mime: Literal["image/png", "image/jpeg", "image/webp", "image/gif"] = "image/png"
    data_b64: str = Field(max_length=6_800_000)  # ~5 MB, the API's per-image limit
    caption: str = Field(default="", max_length=200)


class QuestionPayload(BaseModel):
    session_id: str
    kind: Literal["single", "multiple", "text"] = "single"
    stem_text: str = Field(min_length=3, max_length=8000)
    options: list[OptionIn] = Field(default_factory=list, max_length=12)
    latex: list[str] = Field(default_factory=list, max_length=40)
    images: list[ImageIn] = Field(default_factory=list, max_length=4)
    visuals_total: int = Field(default=0, ge=0, le=20)
    origin: str = Field(default="", max_length=200)

    @model_validator(mode="after")
    def _sanity(self) -> "QuestionPayload":
        if self.kind == "text":
            if self.options:
                raise ValueError("text questions carry no options")
        elif len(self.options) < 2:
            raise ValueError("option questions need at least two options")
        hashes = [o.opt_hash for o in self.options]
        if len(set(hashes)) != len(hashes):
            raise ValueError("option hashes must be unique")
        stem = _norm(self.stem_text)
        if any(_norm(o.text) == stem for o in self.options):
            # Happens when the page scraper mistakes an option for the stem.
            raise ValueError("stem_text is identical to an option; question extraction failed")
        return self


class AnalysisResult(BaseModel):
    content_hash: str
    correct_opt_hashes: list[str]
    text_answer: str = ""
    confidence: float
    needs_more_info: bool
    off_topic: bool
    visuals_missing: bool
    explanation_short: str
    explanation_detail: str
    distractors: dict[str, str]  # opt_hash -> why that option is wrong
    model: str
    prompt_version: str
    cached: bool = False
