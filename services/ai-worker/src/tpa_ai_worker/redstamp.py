"""Red-stamp suppression producing a DERIVED image (never touches the original).

Red ink (hospital stamps) printed over black text hurts OCR. In the red channel
both red ink and white paper are bright while black/blue text stays dark, so
pixels that are clearly red are replaced by their red-channel intensity and all
other pixels keep their normal grayscale value. Dark text pixels under a stamp
fall outside the red mask (low value) and are preserved.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

import cv2
import numpy as np
import numpy.typing as npt

TRANSFORM_NAME: Final = "red_stamp_suppression"
TRANSFORM_VERSION: Final = "1"

# OpenCV HSV: hue 0..179. Red wraps around 0.
HUE_LOW_MAX: Final = 10
HUE_HIGH_MIN: Final = 160
SATURATION_MIN: Final = 70
VALUE_MIN: Final = 60


@dataclass(frozen=True, slots=True)
class SuppressionOutput:
    image: npt.NDArray[np.uint8]  # single-channel grayscale
    red_pixel_count: int


def parameters() -> dict[str, int | str]:
    return {
        "colorSpace": "HSV",
        "hueLowMax": HUE_LOW_MAX,
        "hueHighMin": HUE_HIGH_MIN,
        "saturationMin": SATURATION_MIN,
        "valueMin": VALUE_MIN,
        "output": "grayscale-png",
    }


def red_mask(bgr: npt.NDArray[np.uint8]) -> npt.NDArray[np.bool_]:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    hue = hsv[:, :, 0]
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    is_red_hue = (hue <= HUE_LOW_MAX) | (hue >= HUE_HIGH_MIN)
    mask: npt.NDArray[np.bool_] = is_red_hue & (sat >= SATURATION_MIN) & (val >= VALUE_MIN)
    return mask


def suppress_red_stamp(bgr: npt.NDArray[np.uint8]) -> SuppressionOutput:
    """Return a new grayscale image with red ink lifted toward the paper colour."""
    if bgr.ndim != 3 or bgr.shape[2] != 3:
        raise ValueError("expected a 3-channel BGR image")
    gray = np.asarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), dtype=np.uint8)  # new array; input untouched
    mask = red_mask(bgr)
    out = gray.copy()
    out[mask] = bgr[:, :, 2][mask]
    return SuppressionOutput(image=out, red_pixel_count=int(np.count_nonzero(mask)))
