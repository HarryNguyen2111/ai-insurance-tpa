"""Hardened XML parsing (PT15 XXE/entity expansion) and invoice extraction (TC05 merged subset)."""

from __future__ import annotations

import json
import socket
import time
from datetime import date
from decimal import Decimal

import pytest

from invoice_fixtures import (
    BILLION_LAUGHS,
    BUYER_ADDRESS_MARKER,
    BUYER_ID_MARKER,
    BUYER_NAME_MARKER,
    MERGED_TC05_XML,
    XXE_FILE,
    XXE_NETWORK_DTD,
    XXE_PARAMETER,
    Line,
    invoice_xml,
    utf16,
)
from tpa_ai_worker.invoice.limits import XmlLimits
from tpa_ai_worker.invoice.models import ExtractedInvoice
from tpa_ai_worker.invoice.pipeline import extract_from_xml
from tpa_ai_worker.invoice.xmlparse import XmlParseError, classify_buyer, parse_money, parse_secure_xml


def _failed(data: bytes, limits: XmlLimits | None = None) -> str:
    result = extract_from_xml(data, limits=limits)
    assert result.tax_verification.parse_status == "FAILED"
    assert result.invoice is None
    assert result.error_code is not None
    return result.error_code


def _parsed(data: bytes) -> ExtractedInvoice:
    result = extract_from_xml(data)
    assert result.tax_verification.parse_status == "PARSED", result.error_code
    assert result.invoice is not None
    return result.invoice


@pytest.fixture
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def _blocked(*_: object, **__: object) -> None:
        raise AssertionError("network access attempted")

    monkeypatch.setattr(socket.socket, "connect", _blocked)
    monkeypatch.setattr(socket, "getaddrinfo", _blocked)
    monkeypatch.setattr(socket, "create_connection", _blocked)


# ------------------------------------------------------------ XXE / DTD


@pytest.mark.parametrize(
    "payload",
    [BILLION_LAUGHS, XXE_FILE, XXE_NETWORK_DTD, XXE_PARAMETER],
    ids=["billion-laughs", "xxe-file", "external-dtd", "parameter-entity"],
)
def test_dtd_and_entities_are_refused_without_network(payload: bytes, no_network: None) -> None:
    started = time.monotonic()
    assert _failed(payload) == "XML_DTD_FORBIDDEN"
    assert time.monotonic() - started < 1.0  # no expansion happened


@pytest.mark.parametrize(
    "payload",
    [BILLION_LAUGHS, XXE_FILE, XXE_PARAMETER],
    ids=["billion-laughs", "xxe-file", "parameter-entity"],
)
def test_utf16_encoded_dtd_bypassing_byte_scan_is_still_refused(payload: bytes, no_network: None) -> None:
    encoded = utf16(payload)
    assert b"<!DOCTYPE" not in encoded  # the fast pre-scan cannot see it
    with pytest.raises(XmlParseError) as exc:
        parse_secure_xml(encoded, XmlLimits())
    assert exc.value.code in {"XML_DTD_FORBIDDEN", "XML_MALFORMED"}
    assert _failed(encoded) in {"XML_DTD_FORBIDDEN", "XML_MALFORMED"}


def test_utf16_internal_subset_is_detected_after_parse(no_network: None) -> None:
    doc = '<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE x [<!ENTITY e "boom">]><x>&e;</x>'.encode("utf-16")
    with pytest.raises(XmlParseError) as exc:
        parse_secure_xml(doc, XmlLimits())
    assert exc.value.code == "XML_DTD_FORBIDDEN"


def test_xinclude_is_never_processed(no_network: None) -> None:
    xml = invoice_xml(
        [Line("Thuốc A (synthetic)", "100000"), Line("Thuốc B (synthetic)", "200000")], total="300000"
    ).replace(
        b"<PBan>",
        b'<xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="file:///etc/passwd" parse="text"/><PBan>',
    )
    out = json.dumps(extract_from_xml(xml).to_dict(), ensure_ascii=False)
    assert "root:" not in out


# ------------------------------------------------------------ size limits


def test_oversize_deep_and_wide_documents_are_refused() -> None:
    assert _failed(invoice_xml(), XmlLimits(max_bytes=100)) == "XML_TOO_LARGE"
    deep = b"<a>" * 100 + b"</a>" * 100
    assert _failed(deep) == "XML_TOO_DEEP"
    wide = b"<a>" + b"<b/>" * 30_000 + b"</a>"
    assert _failed(wide) == "XML_TOO_MANY_ELEMENTS"
    many = invoice_xml([Line(f"Dòng {i}", "1000") for i in range(5)], total="5000")
    assert _failed(many, XmlLimits(max_lines=4)) == "LINES_TOO_MANY"


def test_malformed_xml_fails_cleanly() -> None:
    assert _failed(b"<HDon><unclosed></HDon>") == "XML_MALFORMED"
    assert _failed(b"\x89PNG\r\n\x1a\n binary") == "XML_MALFORMED"
    assert _failed(b"") == "XML_MALFORMED"


# ------------------------------------------------------------ extraction


def test_itemized_invoice_is_extracted_with_decimal_money() -> None:
    inv = _parsed(invoice_xml())
    assert inv.seller_tax_code == "0109999999"
    assert (inv.template_code, inv.invoice_serial, inv.invoice_number) == ("1", "C26TSY", "1234")
    assert inv.invoice_date == date(2026, 10, 15)
    assert inv.total_amount == Decimal("1650000.00")
    assert inv.is_merged_summary is False
    assert [line.amount for line in inv.lines] == [Decimal("150000.00"), Decimal("500000.00"), Decimal("1000000.00")]
    assert inv.lines[2].quantity == Decimal("10.00") and inv.lines[2].unit_price == Decimal("100000.00")
    assert all(isinstance(line.amount, Decimal) for line in inv.lines)


def test_json_output_has_money_as_strings_and_no_floats() -> None:
    def _no_float(raw: str) -> float:
        raise AssertionError(f"float in output: {raw}")

    out = extract_from_xml(invoice_xml()).to_dict()
    decoded = json.loads(json.dumps(out), parse_float=_no_float)
    invoice = decoded["invoice"]
    assert invoice["totalAmount"] == "1650000.00"
    assert [line["amount"] for line in invoice["lines"]] == ["150000.00", "500000.00", "1000000.00"]
    assert invoice["lines"][2]["unitPrice"] == "100000.00"
    assert decoded["proposalOnly"] is True and decoded["decisionAuthority"] == "NONE"


def test_merged_single_line_xml_is_flagged_tc05_subset() -> None:
    """TC05_MERGED_XML_PUBLIC_HOSPITAL input: one 2.000.000đ summary line -> is_merged_summary=true."""
    inv = _parsed(MERGED_TC05_XML)
    assert inv.is_merged_summary is True
    assert inv.total_amount == Decimal("2000000.00")
    assert len(inv.lines) == 1
    assert extract_from_xml(MERGED_TC05_XML).to_dict()["invoice"]["isMergedSummary"] is True  # type: ignore[index]


def test_merged_detection_ignores_non_goods_lines() -> None:
    lines = [
        Line("Chi phí theo bảng kê (synthetic)", "2000000"),
        Line("Ghi chú (synthetic)", "0", nature="4"),
        Line("Chiết khấu (synthetic)", "10000", nature="3"),
    ]
    assert _parsed(invoice_xml(lines, total="1990000")).is_merged_summary is True
    assert _parsed(invoice_xml([Line("Ghi chú", "0", nature="4")], total="0")).is_merged_summary is True
    two = [Line("A (synthetic)", "1000"), Line("B (synthetic)", "2000")]
    assert _parsed(invoice_xml(two, total="3000")).is_merged_summary is False


def test_namespaced_envelope_is_supported() -> None:
    xml = invoice_xml(namespace="http://synthetic.example/hdon", envelope=True)
    assert _parsed(xml).invoice_number == "1234"


@pytest.mark.parametrize(
    "raw",
    ["1e6", "1E+6", "1,000,000", "1.000.000", "-5", "+5", "NaN", "Infinity", "", " ", "0x10", "١٢٣", "12345678901234"],
)
def test_money_rejects_non_plain_decimals(raw: str) -> None:
    with pytest.raises(XmlParseError):
        parse_money(raw, "X")
    assert _failed(invoice_xml(total=raw)) == "TOTAL_AMOUNT_INVALID"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("1234.565", "1234.57"), ("0.005", "0.01"), ("0.004", "0.00"), ("720000", "720000.00"), ("2.5", "2.50")],
)
def test_money_rounds_half_up_to_cents(raw: str, expected: str) -> None:
    assert f"{parse_money(raw, 'X'):f}" == expected


@pytest.mark.parametrize(
    ("kwargs", "code"),
    [
        ({"seller_mst": ""}, "SELLER_TAX_CODE_INVALID"),
        ({"seller_mst": "01ABC"}, "SELLER_TAX_CODE_INVALID"),
        ({"serial": ""}, "INVOICE_SERIAL_INVALID"),
        ({"number": "12 34"}, "INVOICE_NUMBER_INVALID"),
        ({"issued": "15/10/2026"}, "INVOICE_DATE_INVALID"),
        ({"issued": "2026-02-30"}, "INVOICE_DATE_INVALID"),
        ({"lines": [Line("", "1000")]}, "LINE_NAME_MISSING"),
        ({"lines": [Line("A", "1e3", unit_price="1000")]}, "LINE_AMOUNT_INVALID"),
        ({"lines": [Line("A", "1000", unit_price="1,000")]}, "LINE_UNIT_PRICE_INVALID"),
        ({"lines": [Line("A", "1000", quantity="-1")]}, "LINE_QUANTITY_INVALID"),
        ({"lines": [Line("A", "1000", nature="9")]}, "LINE_NATURE_INVALID"),
    ],
)
def test_invalid_required_fields_fail_closed(kwargs: dict[str, object], code: str) -> None:
    assert _failed(invoice_xml(**kwargs)) == code  # type: ignore[arg-type]


def test_document_without_exactly_one_invoice_fails() -> None:
    assert _failed(b"<root><x/></root>") == "INVOICE_COUNT"
    one = invoice_xml().split(b"?>", 1)[1]
    assert _failed(b"<TDiep>" + one + one + b"</TDiep>") == "INVOICE_COUNT"


def test_buyer_classification_is_accent_insensitive() -> None:
    assert classify_buyer("CÔNG TY TNHH Giả Lập") == "COMPANY"
    assert classify_buyer("Công ty Cổ phần Mẫu") == "COMPANY"
    assert classify_buyer("cong  ty  co  phan mau") == "COMPANY"
    assert classify_buyer(BUYER_NAME_MARKER) == "PERSONAL"
    assert classify_buyer("") == "UNKNOWN"
    assert _parsed(invoice_xml(buyer_name="Công ty TNHH Giả Lập")).buyer_address_type == "COMPANY"


def test_buyer_pii_is_never_kept_in_result() -> None:
    result = extract_from_xml(invoice_xml())
    rendered = json.dumps(result.to_dict(), ensure_ascii=False) + repr(result)
    for marker in ("SYNTH-PII", BUYER_ID_MARKER, "0900000000", "Nguyễn Văn", BUYER_ADDRESS_MARKER):
        assert marker not in rendered


def test_failure_codes_never_echo_document_content() -> None:
    result = extract_from_xml(invoice_xml(seller_mst="SYNTH-PII-SELLER"))
    assert result.error_code == "SELLER_TAX_CODE_INVALID"
    assert "SYNTH-PII" not in json.dumps(result.to_dict())
