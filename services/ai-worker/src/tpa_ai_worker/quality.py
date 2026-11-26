"""Blur pre-filter (docs/ai-specs/03 section 4.1): Laplacian variance < 65 is blurry."""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

import cv2
import numpy as np
import numpy.typing as npt

from tpa_ai_worker.config import BLUR_SCORE_MAX, BLUR_THRESHOLD

_CENT = Decimal("0.01")


def laplacian_variance(gray: npt.NDArray[np.uint8]) -> Decimal:
    """Variance of the Laplacian of a grayscale image as a 2-dp decimal.

    The float from OpenCV is converted through ``repr`` (shortest round-trip
    form) and rounded ROUND_HALF_UP, then clamped to NUMERIC(8,2).
    """
    if gray.ndim != 2:
        raise ValueError("expected a single-channel image")
    variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    score = Decimal(repr(variance)).quantize(_CENT, rounding=ROUND_HALF_UP)
    return min(score, BLUR_SCORE_MAX)


def is_blurry(score: Decimal, threshold: Decimal = BLUR_THRESHOLD) -> bool:
    return score < threshold


def format_score(score: Decimal) -> str:
    return f"{score.quantize(_CENT, rounding=ROUND_HALF_UP):f}"
