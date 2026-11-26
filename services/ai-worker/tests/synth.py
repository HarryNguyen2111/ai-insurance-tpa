"""Synthetic image fixtures generated at test time.

No real documents, no personal data: every image is drawn with OpenCV from
fixed technical strings so results are deterministic.
"""

from __future__ import annotations

import hashlib
import uuid
from typing import Final

import cv2
import numpy as np
import numpy.typing as npt

Image = npt.NDArray[np.uint8]

BLACK: Final = (0, 0, 0)
RED: Final = (0, 0, 255)  # BGR
BLUE: Final = (255, 0, 0)

# Fixed regions used by assertions.
TEXT_ORIGIN: Final = (40, 120)
STAMP_CENTER: Final = (420, 300)
STAMP_RADIUS: Final = 110
STAMP_RING_PROBE: Final = (420 + 110, 300)  # a point on the red ring, away from text
TEXT_BAR_UNDER_STAMP: Final = (slice(290, 310), slice(330, 510))  # black bar crossing the stamp
TEXT_BAR_CLEAR: Final = (slice(690, 710), slice(40, 300))  # black bar far from the stamp


def document(width: int = 600, height: int = 800) -> Image:
    """A sharp, synthetic 'itemised list' with printed text and black rule bars."""
    img = np.full((height, width, 3), 255, dtype=np.uint8)
    lines = ["SYNTHETIC ITEMISED LIST", "ITEM 001  QTY 2", "ITEM 002  QTY 1", "ITEM 003  QTY 5", "TOTAL LINE"]
    for n, text in enumerate(lines):
        y = TEXT_ORIGIN[1] + n * 60
        cv2.putText(img, text, (TEXT_ORIGIN[0], y), cv2.FONT_HERSHEY_SIMPLEX, 0.9, BLACK, 2, cv2.LINE_AA)
    img[TEXT_BAR_UNDER_STAMP] = 0
    img[TEXT_BAR_CLEAR] = 0
    return img


def stamped_document() -> Image:
    """The synthetic document with a red ring stamp and red text over black text."""
    img = document()
    cv2.circle(img, STAMP_CENTER, STAMP_RADIUS, RED, 8, cv2.LINE_8)
    cv2.putText(img, "PAID", (360, 260), cv2.FONT_HERSHEY_SIMPLEX, 1.4, RED, 4, cv2.LINE_8)
    # Re-draw the black bar on top so text overlaps the stamp, as in real scans.
    img[TEXT_BAR_UNDER_STAMP] = 0
    return img


def blue_ink_document() -> Image:
    img = document()
    cv2.putText(img, "BLUE INK NOTE", (40, 560), cv2.FONT_HERSHEY_SIMPLEX, 1.0, BLUE, 3, cv2.LINE_8)
    return img


def blurry(img: Image) -> Image:
    return np.asarray(cv2.GaussianBlur(img, (0, 0), sigmaX=6), dtype=np.uint8)


def checkerboard(size: int = 64) -> Image:
    """1-px checkerboard: maximal Laplacian response (exercises score clamping)."""
    yy, xx = np.indices((size, size))
    board = (((yy + xx) % 2) * 255).astype(np.uint8)
    return np.asarray(cv2.cvtColor(board, cv2.COLOR_GRAY2BGR), dtype=np.uint8)


def encode(img: Image, ext: str = ".png", params: list[int] | None = None) -> bytes:
    ok, buf = cv2.imencode(ext, img, params or [])
    assert ok
    return bytes(buf.tobytes())


def solid_png(width: int, height: int) -> bytes:
    """A highly compressible solid PNG: tiny file, large decoded size."""
    return encode(np.full((height, width), 255, dtype=np.uint8), ".png", [cv2.IMWRITE_PNG_COMPRESSION, 9])


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def request_params(data: bytes, content_type: str = "image/png", **overrides: object) -> dict[str, str]:
    params: dict[str, object] = {
        "documentId": str(uuid.UUID(int=0x28)),
        "docType": "ITEMIZED_LIST",
        "declaredContentType": content_type,
        "declaredSha256": sha256(data),
        "declaredSizeBytes": len(data),
    }
    params.update(overrides)
    return {k: str(v) for k, v in params.items()}
