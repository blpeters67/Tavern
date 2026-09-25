"""Password hashing, opaque tokens, and a small in-memory rate limiter."""

from __future__ import annotations

import hashlib
import secrets
import threading
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_token(nbytes: int = 32) -> tuple[str, str]:
    """Return (token, sha256 hash). Only the hash is stored in the database."""
    token = secrets.token_urlsafe(nbytes)
    return token, hash_token(token)


def random_key(nbytes: int = 12) -> str:
    return secrets.token_urlsafe(nbytes).replace("-", "a").replace("_", "b")


class RateLimiter:
    """Sliding-window limiter keyed by arbitrary strings. Good enough for one
    process serving a handful of friends."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()
        self._calls = 0

    def hit(self, key: str, limit: int, window: float) -> bool:
        """Record a hit. Returns False if `key` is over `limit` per `window` seconds."""
        now = time.monotonic()
        with self._lock:
            self._calls += 1
            if self._calls % 500 == 0:
                self._purge(now)
            hits = self._hits[key]
            while hits and hits[0] <= now - window:
                hits.popleft()
            if len(hits) >= limit:
                return False
            hits.append(now)
            return True

    def _purge(self, now: float, horizon: float = 3600) -> None:
        stale = [k for k, v in self._hits.items() if not v or v[-1] <= now - horizon]
        for k in stale:
            del self._hits[k]


limiter = RateLimiter()
