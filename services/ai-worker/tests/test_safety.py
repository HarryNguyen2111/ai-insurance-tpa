"""Guardrails: no network, no PII/content in logs or errors, no approval/money fields."""

from __future__ import annotations

import ast
import logging
import socket
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import synth
from conftest import PREPROCESS_URL
from tpa_ai_worker.config import Limits
from tpa_ai_worker.models import PreprocessRequest, PreprocessResult
from tpa_ai_worker.preprocess import preprocess

SRC = Path(__file__).resolve().parents[1] / "src" / "tpa_ai_worker"

NETWORK_MODULES = {"socket", "ssl", "http", "urllib", "urllib3", "requests", "httpx", "httpx2", "aiohttp", "ftplib", "smtplib", "boto3", "botocore"}

FORBIDDEN_KEY_FRAGMENTS = (
    "amount", "money", "price", "payout", "payment", "approve", "approval", "reject",
    "decision", "benefit", "eob", "status", "verified", "tenant", "member", "fullname", "filename", "phone", "cccd", "bank",
)  # fmt: skip


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module.split(".")[0])
    return found


def test_source_imports_no_network_clients() -> None:
    files = sorted(SRC.glob("*.py"))
    assert files
    for path in files:
        assert not (_imports(path) & NETWORK_MODULES), path.name


def _full_imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module)
    return found


def test_only_invoice_fetch_module_may_use_the_network() -> None:
    """AI-02 needs outbound HTTPS for QR XML lookup; keep it confined to fetch.py."""
    files = sorted((SRC / "invoice").glob("*.py"))
    assert files
    for path in files:
        network = {m for m in _full_imports(path) if m.split(".")[0] in NETWORK_MODULES}
        if path.name == "fetch.py":
            assert network == {"socket", "ssl", "http.client", "urllib.parse"}, network
        elif path.name == "urlpolicy.py":
            assert network == {"urllib.parse"}, network  # pure string parsing
        else:
            assert network == set(), path.name


def test_pipeline_runs_with_network_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    def _blocked(*_: object, **__: object) -> None:
        raise AssertionError("network access attempted")

    monkeypatch.setattr(socket.socket, "connect", _blocked)
    monkeypatch.setattr(socket, "getaddrinfo", _blocked)
    monkeypatch.setattr(socket, "create_connection", _blocked)
    data = synth.encode(synth.stamped_document())
    result = preprocess(PreprocessRequest.model_validate(synth.request_params(data)), data, Limits())
    assert len(result.derived) == 1


def _keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        out = set(value)
        for v in value.values():
            out |= _keys(v)
        return out
    if isinstance(value, list):
        out = set()
        for v in value:
            out |= _keys(v)
        return out
    return set()


def test_response_schema_has_no_decision_money_or_pii_fields(client: TestClient) -> None:
    data = synth.encode(synth.stamped_document())
    body = client.post(PREPROCESS_URL, params=synth.request_params(data), content=data).json()
    # decisionAuthority is a deliberate constant marker, asserted to be NONE.
    assert body["provenance"]["decisionAuthority"] == "NONE"
    keys = {k.lower() for k in _keys(body)} - {"decisionauthority"}
    for key in keys:
        assert not any(fragment in key for fragment in FORBIDDEN_KEY_FRAGMENTS), key
    schema_keys = {k.lower() for k in _keys(PreprocessResult.model_json_schema(by_alias=True))}
    assert not {"amount", "approved", "decision", "tenantid"} & schema_keys


def test_logs_and_errors_never_echo_content(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    data = synth.encode(synth.stamped_document())
    params = synth.request_params(data)
    ok = client.post(PREPROCESS_URL, params=params, content=data)
    assert ok.status_code == 200
    bad = client.post(PREPROCESS_URL, params=synth.request_params(data, declaredSha256="f" * 64), content=data)
    assert bad.status_code == 422

    canary = "NGUYEN-VAN-A-0912345678"  # synthetic PII-shaped canary
    invalid = client.post(PREPROCESS_URL, params={**params, "declaredSha256": canary, "fileName": canary}, content=data)
    assert invalid.status_code == 422
    assert canary not in invalid.text

    # Only the worker's own loggers; the test HTTP client logs its request URL itself.
    logged = "\n".join(r.getMessage() for r in caplog.records if r.name.startswith(("tpa_ai_worker", "uvicorn", "fastapi")))
    assert "preprocess done" in logged and "CHECKSUM_MISMATCH" in logged
    for secret in (params["declaredSha256"], params["documentId"], canary, "f" * 64):
        assert secret not in logged
        assert secret not in bad.text
    assert ok.json()["derived"][0]["contentBase64"][:64] not in logged


def test_request_model_rejects_unknown_fields() -> None:
    data = synth.encode(synth.document())
    with pytest.raises(ValueError):
        PreprocessRequest.model_validate({**synth.request_params(data), "tenantId": "x"})
