"""PT19 provenance subset: parse status is separate from tax verification and never self-labels VERIFIED_VALID."""

from __future__ import annotations

import ast
import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np
import numpy.typing as npt
import pytest

from invoice_fixtures import (
    BILLION_LAUGHS,
    MERGED_TC05_XML,
    XXE_FILE,
    invoice_xml,
    send,
    serve,
)
from tpa_ai_worker.invoice.fetch import FetchedDocument, FetchError, fetch_invoice_xml
from tpa_ai_worker.invoice.limits import FetchLimits, FetchPolicy
from tpa_ai_worker.invoice.models import InvoiceExtraction, TaxVerification
from tpa_ai_worker.invoice.pipeline import extract_from_invoice_image, extract_from_qr_payload, extract_from_xml

HOST = "invoice.example.vn"
QR_URL = f"https://{HOST}/tra-cuu?ma=SYNTH-SECRET-CODE"
POLICY = FetchPolicy(allowed_hosts=frozenset({HOST}), limits=FetchLimits(total_timeout_s=2.0, socket_timeout_s=1.0))
FIXED = datetime(2026, 11, 27, 3, 0, tzinfo=UTC)

# Documents that try hard to look verified: tax-authority code, signature
# block, and literal status words inside fields.
LOOKS_VERIFIED = invoice_xml(
    mccqt="SYNTHMCCQT00000000000000000001",
    extra_general="<TTKhac><TTin><TTruong>TrangThai</TTruong><DLieu>VERIFIED_VALID</DLieu></TTin></TTKhac>",
)


def _fixed() -> datetime:
    return FIXED


def _doc(content: bytes) -> FetchedDocument:
    return FetchedDocument(content=content, source=f"https://{HOST}", redirects=0)


def _assert_never_verified(result: InvoiceExtraction) -> None:
    tv = result.tax_verification.to_dict()
    assert tv["verificationStatus"] == "UNVERIFIED"
    assert "VERIFIED_VALID" not in json.dumps(tv)
    assert result.to_dict()["decisionAuthority"] == "NONE"


@pytest.mark.parametrize(
    "xml",
    [invoice_xml(), MERGED_TC05_XML, LOOKS_VERIFIED, BILLION_LAUGHS, XXE_FILE, b"garbage"],
    ids=["itemized", "merged-tc05", "looks-verified", "billion-laughs", "xxe", "garbage"],
)
def test_parsed_or_failed_xml_never_self_labels_verified(xml: bytes) -> None:
    result = extract_from_qr_payload(QR_URL, POLICY, fetcher=lambda u, p: _doc(xml), clock=_fixed)
    _assert_never_verified(result)


def test_successful_qr_parse_is_parsed_but_unverified_with_host_only_source() -> None:
    result = extract_from_qr_payload(QR_URL, POLICY, fetcher=lambda u, p: _doc(LOOKS_VERIFIED), clock=_fixed)
    assert result.tax_verification.parse_status == "PARSED"
    assert result.invoice is not None and result.invoice.tax_authority_code_present is True
    tv = result.tax_verification.to_dict()
    assert tv == {
        "parseStatus": "PARSED",
        "verificationStatus": "UNVERIFIED",
        "source": f"QR_XML_FETCH:https://{HOST}",
        "checkedAt": "2026-11-27T03:00:00+00:00",
    }
    assert "SYNTH-SECRET" not in json.dumps(result.to_dict())


def test_fetch_failure_is_unavailable_not_failed_and_not_verified() -> None:
    def refuse(url: str, policy: FetchPolicy) -> FetchedDocument:
        raise FetchError("DESTINATION_NOT_PUBLIC")

    result = extract_from_qr_payload(QR_URL, POLICY, fetcher=refuse, clock=_fixed)
    assert result.tax_verification.parse_status == "UNAVAILABLE"
    assert result.error_code == "DESTINATION_NOT_PUBLIC"
    assert result.invoice is None
    _assert_never_verified(result)


@pytest.mark.parametrize("payload", ["SYNTH|0109999999|C26TSY|1234", "javascript:alert(1)", "ftp://x/y", ""])
def test_non_url_qr_payload_is_unavailable_without_fetch(payload: str) -> None:
    def must_not_fetch(url: str, policy: FetchPolicy) -> FetchedDocument:
        raise AssertionError("fetch attempted")

    result = extract_from_qr_payload(payload, POLICY, fetcher=must_not_fetch)
    assert (result.tax_verification.parse_status, result.error_code) == ("UNAVAILABLE", "QR_NOT_URL")


def test_end_to_end_private_ip_qr_is_blocked_and_unavailable() -> None:
    import ipaddress

    with serve({"/tra-cuu": lambda h: send(h, invoice_xml())}) as rig:
        rig.dns[HOST] = [[ipaddress.ip_address("10.0.0.8")]]

        def fetcher(url: str, policy: FetchPolicy) -> FetchedDocument:
            return fetch_invoice_xml(url, policy, resolver=rig.resolver, connector=rig.connector)

        result = extract_from_qr_payload(QR_URL, POLICY, fetcher=fetcher)
    assert (result.tax_verification.parse_status, result.error_code) == ("UNAVAILABLE", "DESTINATION_NOT_PUBLIC")
    assert rig.connected == []


def test_end_to_end_allowed_qr_fetch_parses_merged_invoice() -> None:
    with serve({"/tra-cuu": lambda h: send(h, MERGED_TC05_XML)}) as rig:

        def fetcher(url: str, policy: FetchPolicy) -> FetchedDocument:
            return fetch_invoice_xml(url, policy, resolver=rig.resolver, connector=rig.connector)

        result = extract_from_qr_payload(QR_URL, POLICY, fetcher=fetcher)
    assert result.tax_verification.parse_status == "PARSED"
    assert result.invoice is not None and result.invoice.is_merged_summary is True
    _assert_never_verified(result)


def test_worker_cannot_construct_a_verified_outcome() -> None:
    for status in ("VERIFIED_VALID", "CANCELLED", "NOT_FOUND", "UNAVAILABLE"):
        with pytest.raises(ValueError):
            TaxVerification(parse_status="PARSED", source="XML_DOCUMENT", checked_at=FIXED, verification_status=status)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        InvoiceExtraction(tax_verification=TaxVerification(parse_status="PARSED", source="x", checked_at=FIXED))
    with pytest.raises(ValueError):
        TaxVerification(parse_status="PARSED", source="x", checked_at=datetime(2026, 1, 1))


def test_source_never_assigns_verified_status() -> None:
    """Static guard: no invoice module may emit a tax outcome other than UNVERIFIED."""
    src = Path(__file__).resolve().parents[1] / "src" / "tpa_ai_worker" / "invoice"
    for path in sorted(src.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        constants = {n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
        assert not constants & {"VERIFIED_VALID", "CANCELLED", "NOT_FOUND"}, path.name


def test_failures_log_nothing(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    with serve({"/tra-cuu": lambda h: send(h, b"", status=302, headers={"Location": "https://10.0.0.1/"})}) as rig:

        def fetcher(url: str, policy: FetchPolicy) -> FetchedDocument:
            return fetch_invoice_xml(url, policy, resolver=rig.resolver, connector=rig.connector)

        extract_from_qr_payload(QR_URL, POLICY, fetcher=fetcher)
    extract_from_xml(invoice_xml(seller_mst="bad"))
    extract_from_xml(BILLION_LAUGHS)
    worker_records = [r for r in caplog.records if r.name.startswith("tpa_ai_worker")]
    assert worker_records == []
    assert "SYNTH" not in caplog.text


# ------------------------------------------------------------ QR image (pyzbar)


def _qr_image(text: str) -> npt.NDArray[np.uint8]:
    qr = cv2.QRCodeEncoder.create().encode(text)
    qr = cv2.resize(qr, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
    out = cv2.copyMakeBorder(qr, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)
    return np.ascontiguousarray(out, dtype=np.uint8)


def _require_zbar() -> None:
    try:
        from pyzbar import pyzbar  # noqa: F401
    except ImportError as exc:
        if os.environ.get("AI_WORKER_REQUIRE_ZBAR") == "1":
            raise
        pytest.skip(f"libzbar not available locally: {exc}")


def test_qr_image_to_unverified_invoice() -> None:
    _require_zbar()
    seen: list[str] = []

    def fetcher(url: str, policy: FetchPolicy) -> FetchedDocument:
        seen.append(url)
        return _doc(invoice_xml())

    color = cv2.cvtColor(_qr_image(QR_URL), cv2.COLOR_GRAY2BGR)
    result = extract_from_invoice_image(np.ascontiguousarray(color, dtype=np.uint8), POLICY, fetcher=fetcher)
    assert seen == [QR_URL]
    assert result.tax_verification.parse_status == "PARSED"
    _assert_never_verified(result)


def test_qr_image_without_code_is_unavailable() -> None:
    _require_zbar()
    blank = np.full((200, 200), 255, dtype=np.uint8)
    result = extract_from_invoice_image(blank, POLICY, fetcher=lambda u, p: _doc(b""))
    assert (result.tax_verification.parse_status, result.error_code) == ("UNAVAILABLE", "QR_NOT_FOUND")


def test_qr_image_pointing_to_metadata_ip_is_blocked() -> None:
    _require_zbar()
    image = _qr_image("https://169.254.169.254/latest/meta-data/iam")
    with serve({}) as rig:

        def fetcher(url: str, policy: FetchPolicy) -> FetchedDocument:
            return fetch_invoice_xml(url, policy, resolver=rig.resolver, connector=rig.connector)

        result = extract_from_invoice_image(image, POLICY, fetcher=fetcher)
    assert (result.tax_verification.parse_status, result.error_code) == ("UNAVAILABLE", "HOST_IP_LITERAL")
    assert rig.resolved == [] and rig.connected == []
