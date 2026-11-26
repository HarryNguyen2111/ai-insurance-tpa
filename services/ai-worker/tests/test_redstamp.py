from __future__ import annotations

import cv2
import numpy as np
import pytest

import synth
from tpa_ai_worker.redstamp import red_mask, suppress_red_stamp


def _ring_probe(img: synth.Image) -> int:
    x, y = synth.STAMP_RING_PROBE
    return int(img[y, x])


def test_red_stamp_is_lifted_toward_paper() -> None:
    stamped = synth.stamped_document()
    plain_gray = np.asarray(cv2.cvtColor(stamped, cv2.COLOR_BGR2GRAY), dtype=np.uint8)
    out = suppress_red_stamp(stamped).image
    # Plain grayscale keeps red ink mid-grey (~76) and visible to OCR...
    assert _ring_probe(plain_gray) < 100
    # ...suppression makes it paper-white.
    assert _ring_probe(out) > 240


def test_black_text_under_stamp_is_preserved() -> None:
    out = suppress_red_stamp(synth.stamped_document()).image
    assert int(out[synth.TEXT_BAR_UNDER_STAMP].max()) < 30
    assert int(out[synth.TEXT_BAR_CLEAR].max()) < 30


def test_blue_ink_is_not_suppressed() -> None:
    img = synth.blue_ink_document()
    result = suppress_red_stamp(img)
    assert result.red_pixel_count == 0
    np.testing.assert_array_equal(result.image, cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))


def test_red_mask_counts_only_red_pixels() -> None:
    assert int(np.count_nonzero(red_mask(synth.document()))) == 0
    assert suppress_red_stamp(synth.stamped_document()).red_pixel_count > 1000


def test_input_array_is_not_modified() -> None:
    stamped = synth.stamped_document()
    before = stamped.copy()
    out = suppress_red_stamp(stamped).image
    np.testing.assert_array_equal(stamped, before)
    assert out.ndim == 2 and out.shape == stamped.shape[:2]
    assert not np.shares_memory(out, stamped)


def test_rejects_non_bgr_input() -> None:
    with pytest.raises(ValueError):
        suppress_red_stamp(np.zeros((10, 10), dtype=np.uint8))
