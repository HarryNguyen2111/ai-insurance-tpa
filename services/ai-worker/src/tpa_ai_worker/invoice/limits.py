"""Technical limits for QR -> XML fetch and parsing (AI-02, issue #29).

Every limit here is a hard ceiling: environment overrides may only tighten
it. The host allowlist is fail-closed: when it is empty no fetch happens at
all. Real provider lookup hosts (MISA/VNPT/Viettel...) are an owner/provider
decision and are deliberately NOT hard-coded here.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

# Raw bytes accepted from the network, before any decompression.
TECHNICAL_MAX_FETCH_BYTES = 2 * 1024 * 1024
# Bytes after decompression (gzip/deflate transfer encoding or a zip archive).
TECHNICAL_MAX_DECOMPRESSED_BYTES = 5 * 1024 * 1024
# Decompressed/compressed ratio ceiling (decompression-bomb guard).
TECHNICAL_MAX_DECOMPRESSION_RATIO = 100
# Zip archives: maximum number of entries in the central directory.
TECHNICAL_MAX_ZIP_ENTRIES = 16
TECHNICAL_MAX_REDIRECTS = 3
# Wall-clock budget for the whole fetch, all redirect hops included (seconds).
TECHNICAL_TOTAL_TIMEOUT_S = 10.0
# Per socket operation (connect / single recv) timeout (seconds).
TECHNICAL_SOCKET_TIMEOUT_S = 5.0
TECHNICAL_MAX_URL_LENGTH = 2048
# XML structure ceilings, enforced after a DTD-free parse.
TECHNICAL_MAX_XML_ELEMENTS = 20_000
TECHNICAL_MAX_XML_DEPTH = 64
TECHNICAL_MAX_INVOICE_LINES = 1000

ALLOWED_HOSTS_ENV = "AI_WORKER_INVOICE_FETCH_ALLOWED_HOSTS"


@dataclass(frozen=True, slots=True)
class FetchLimits:
    max_fetch_bytes: int = TECHNICAL_MAX_FETCH_BYTES
    max_decompressed_bytes: int = TECHNICAL_MAX_DECOMPRESSED_BYTES
    max_decompression_ratio: int = TECHNICAL_MAX_DECOMPRESSION_RATIO
    max_zip_entries: int = TECHNICAL_MAX_ZIP_ENTRIES
    max_redirects: int = TECHNICAL_MAX_REDIRECTS
    total_timeout_s: float = TECHNICAL_TOTAL_TIMEOUT_S
    socket_timeout_s: float = TECHNICAL_SOCKET_TIMEOUT_S
    max_url_length: int = TECHNICAL_MAX_URL_LENGTH


@dataclass(frozen=True, slots=True)
class XmlLimits:
    max_bytes: int = TECHNICAL_MAX_DECOMPRESSED_BYTES
    max_elements: int = TECHNICAL_MAX_XML_ELEMENTS
    max_depth: int = TECHNICAL_MAX_XML_DEPTH
    max_lines: int = TECHNICAL_MAX_INVOICE_LINES


@dataclass(frozen=True, slots=True)
class FetchPolicy:
    """Exact-match, lower-case ASCII (IDNA) host names allowed for XML fetch."""

    allowed_hosts: frozenset[str] = field(default_factory=frozenset)
    limits: FetchLimits = field(default_factory=FetchLimits)


def _stricter_int(env_name: str, ceiling: int) -> int:
    raw = os.environ.get(env_name)
    if raw is None or raw.strip() == "":
        return ceiling
    value = int(raw)
    if value <= 0:
        raise ValueError(f"{env_name} must be a positive integer")
    return min(value, ceiling)


def load_fetch_policy() -> FetchPolicy:
    """Read the allowlist and tightening overrides from the environment.

    Entries that are not valid host names are rejected loudly rather than
    silently ignored, so a typo cannot widen or confuse the allowlist.
    """
    from tpa_ai_worker.invoice.urlpolicy import normalize_allowlist_entry

    raw = os.environ.get(ALLOWED_HOSTS_ENV, "")
    hosts = frozenset(normalize_allowlist_entry(part) for part in raw.split(",") if part.strip())
    limits = FetchLimits(
        max_fetch_bytes=_stricter_int("AI_WORKER_INVOICE_MAX_FETCH_BYTES", TECHNICAL_MAX_FETCH_BYTES),
    )
    return FetchPolicy(allowed_hosts=hosts, limits=limits)
