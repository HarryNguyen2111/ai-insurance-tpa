"""Invoice extraction results.

Parsing and tax verification are deliberately separate (docs/ai-specs/03 §6,
07, OpenAPI ``TaxVerification``): a QR/XML document that parses cleanly is
still only a *proposal*. Verified outcomes (``VERIFIED_VALID``, ``CANCELLED``,
``NOT_FOUND``) require independently authenticated tax-authority evidence,
which is blocked pending the provider decision. This worker therefore can
only ever emit ``UNVERIFIED``; the type and a runtime guard both enforce it.

Money is ``Decimal`` internally and a 2-dp string at the JSON boundary; there
are no floats anywhere in this module. No buyer name, address or identity is
kept.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal, get_args

ParseStatus = Literal["PARSED", "FAILED", "UNAVAILABLE"]
# The only verification status this worker may assign. Do not widen.
WorkerVerificationStatus = Literal["UNVERIFIED"]
BuyerAddressType = Literal["PERSONAL", "COMPANY", "UNKNOWN"]

_ALLOWED_VERIFICATION = frozenset(get_args(WorkerVerificationStatus))
_ALLOWED_PARSE = frozenset(get_args(ParseStatus))
_CENT = Decimal("0.01")

EXTRACTION_RULE_VERSION = "invoice-xml-tt78-v1"
MERGED_SUMMARY_RULE_VERSION = "merged-summary-single-goods-line-v1"


def money_str(value: Decimal) -> str:
    """Format VND as the contract ``Money`` string (2 dp, ROUND_HALF_UP)."""
    return f"{value.quantize(_CENT, rounding=ROUND_HALF_UP):f}"


@dataclass(frozen=True, slots=True)
class InvoiceLine:
    line_no: int
    nature: str  # TChat: 1 goods/service, 2 promotion, 3 discount, 4 note
    item_name: str
    quantity: Decimal | None
    unit_price: Decimal | None
    amount: Decimal

    @property
    def is_goods(self) -> bool:
        return self.nature == "1"

    def to_dict(self) -> dict[str, object]:
        return {
            "lineNo": self.line_no,
            "nature": self.nature,
            "itemName": self.item_name,
            "quantity": None if self.quantity is None else money_str(self.quantity),
            "unitPrice": None if self.unit_price is None else money_str(self.unit_price),
            "amount": money_str(self.amount),
        }


@dataclass(frozen=True, slots=True)
class ExtractedInvoice:
    seller_tax_code: str
    template_code: str | None  # KHMSHDon
    invoice_serial: str  # KHHDon
    invoice_number: str  # SHDon
    invoice_date: date
    buyer_address_type: BuyerAddressType
    total_amount: Decimal  # TgTTTBSo, total payable
    total_before_tax: Decimal | None
    tax_amount: Decimal | None
    lines: tuple[InvoiceLine, ...]
    is_merged_summary: bool
    # Presence of an MCCQT element. Informational only: an unauthenticated
    # document can claim any code, so this is NEVER treated as verification.
    tax_authority_code_present: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "sellerTaxCode": self.seller_tax_code,
            "templateCode": self.template_code,
            "invoiceSerial": self.invoice_serial,
            "invoiceNumber": self.invoice_number,
            "invoiceDate": self.invoice_date.isoformat(),
            "buyerAddressType": self.buyer_address_type,
            "totalAmount": money_str(self.total_amount),
            "totalBeforeTax": None if self.total_before_tax is None else money_str(self.total_before_tax),
            "taxAmount": None if self.tax_amount is None else money_str(self.tax_amount),
            "isMergedSummary": self.is_merged_summary,
            "mergedSummaryRuleVersion": MERGED_SUMMARY_RULE_VERSION,
            "taxAuthorityCodePresent": self.tax_authority_code_present,
            "lines": [line.to_dict() for line in self.lines],
        }


@dataclass(frozen=True, slots=True)
class TaxVerification:
    parse_status: ParseStatus
    source: str
    checked_at: datetime
    verification_status: WorkerVerificationStatus = "UNVERIFIED"

    def __post_init__(self) -> None:
        # Runtime guard in addition to the type: nothing derived from a parsed
        # QR/XML may self-label as verified, cancelled or not-found.
        if self.verification_status not in _ALLOWED_VERIFICATION:
            raise ValueError("worker may not assign a tax verification outcome")
        if self.parse_status not in _ALLOWED_PARSE:
            raise ValueError("unknown parse status")
        if not 1 <= len(self.source) <= 500:
            raise ValueError("source must be 1..500 characters")
        if self.checked_at.tzinfo is None:
            raise ValueError("checked_at must be timezone-aware")

    def to_dict(self) -> dict[str, object]:
        return {
            "parseStatus": self.parse_status,
            "verificationStatus": self.verification_status,
            "source": self.source,
            "checkedAt": self.checked_at.isoformat(),
        }


@dataclass(frozen=True, slots=True)
class InvoiceExtraction:
    tax_verification: TaxVerification
    invoice: ExtractedInvoice | None = None
    error_code: str | None = None  # stable reason; never contains content
    rule_version: str = field(default=EXTRACTION_RULE_VERSION)

    def __post_init__(self) -> None:
        parsed = self.tax_verification.parse_status == "PARSED"
        if parsed != (self.invoice is not None):
            raise ValueError("invoice must be present exactly when parse status is PARSED")

    def to_dict(self) -> dict[str, object]:
        return {
            "ruleVersion": self.rule_version,
            "taxVerification": self.tax_verification.to_dict(),
            "invoice": None if self.invoice is None else self.invoice.to_dict(),
            "errorCode": self.error_code,
            "proposalOnly": True,
            "decisionAuthority": "NONE",
        }
