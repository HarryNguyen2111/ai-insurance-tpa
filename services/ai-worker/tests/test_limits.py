"""File size/type/dimension limits (includes the PT15 oversize/file-bomb subset)."""

from __future__ import annotations

from collections.abc import Iterator

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

import synth
from conftest import PREPROCESS_URL
from tpa_ai_worker.config import TECHNICAL_MAX_BYTES, Limits, load_limits
from tpa_ai_worker.models import PreprocessRequest
from tpa_ai_worker.preprocess import Rejection, RejectionCode, validate
from tpa_ai_worker.sniff import Dimensions, read_dimensions, sniff_content_type


def _post(client: TestClient, data: bytes, params: dict[str, str], content_type: str = "image/png") -> tuple[int, str]:
    r = client.post(PREPROCESS_URL, params=params, content=data, headers={"content-type": content_type})
    body = r.json()
    return r.status_code, body.get("error", {}).get("code", "")


def test_technical_max_matches_upload_contract() -> None:
    # UploadRequest.sizeBytes maximum in 02-openapi-contracts.yaml.
    assert TECHNICAL_MAX_BYTES == 20971520


def test_pt15_oversize_body_rejected_by_content_length(small_client: TestClient) -> None:
    data = b"\x89PNG\r\n\x1a\n" + bytes(70 * 1024)
    assert _post(small_client, data, synth.request_params(data)) == (413, "PAYLOAD_TOO_LARGE")


def test_pt15_oversize_streamed_body_rejected_without_full_buffering(small_client: TestClient) -> None:
    sent = 0

    def chunks() -> Iterator[bytes]:
        nonlocal sent
        for _ in range(100):  # would be 1.6 MiB in total
            sent += 16 * 1024
            yield bytes(16 * 1024)

    params = synth.request_params(b"x", declaredSizeBytes=1000)
    r = small_client.post(PREPROCESS_URL, params=params, content=chunks(), headers={"content-type": "image/png"})
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_technical_limit_enforced_by_pure_validator() -> None:
    data = b"\x89PNG\r\n\x1a\n" + bytes(TECHNICAL_MAX_BYTES - 7)
    assert len(data) == TECHNICAL_MAX_BYTES + 1
    req = PreprocessRequest.model_validate(synth.request_params(b"x", declaredSizeBytes=TECHNICAL_MAX_BYTES))
    with pytest.raises(Rejection) as exc:
        validate(req, data, Limits())
    assert exc.value.code is RejectionCode.PAYLOAD_TOO_LARGE


def test_declared_size_above_technical_max_is_invalid(client: TestClient) -> None:
    data = synth.encode(synth.document())
    params = synth.request_params(data, declaredSizeBytes=TECHNICAL_MAX_BYTES + 1)
    assert _post(client, data, params) == (422, "INVALID_REQUEST")


def test_pt15_decompression_bomb_rejected_before_decoding(
    small_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = synth.solid_png(2000, 2000)  # 4 MP decoded, a few KB on disk; limit is 1 MP
    assert len(data) < 64 * 1024

    def _must_not_decode(*_: object, **__: object) -> None:
        raise AssertionError("decoder must not run for an oversize header")

    monkeypatch.setattr(cv2, "imdecode", _must_not_decode)
    assert _post(small_client, data, synth.request_params(data)) == (413, "IMAGE_DIMENSIONS_EXCEEDED")


def test_pt15_technical_pixel_ceiling(client: TestClient) -> None:
    data = synth.solid_png(8000, 6000)  # 48 MP > 40 MP technical ceiling
    assert _post(client, data, synth.request_params(data)) == (413, "IMAGE_DIMENSIONS_EXCEEDED")


def test_opencv_decoder_pixel_cap_is_configured() -> None:
    import os

    assert int(os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"]) <= 40_000_000


def test_image_too_small(client: TestClient) -> None:
    data = synth.encode(np.full((10, 10, 3), 255, dtype=np.uint8))
    assert _post(client, data, synth.request_params(data)) == (422, "IMAGE_TOO_SMALL")


@pytest.mark.parametrize(
    ("declared", "payload"),
    [
        ("image/heic", b"\x00\x00\x00\x18ftypheic" + bytes(64)),
        ("image/heif", b"\x00\x00\x00\x18ftypmif1" + bytes(64)),
        ("application/pdf", b"%PDF-1.7\n" + bytes(64)),
        ("application/xml", b"<?xml version='1.0'?><a/>"),
        ("image/gif", b"GIF89a" + bytes(64)),
        ("image/svg+xml", b"<svg xmlns='http://www.w3.org/2000/svg'/>"),
    ],
)
def test_unsupported_declared_types(client: TestClient, declared: str, payload: bytes) -> None:
    assert _post(client, payload, synth.request_params(payload, declared), declared) == (415, "UNSUPPORTED_MEDIA_TYPE")


@pytest.mark.parametrize(
    ("declared", "payload"),
    [
        ("image/png", synth.encode(synth.document(), ".jpg")),
        ("image/jpeg", synth.encode(synth.document(), ".png")),
        ("image/png", b"%PDF-1.7\n" + bytes(64)),  # PDF disguised as PNG
        ("image/webp", b"\x00\x00\x00\x18ftypheic" + bytes(64)),  # HEIC disguised as WebP
    ],
)
def test_content_must_match_declared_type(client: TestClient, declared: str, payload: bytes) -> None:
    assert _post(client, payload, synth.request_params(payload, declared), declared) == (415, "CONTENT_TYPE_MISMATCH")


def test_checksum_mismatch_rejected(client: TestClient) -> None:
    data = synth.encode(synth.document())
    params = synth.request_params(data, declaredSha256="0" * 64)
    assert _post(client, data, params) == (422, "CHECKSUM_MISMATCH")


def test_size_mismatch_rejected(client: TestClient) -> None:
    data = synth.encode(synth.document())
    params = synth.request_params(data, declaredSizeBytes=len(data) + 1)
    assert _post(client, data, params) == (422, "SIZE_MISMATCH")


def test_empty_body_rejected(client: TestClient) -> None:
    params = synth.request_params(b"x")
    assert _post(client, b"", params) == (422, "EMPTY_BODY")


def test_corrupt_image_with_valid_header_rejected(client: TestClient) -> None:
    good = synth.encode(synth.document())
    data = good[:64] + bytes(len(good) - 64)
    assert _post(client, data, synth.request_params(data)) == (422, "UNDECODABLE_IMAGE")


def test_truncated_header_rejected(client: TestClient) -> None:
    data = b"\x89PNG\r\n\x1a\n" + bytes(4)
    assert _post(client, data, synth.request_params(data)) == (422, "UNDECODABLE_IMAGE")


@pytest.mark.parametrize(
    ("ext", "params", "content_type"),
    [
        (".png", [], "image/png"),
        (".jpg", [cv2.IMWRITE_JPEG_QUALITY, 90], "image/jpeg"),
        (".jpg", [cv2.IMWRITE_JPEG_PROGRESSIVE, 1], "image/jpeg"),
        (".webp", [cv2.IMWRITE_WEBP_QUALITY, 80], "image/webp"),
        (".webp", [cv2.IMWRITE_WEBP_QUALITY, 101], "image/webp"),  # lossless VP8L
    ],
)
def test_header_dimensions_match_encoder(ext: str, params: list[int], content_type: str) -> None:
    data = synth.encode(synth.document(width=333, height=517), ext, params)
    assert sniff_content_type(data) == content_type
    assert read_dimensions(data, content_type) == Dimensions(333, 517)


def test_webp_vp8x_header_dimensions() -> None:
    header = b"RIFF" + bytes(4) + b"WEBP" + b"VP8X" + (10).to_bytes(4, "little") + bytes(4)
    header += (1199).to_bytes(3, "little") + (1599).to_bytes(3, "little")
    assert read_dimensions(header, "image/webp") == Dimensions(1200, 1600)


def test_env_overrides_may_only_tighten(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_WORKER_MAX_BYTES", "1024")
    assert load_limits().max_bytes == 1024
    monkeypatch.setenv("AI_WORKER_MAX_BYTES", str(10**12))
    assert load_limits().max_bytes == TECHNICAL_MAX_BYTES
    monkeypatch.setenv("AI_WORKER_MAX_BYTES", "-1")
    with pytest.raises(ValueError):
        load_limits()
