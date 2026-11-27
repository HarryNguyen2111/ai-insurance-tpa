"""QR decoding with pyzbar (needs the system ``libzbar0`` library).

Payloads are untrusted: oversized or non-UTF-8 payloads are dropped and
nothing is logged.
"""

from __future__ import annotations

import cv2
import numpy as np
import numpy.typing as npt

MAX_QR_PAYLOAD_BYTES = 2048


class QrUnavailable(RuntimeError):
    """pyzbar/libzbar is not installed in this runtime."""


def decode_qr_payloads(image: npt.NDArray[np.uint8], *, max_payload_bytes: int = MAX_QR_PAYLOAD_BYTES) -> list[str]:
    """Return distinct UTF-8 QR payloads, in detection order."""
    try:
        from pyzbar import pyzbar
    except ImportError as exc:  # libzbar shared library missing
        raise QrUnavailable("QR_DECODER_UNAVAILABLE") from exc
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    results = pyzbar.decode(np.ascontiguousarray(gray), symbols=[pyzbar.ZBarSymbol.QRCODE])
    payloads: list[str] = []
    for result in results:
        data: bytes = result.data
        if len(data) > max_payload_bytes:
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if text not in payloads:
            payloads.append(text)
    return payloads
