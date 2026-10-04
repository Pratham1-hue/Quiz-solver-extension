"""TTL + LRU cache with single-flight de-duplication (blueprint 5.3).

Swap the dict for Redis later without touching callers: the only public surface is
peek / in_flight / start / get_or_compute.
"""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from typing import Awaitable, Callable, Generic, Optional, TypeVar

T = TypeVar("T")


class SingleFlightCache(Generic[T]):
    def __init__(self, ttl_s: float, max_items: int) -> None:
        self._ttl = ttl_s
        self._max = max_items
        self._data: "OrderedDict[str, tuple[float, T]]" = OrderedDict()
        self._inflight: "dict[str, asyncio.Future[T]]" = {}

    # -- reads ---------------------------------------------------------------
    def peek(self, key: str) -> Optional[T]:
        item = self._data.get(key)
        if item is None:
            return None
        expires, value = item
        if expires < time.monotonic():
            self._data.pop(key, None)
            return None
        self._data.move_to_end(key)
        return value

    def in_flight(self, key: str) -> bool:
        return key in self._inflight

    # -- writes --------------------------------------------------------------
    def _put(self, key: str, value: T) -> None:
        self._data[key] = (time.monotonic() + self._ttl, value)
        self._data.move_to_end(key)
        while len(self._data) > self._max:
            self._data.popitem(last=False)

    def _finish(self, key: str, fut: "asyncio.Future[T]") -> None:
        self._inflight.pop(key, None)
        if fut.cancelled():
            return
        if fut.exception() is None:  # failures are never cached
            self._put(key, fut.result())

    def start(self, key: str, factory: Callable[[], Awaitable[T]]) -> "asyncio.Future[T]":
        """Start (or join) the computation for `key`. Must be called inside a running loop."""
        fut = self._inflight.get(key)
        if fut is None:
            fut = asyncio.ensure_future(factory())
            self._inflight[key] = fut
            fut.add_done_callback(lambda f, k=key: self._finish(k, f))
        return fut

    async def get_or_compute(
        self, key: str, factory: Callable[[], Awaitable[T]]
    ) -> "tuple[T, bool]":
        """Return (value, was_cached). Concurrent callers share one computation."""
        hit = self.peek(key)
        if hit is not None:
            return hit, True
        fut = self.start(key, factory)
        # shield: a disconnecting client must not cancel work other callers are waiting on
        return await asyncio.shield(fut), False
