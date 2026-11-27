"""AI-02 (issue #29): QR/XML invoice extraction with SSRF/XXE protection.

Proposal only: parsed data is never tax-verified by this package.
"""

from tpa_ai_worker.invoice.fetch import FetchedDocument, FetchError, fetch_invoice_xml
from tpa_ai_worker.invoice.limits import FetchLimits, FetchPolicy, XmlLimits, load_fetch_policy
from tpa_ai_worker.invoice.models import ExtractedInvoice, InvoiceExtraction, InvoiceLine, TaxVerification
from tpa_ai_worker.invoice.pipeline import extract_from_invoice_image, extract_from_qr_payload, extract_from_xml
from tpa_ai_worker.invoice.xmlparse import XmlParseError, parse_secure_xml

__all__ = [
    "ExtractedInvoice",
    "FetchError",
    "FetchLimits",
    "FetchPolicy",
    "FetchedDocument",
    "InvoiceExtraction",
    "InvoiceLine",
    "TaxVerification",
    "XmlLimits",
    "XmlParseError",
    "extract_from_invoice_image",
    "extract_from_qr_payload",
    "extract_from_xml",
    "fetch_invoice_xml",
    "load_fetch_policy",
    "parse_secure_xml",
]
