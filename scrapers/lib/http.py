"""Polite HTTP session with retry + jitter — modelled on Astro_Data's scraper.

Three differences from the Astro version:
  - Generalised: not tied to one host. Each source passes its own base URL.
  - User-Agent identifies the scraper as belonging to DigiPin so site
    operators can trace traffic and reach us if it's misbehaving.
  - Returns response bytes (not str) so XML / RSS parsers don't have to
    re-encode.

Usage:
    client = PoliteClient(delay=0.6)
    body = client.get("https://example.com/feed.xml")
"""

from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass

import requests

log = logging.getLogger("scrapers.http")

DEFAULT_HEADERS = {
    "User-Agent": (
        "DigiPin-RealtimeScraper/0.1 "
        "(+https://github.com/Slllyio/digipin; urban-intelligence research)"
    ),
    "Accept-Language": "en-IN,en;q=0.9",
}


@dataclass
class PoliteClient:
    """Minimal Session wrapper. Defaults are conservative (one request per
    ~1s after jitter) so even long crawls stay well under any sane rate limit."""

    delay: float = 0.6
    jitter: float = 0.4
    max_retries: int = 4
    timeout: int = 30
    verify_ssl: bool = True

    def __post_init__(self) -> None:
        self._session = requests.Session()
        self._session.headers.update(DEFAULT_HEADERS)

    def _sleep(self) -> None:
        time.sleep(self.delay + random.uniform(0, self.jitter))

    def get(self, url: str, params: dict | None = None, accept_status: tuple[int, ...] = (200,)) -> bytes | None:
        for attempt in range(1, self.max_retries + 1):
            try:
                r = self._session.get(url, params=params, timeout=self.timeout, verify=self.verify_ssl)
                if r.status_code in accept_status:
                    return r.content
                if r.status_code in (404, 410):
                    log.debug("not found: %s", r.url)
                    return None
                log.warning("HTTP %s on %s (attempt %s/%s)", r.status_code, r.url, attempt, self.max_retries)
            except requests.RequestException as e:
                log.warning("request error: %s (attempt %s/%s)", e, attempt, self.max_retries)
            time.sleep(2 ** attempt)
        log.error("giving up on %s", url)
        return None

    def get_text(self, url: str, params: dict | None = None, encoding: str | None = None) -> str | None:
        body = self.get(url, params=params)
        if body is None:
            return None
        if encoding:
            return body.decode(encoding, errors="replace")
        return body.decode("utf-8", errors="replace")

    def polite_sleep(self) -> None:
        """Explicit sleep between iterations (separate from retry backoff)."""
        self._sleep()
