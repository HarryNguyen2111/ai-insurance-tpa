"""QR / XML -> invoice extraction pipeline.

Outcomes keep three things apart: whether a document was *available*
(``UNAVAILABLE`` when no QR, fetch refused/failed), whether it *parsed*
(``PARSED`` / ``FAILED``), and tax *verification*, which is always
``UNVERIFIED`` here. Nothing in this pipeline can produce ``VERIFIED_VALID``.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

import numpy as np
import numpy.typing as npt

from tpa_ai_worker.invoice.fetch import FetchedDocument, FetchError, fetch_invoice_xml
from tpa_ai_worker.invoice.limits import FetchPolicy, XmlLimits
from tpa_ai_worker.invoice.models import InvoiceExtraction, ParseStatus, TaxVerification
from tpa_ai_worker.invoice.qr import QrUnavailable, decode_qr_payloads
from tpa_ai_worker.invoice.xmlparse import XmlParseError, extract_invoice, parse_secure_xml

Fetcher = Callable[[str, FetchPolicy], FetchedDocument]
Clock = Callable[[], datetime]

SOURCE_XML_DOCUMENT = "XML_DOCUMENT"
SOURCE_QR_FETCH = "QR_XML_FETCH"
SOURCE_QR_IMAGE = "QR_IMAGE"


def _now() -> datetime:
    return datetime.now(UTC)


def _outcome(status: ParseStatus, source: str, clock: Clock, code: str) -> InvoiceExtraction:
    return InvoiceExtraction(
        tax_verification=TaxVerification(parse_status=status, source=source, checked_at=clock()),
        error_code=code,
    )


def extract_from_xml(
    data: bytes,
    *,
    source: str = SOURCE_XML_DOCUMENT,
    limits: XmlLimits | None = None,
    clock: Clock = _now,
) -> InvoiceExtraction:
    limits = limits or XmlLimits()
    try:
        invoice = extract_invoice(parse_secure_xml(data, limits), limits)
    except XmlParseError as exc:
        return _outcome("FAILED", source, clock, exc.code)
    return InvoiceExtraction(
        tax_verification=TaxVerification(parse_status="PARSED", source=source, checked_at=clock()),
        invoice=invoice,
    )


def extract_from_qr_payload(
    payload: str,
    policy: FetchPolicy,
    *,
    fetcher: Fetcher = fetch_invoice_xml,
    limits: XmlLimits | None = None,
    clock: Clock = _now,
) -> InvoiceExtraction:
    if not payload.lower().startswith(("https://", "http://")):
        return _outcome("UNAVAILABLE", SOURCE_QR_FETCH, clock, "QR_NOT_URL")
    try:
        document = fetcher(payload, policy)
    except FetchError as exc:
        return _outcome("UNAVAILABLE", SOURCE_QR_FETCH, clock, exc.code)
    return extract_from_xml(
        document.content, source=f"{SOURCE_QR_FETCH}:{document.source}", limits=limits, clock=clock
    )


def extract_from_invoice_image(
    image: npt.NDArray[np.uint8],
    policy: FetchPolicy,
    *,
    fetcher: Fetcher = fetch_invoice_xml,
    limits: XmlLimits | None = None,
    clock: Clock = _now,
) -> InvoiceExtraction:
    try:
        payloads = decode_qr_payloads(image)
    except QrUnavailable as exc:
        return _outcome("UNAVAILABLE", SOURCE_QR_IMAGE, clock, str(exc))
    if not payloads:
        return _outcome("UNAVAILABLE", SOURCE_QR_IMAGE, clock, "QR_NOT_FOUND")
    if len(payloads) > 1:
        return _outcome("UNAVAILABLE", SOURCE_QR_IMAGE, clock, "QR_AMBIGUOUS")
    return extract_from_qr_payload(payloads[0], policy, fetcher=fetcher, limits=limits, clock=clock)
