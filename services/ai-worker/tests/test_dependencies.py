"""Smoke checks that the approved stack (OpenCV, pyzbar, lxml) installs and loads.

QR/XML *behaviour* is issue #29; these only prove the bootstrap works. pyzbar
needs the system ``libzbar0`` library: CI installs it and sets
AI_WORKER_REQUIRE_ZBAR=1 so a missing library fails instead of skipping.
"""

from __future__ import annotations

import os

import cv2
import numpy as np
import pytest
from lxml import etree


def test_opencv_headless_major_version() -> None:
    assert cv2.__version__.split(".")[0] == "5"


def test_lxml_parses_without_entity_resolution() -> None:
    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    root = etree.fromstring(b"<invoice><line>SYNTHETIC</line></invoice>", parser)
    assert root.findtext("line") == "SYNTHETIC"


def test_pyzbar_decodes_synthetic_qr() -> None:
    try:
        from pyzbar import pyzbar
    except ImportError as exc:  # libzbar shared library missing
        if os.environ.get("AI_WORKER_REQUIRE_ZBAR") == "1":
            raise
        pytest.skip(f"libzbar not available locally: {exc}")
    qr = cv2.QRCodeEncoder.create().encode("SYNTHETIC-QR-001")
    qr = cv2.resize(qr, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
    qr = cv2.copyMakeBorder(qr, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)
    decoded = pyzbar.decode(np.ascontiguousarray(qr))
    assert [d.data for d in decoded] == [b"SYNTHETIC-QR-001"]
