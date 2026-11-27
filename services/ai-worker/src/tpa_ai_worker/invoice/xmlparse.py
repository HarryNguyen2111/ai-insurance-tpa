"""Hardened XML parsing and e-invoice extraction (TT78/2021 GDT layout).

Parser hardening (XXE / billion laughs / network):

* any ``<!DOCTYPE`` or ``<!ENTITY`` is refused before parsing, and again
  after parsing via ``docinfo`` (covers UTF-16 and other encodings that a
  byte scan cannot see) and by rejecting any entity-reference node;
* lxml runs with ``resolve_entities=False``, ``load_dtd=False``,
  ``no_network=True``, ``huge_tree=False``; XInclude is never processed;
* size, element count and depth are capped.

Extraction is namespace-agnostic (local names) and fail-closed: a missing or
malformed required field makes the whole parse ``FAILED`` with a stable code
that never echoes document content. Buyer name is read only to classify the
buyer as PERSONAL/COMPANY and is never stored.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from lxml import etree

from tpa_ai_worker.invoice.limits import XmlLimits
from tpa_ai_worker.invoice.models import BuyerAddressType, ExtractedInvoice, InvoiceLine

_DTD_MARKERS = (b"<!DOCTYPE", b"<!ENTITY")
_MONEY_RE = re.compile(r"^[0-9]{1,13}(?:\.[0-9]{1,6})?$")
_QUANTITY_RE = re.compile(r"^[0-9]{1,8}(?:\.[0-9]{1,6})?$")
_TAX_CODE_RE = re.compile(r"^[0-9-]{10,14}$")
_IDENT_RE = re.compile(r"^[0-9A-Za-z/-]{1,30}$")
_DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
_NATURE_RE = re.compile(r"^[1-4]$")
_CENT = Decimal("0.01")
_MONEY_MAX = Decimal("9999999999999.99")  # NUMERIC(15,2)
_ITEM_NAME_MAX = 255
# docs/ai-specs/03 §4.3: company markers in buyer name (accent-folded).
_COMPANY_MARKERS = ("CONG TY", "TNHH", "CO PHAN")


class XmlParseError(ValueError):
    """XML refused or not a usable invoice. ``code`` is safe to log."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _parser() -> etree.XMLParser:
    return etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        load_dtd=False,
        dtd_validation=False,
        attribute_defaults=False,
        huge_tree=False,
        remove_comments=True,
        remove_pis=True,
        collect_ids=False,
    )


def parse_secure_xml(data: bytes, limits: XmlLimits) -> etree._Element:
    if len(data) > limits.max_bytes:
        raise XmlParseError("XML_TOO_LARGE")
    if any(marker in data for marker in _DTD_MARKERS):
        raise XmlParseError("XML_DTD_FORBIDDEN")
    try:
        root = etree.fromstring(data, _parser())
    except (etree.XMLSyntaxError, ValueError) as exc:
        raise XmlParseError("XML_MALFORMED") from exc
    docinfo = root.getroottree().docinfo
    if docinfo.internalDTD is not None or docinfo.externalDTD is not None or docinfo.doctype:
        raise XmlParseError("XML_DTD_FORBIDDEN")
    _check_structure(root, limits)
    return root


def _check_structure(root: etree._Element, limits: XmlLimits) -> None:
    count = 0
    depth = 0
    for event, node in etree.iterwalk(root, events=("start", "end")):
        if event == "end":
            depth -= 1
            continue
        depth += 1
        count += 1
        if depth > limits.max_depth:
            raise XmlParseError("XML_TOO_DEEP")
        if count > limits.max_elements:
            raise XmlParseError("XML_TOO_MANY_ELEMENTS")
        for child in node:
            tag: object = child.tag  # stubs type this as str; entity nodes use a factory
            if tag is etree.Entity:  # unexpanded entity reference node
                raise XmlParseError("XML_DTD_FORBIDDEN")


def _local(el: etree._Element) -> str:
    tag: object = el.tag  # comments/entities carry a non-str tag at runtime
    if not isinstance(tag, str):
        return ""
    return etree.QName(tag).localname


def _child(el: etree._Element | None, name: str) -> etree._Element | None:
    if el is None:
        return None
    for c in el:
        if _local(c) == name:
            return c
    return None


def _path(el: etree._Element | None, *names: str) -> etree._Element | None:
    for name in names:
        el = _child(el, name)
    return el


def _text(el: etree._Element | None) -> str:
    if el is None or el.text is None:
        return ""
    return el.text.strip()


def _required(value: str, pattern: re.Pattern[str], code: str) -> str:
    if not pattern.match(value):
        raise XmlParseError(code)
    return value


def parse_money(raw: str, code: str) -> Decimal:
    """Decimal from a plain non-negative decimal literal; never via float.

    Exponents, signs, thousands separators, NaN/Infinity are refused.
    """
    if not _MONEY_RE.match(raw):
        raise XmlParseError(code)
    try:
        value = Decimal(raw).quantize(_CENT, rounding=ROUND_HALF_UP)
    except InvalidOperation as exc:  # pragma: no cover - regex already guards
        raise XmlParseError(code) from exc
    if value > _MONEY_MAX:
        raise XmlParseError(code)
    return value


def _optional_money(raw: str, code: str) -> Decimal | None:
    return None if raw == "" else parse_money(raw, code)


def _optional_quantity(raw: str) -> Decimal | None:
    if raw == "":
        return None
    if not _QUANTITY_RE.match(raw):
        raise XmlParseError("LINE_QUANTITY_INVALID")
    return Decimal(raw).quantize(_CENT, rounding=ROUND_HALF_UP)


def _fold(text: str) -> str:
    text = text.replace("đ", "d").replace("Đ", "D")
    decomposed = unicodedata.normalize("NFKD", text)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return " ".join(stripped.upper().split())


def classify_buyer(name: str) -> BuyerAddressType:
    if not name:
        return "UNKNOWN"
    folded = _fold(name)
    if any(marker in folded for marker in _COMPANY_MARKERS):
        return "COMPANY"
    return "PERSONAL"


def _find_invoice(root: etree._Element) -> etree._Element:
    candidates = [el for el in root.iter() if _local(el) == "HDon"]
    if len(candidates) != 1:
        raise XmlParseError("INVOICE_COUNT")
    return candidates[0]


def _line(el: etree._Element, index: int) -> InvoiceLine:
    nature = _text(_child(el, "TChat")) or "1"
    if not _NATURE_RE.match(nature):
        raise XmlParseError("LINE_NATURE_INVALID")
    name = " ".join(_text(_child(el, "THHDVu")).split())
    if not name:
        raise XmlParseError("LINE_NAME_MISSING")
    stt = _text(_child(el, "STT"))
    line_no = int(stt) if stt.isdigit() and len(stt) <= 6 else index
    return InvoiceLine(
        line_no=line_no,
        nature=nature,
        item_name=name[:_ITEM_NAME_MAX],
        quantity=_optional_quantity(_text(_child(el, "SLuong"))),
        unit_price=_optional_money(_text(_child(el, "DGia")), "LINE_UNIT_PRICE_INVALID"),
        amount=parse_money(_text(_child(el, "ThTien")), "LINE_AMOUNT_INVALID"),
    )


def extract_invoice(root: etree._Element, limits: XmlLimits) -> ExtractedInvoice:
    hdon = _find_invoice(root)
    dl = _child(hdon, "DLHDon")
    if dl is None:
        raise XmlParseError("INVOICE_DATA_MISSING")
    general = _child(dl, "TTChung")
    content = _child(dl, "NDHDon")
    if general is None or content is None:
        raise XmlParseError("INVOICE_DATA_MISSING")

    template = _text(_child(general, "KHMSHDon"))
    if template and not _IDENT_RE.match(template):
        raise XmlParseError("TEMPLATE_CODE_INVALID")
    serial = _required(_text(_child(general, "KHHDon")), _IDENT_RE, "INVOICE_SERIAL_INVALID")
    number = _required(_text(_child(general, "SHDon")), _IDENT_RE, "INVOICE_NUMBER_INVALID")
    raw_date = _required(_text(_child(general, "NLap")), _DATE_RE, "INVOICE_DATE_INVALID")
    try:
        invoice_date = date.fromisoformat(raw_date)
    except ValueError as exc:
        raise XmlParseError("INVOICE_DATE_INVALID") from exc

    seller_tax_code = _required(_text(_path(content, "NBan", "MST")), _TAX_CODE_RE, "SELLER_TAX_CODE_INVALID")
    buyer_type = classify_buyer(_text(_path(content, "NMua", "Ten")))

    item_list = _child(content, "DSHHDVu")
    items = [] if item_list is None else [el for el in item_list if _local(el) == "HHDVu"]
    if len(items) > limits.max_lines:
        raise XmlParseError("LINES_TOO_MANY")
    lines = tuple(_line(el, i) for i, el in enumerate(items, start=1))

    totals = _child(content, "TToan")
    total = parse_money(_text(_child(totals, "TgTTTBSo")), "TOTAL_AMOUNT_INVALID")

    goods = sum(1 for line in lines if line.is_goods)
    return ExtractedInvoice(
        seller_tax_code=seller_tax_code,
        template_code=template or None,
        invoice_serial=serial,
        invoice_number=number,
        invoice_date=invoice_date,
        buyer_address_type=buyer_type,
        total_amount=total,
        total_before_tax=_optional_money(_text(_child(totals, "TgTCThue")), "TOTAL_BEFORE_TAX_INVALID"),
        tax_amount=_optional_money(_text(_child(totals, "TgTThue")), "TAX_AMOUNT_INVALID"),
        lines=lines,
        # Public-hospital "merged" XML carries one summary line (or none): the
        # itemized list must then be reconciled by OCR/review (03 §3.5, TC05).
        is_merged_summary=goods <= 1,
        tax_authority_code_present=bool(_text(_child(hdon, "MCCQT"))),
    )
