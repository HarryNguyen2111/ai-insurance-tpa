"""Provenance and immutability (includes the PT19 provenance subset)."""

from __future__ import annotations

import base64
import hashlib
from typing import Any

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

import synth
from conftest import PREPROCESS_URL
from tpa_ai_worker.config import Limits
from tpa_ai_worker.models import PreprocessRequest
from tpa_ai_worker.preprocess import preprocess


def _ok(client: TestClient, data: bytes, content_type: str = "image/png") -> dict[str, Any]:
    r = client.post(
        PREPROCESS_URL, params=synth.request_params(data, content_type), content=data, headers={"content-type": content_type}
    )
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    body: dict[str, Any] = r.json()
    return body


def test_pt19_provenance_identifies_original_and_derived(client: TestClient) -> None:
    data = synth.encode(synth.stamped_document())
    body = _ok(client, data)

    original = body["original"]
    assert original["role"] == "ORIGINAL"
    assert original["sha256"] == hashlib.sha256(data).hexdigest()
    assert original["sizeBytes"] == len(data)
    assert original["derivedFromSha256"] is None and original["transform"] is None
    assert (original["widthPx"], original["heightPx"]) == (600, 800)

    (derived,) = body["derived"]
    prov = derived["provenance"]
    png = base64.b64decode(derived["contentBase64"], validate=True)
    assert prov["role"] == "DERIVED"
    assert prov["derivedFromSha256"] == original["sha256"]
    assert prov["sha256"] == hashlib.sha256(png).hexdigest() != original["sha256"]
    assert prov["sizeBytes"] == len(png)
    assert prov["contentType"] == "image/png"
    assert prov["transform"]["name"] == "red_stamp_suppression"
    assert prov["transform"]["version"] == "1"
    assert prov["transform"]["parameters"]["colorSpace"] == "HSV"

    decoded = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_UNCHANGED)
    assert decoded is not None
    assert decoded.ndim == 2 and decoded.shape == (800, 600)
    x, y = synth.STAMP_RING_PROBE
    assert int(decoded[y, x]) > 240  # stamp suppressed in the derived artifact only


def test_pt19_model_version_and_no_decision_authority(client: TestClient) -> None:
    prov = _ok(client, synth.encode(synth.document()))["provenance"]
    assert prov["worker"] == "tpa-ai-worker"
    assert prov["workerVersion"] == "0.1.0"
    assert prov["opencvVersion"] == cv2.__version__
    assert prov["numpyVersion"] == np.__version__
    assert prov["proposalOnly"] is True
    assert prov["decisionAuthority"] == "NONE"


def test_original_checksum_preserved(client: TestClient) -> None:
    data = synth.encode(synth.stamped_document())
    integrity = _ok(client, data)["integrity"]
    expected = hashlib.sha256(data).hexdigest()
    assert integrity == {
        "declaredSha256": expected,
        "sha256Before": expected,
        "sha256After": expected,
        "unchanged": True,
    }


def test_caller_bytes_are_untouched_by_pure_pipeline() -> None:
    data = synth.encode(synth.stamped_document())
    snapshot = bytes(bytearray(data))
    req = PreprocessRequest.model_validate(synth.request_params(data))
    result = preprocess(req, data, Limits())
    assert data == snapshot
    assert result.original.sha256 == hashlib.sha256(snapshot).hexdigest()


def test_derived_output_is_deterministic(client: TestClient) -> None:
    data = synth.encode(synth.stamped_document())
    first = _ok(client, data)["derived"][0]["provenance"]["sha256"]
    second = _ok(client, data)["derived"][0]["provenance"]["sha256"]
    assert first == second


def test_blurry_image_fails_gate_without_derivation(client: TestClient) -> None:
    data = synth.encode(synth.blurry(synth.stamped_document()))
    body = _ok(client, data)
    quality = body["quality"]
    assert quality["gate"] == "FAILED_BLUR"
    assert quality["blurThreshold"] == "65.00"
    assert float(quality["blurScore"]) < 65
    assert [w["code"] for w in quality["warnings"]] == ["BLURRY_IMAGE"]
    assert quality["warnings"][0]["ruleVersion"] == "blur-laplacian-variance-v1"
    assert body["derived"] == []
    assert body["integrity"]["unchanged"] is True


def test_sharp_image_passes_gate(client: TestClient) -> None:
    quality = _ok(client, synth.encode(synth.document()))["quality"]
    assert quality["gate"] == "PASSED"
    assert quality["warnings"] == []
    assert isinstance(quality["blurScore"], str)


@pytest.mark.parametrize(
    ("ext", "content_type"),
    [(".jpg", "image/jpeg"), (".webp", "image/webp"), (".png", "image/png")],
)
def test_supported_formats(client: TestClient, ext: str, content_type: str) -> None:
    data = synth.encode(synth.stamped_document(), ext)
    body = _ok(client, data, content_type)
    assert body["original"]["contentType"] == content_type
    assert len(body["derived"]) == 1


def test_document_identity_echoed(client: TestClient) -> None:
    data = synth.encode(synth.document())
    body = _ok(client, data)
    assert body["documentId"] == synth.request_params(data)["documentId"]
    assert body["docType"] == "ITEMIZED_LIST"
