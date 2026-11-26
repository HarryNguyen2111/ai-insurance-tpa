"""Content sniffing and header-only dimension parsing.

Dimensions are read from the container header *before* any pixel decoding so
that a tiny file that decodes to a huge bitmap (decompression bomb) is
rejected without allocating it.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

JPEG = "image/jpeg"
PNG = "image/png"
WEBP = "image/webp"

# Types this worker can decode. HEIC/HEIF must first be converted to a derived
# WebP (Imgproxy, per AGENTS.md); PDF and XML belong to other pipelines.
SUPPORTED_IMAGE_TYPES = frozenset({JPEG, PNG, WEBP})

_HEIF_BRANDS = frozenset({b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1"})

# JPEG start-of-frame markers that carry dimensions (excludes DHT C4, JPG C8, DAC CC).
_SOF_MARKERS = frozenset({0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF})


class HeaderError(ValueError):
    """The container header is truncated or malformed."""


@dataclass(frozen=True, slots=True)
class Dimensions:
    width: int
    height: int

    @property
    def pixels(self) -> int:
        return self.width * self.height


def sniff_content_type(data: bytes) -> str | None:
    """Identify the actual content type from magic bytes; ``None`` if unknown."""
    if data.startswith(b"\xff\xd8\xff"):
        return JPEG
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return PNG
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return WEBP
    if len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] in _HEIF_BRANDS:
        return "image/heic"
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    if data.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"<?xml"):
        return "application/xml"
    return None


def read_dimensions(data: bytes, content_type: str) -> Dimensions:
    if content_type == PNG:
        return _png_dimensions(data)
    if content_type == JPEG:
        return _jpeg_dimensions(data)
    if content_type == WEBP:
        return _webp_dimensions(data)
    raise HeaderError(f"no header parser for {content_type}")


def _png_dimensions(data: bytes) -> Dimensions:
    # 8-byte signature, then the IHDR chunk: length(4) type(4) width(4) height(4).
    if len(data) < 24 or data[12:16] != b"IHDR":
        raise HeaderError("PNG IHDR missing")
    width, height = struct.unpack(">II", data[16:24])
    return Dimensions(width, height)


def _jpeg_dimensions(data: bytes) -> Dimensions:
    i = 2
    n = len(data)
    while i < n:
        if data[i] != 0xFF:
            raise HeaderError("JPEG marker expected")
        while i < n and data[i] == 0xFF:  # fill bytes
            i += 1
        if i >= n:
            break
        marker = data[i]
        i += 1
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:  # standalone markers
            continue
        if marker in (0xD9, 0xDA):  # EOI / start of scan before any frame header
            break
        if i + 2 > n:
            break
        (length,) = struct.unpack(">H", data[i : i + 2])
        if length < 2:
            raise HeaderError("JPEG segment length invalid")
        if marker in _SOF_MARKERS:
            if i + 7 > n:
                break
            height, width = struct.unpack(">HH", data[i + 3 : i + 7])
            return Dimensions(width, height)
        i += length
    raise HeaderError("JPEG frame header missing")


def _webp_dimensions(data: bytes) -> Dimensions:
    if len(data) < 30:
        raise HeaderError("WebP header truncated")
    chunk = data[12:16]
    if chunk == b"VP8 ":
        if data[23:26] != b"\x9d\x01\x2a":
            raise HeaderError("WebP VP8 start code missing")
        width, height = struct.unpack("<HH", data[26:30])
        return Dimensions(width & 0x3FFF, height & 0x3FFF)
    if chunk == b"VP8L":
        if data[20] != 0x2F:
            raise HeaderError("WebP VP8L signature missing")
        b0, b1, b2, b3 = data[21:25]
        width = 1 + (b0 | ((b1 & 0x3F) << 8))
        height = 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0F) << 10))
        return Dimensions(width, height)
    if chunk == b"VP8X":
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
        return Dimensions(width, height)
    raise HeaderError("WebP chunk unknown")
