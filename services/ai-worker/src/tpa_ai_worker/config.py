"""Technical limits and thresholds. No secrets live here."""

from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal

# 20 MiB: the technical maximum declared by UploadRequest.sizeBytes in
# docs/ai-specs/02-openapi-contracts.yaml. Deployment policy may be stricter,
# never looser.
TECHNICAL_MAX_BYTES = 20 * 1024 * 1024

# Decoded-pixel ceiling (decompression-bomb guard). 40 MP comfortably covers
# phone photos of A4 documents (a 12 MP camera is ~4000x3000).
TECHNICAL_MAX_PIXELS = 40_000_000

# Smallest side we will analyse; anything smaller cannot carry readable text.
MIN_SIDE_PX = 32

# docs/ai-specs/03 section 4.1: OpenCV LaplacianVariance < 65 -> reject blurry.
BLUR_THRESHOLD = Decimal("65.00")
QUALITY_RULE_VERSION = "blur-laplacian-variance-v1"

# claim_documents.blur_score is NUMERIC(8,2); scores are clamped to fit.
BLUR_SCORE_MAX = Decimal("999999.99")


@dataclass(frozen=True, slots=True)
class Limits:
    max_bytes: int = TECHNICAL_MAX_BYTES
    max_pixels: int = TECHNICAL_MAX_PIXELS
    min_side_px: int = MIN_SIDE_PX


def _stricter(env_name: str, ceiling: int) -> int:
    """Read an optional positive integer override that may only tighten a limit."""
    raw = os.environ.get(env_name)
    if raw is None or raw.strip() == "":
        return ceiling
    value = int(raw)
    if value <= 0:
        raise ValueError(f"{env_name} must be a positive integer")
    return min(value, ceiling)


def load_limits() -> Limits:
    return Limits(
        max_bytes=_stricter("AI_WORKER_MAX_BYTES", TECHNICAL_MAX_BYTES),
        max_pixels=_stricter("AI_WORKER_MAX_PIXELS", TECHNICAL_MAX_PIXELS),
    )
