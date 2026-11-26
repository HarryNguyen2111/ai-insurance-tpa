from __future__ import annotations

from decimal import Decimal

import cv2
import numpy as np
import pytest

import synth
from tpa_ai_worker.config import BLUR_SCORE_MAX, BLUR_THRESHOLD
from tpa_ai_worker.quality import format_score, is_blurry, laplacian_variance


def _gray(img: synth.Image) -> synth.Image:
    return np.asarray(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), dtype=np.uint8)


def test_threshold_is_spec_value() -> None:
    # docs/ai-specs/03 section 4.1: LaplacianVariance < 65 -> reject.
    assert BLUR_THRESHOLD == Decimal("65.00")


def test_sharp_synthetic_document_passes() -> None:
    score = laplacian_variance(_gray(synth.document()))
    assert score >= BLUR_THRESHOLD
    assert not is_blurry(score)


def test_blurred_synthetic_document_is_rejected() -> None:
    sharp = laplacian_variance(_gray(synth.document()))
    soft = laplacian_variance(_gray(synth.blurry(synth.document())))
    assert soft < BLUR_THRESHOLD < sharp
    assert is_blurry(soft)


def test_uniform_image_scores_zero() -> None:
    blank = np.full((100, 100), 255, dtype=np.uint8)
    assert laplacian_variance(blank) == Decimal("0.00")


@pytest.mark.parametrize(
    ("score", "blurry"),
    [(Decimal("64.99"), True), (Decimal("65.00"), False), (Decimal("65.01"), False), (Decimal("0.00"), True)],
)
def test_threshold_boundary_is_strictly_less_than(score: Decimal, blurry: bool) -> None:
    assert is_blurry(score) is blurry


def test_score_is_two_decimal_string_not_float() -> None:
    score = laplacian_variance(_gray(synth.document()))
    assert isinstance(score, Decimal)
    assert score == score.quantize(Decimal("0.01"))
    text = format_score(score)
    assert isinstance(text, str) and text.count(".") == 1 and len(text.split(".")[1]) == 2


def test_score_is_clamped_to_numeric_8_2() -> None:
    score = laplacian_variance(_gray(synth.checkerboard()))
    assert score == BLUR_SCORE_MAX == Decimal("999999.99")


def test_rejects_colour_input() -> None:
    with pytest.raises(ValueError):
        laplacian_variance(synth.document())
