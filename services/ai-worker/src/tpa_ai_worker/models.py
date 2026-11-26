"""Typed request/response models for the AI worker.

Deliberately minimal: no tenant selector, no member data, no file name (file
names can contain personal names), no money and no decision fields. Scores are
decimal strings, never floats, so values round-trip into NUMERIC columns.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from tpa_ai_worker.config import TECHNICAL_MAX_BYTES

Sha256Hex = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
DecimalString = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]{0,5})\.[0-9]{2}$")]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class DocumentType(StrEnum):
    """Mirror of components.schemas.DocumentType in 02-openapi-contracts.yaml."""

    INVOICE_PHOTO = "INVOICE_PHOTO"
    ITEMIZED_LIST = "ITEMIZED_LIST"
    PRESCRIPTION = "PRESCRIPTION"
    LAB_ORDER = "LAB_ORDER"
    LAB_RESULT = "LAB_RESULT"
    DISCHARGE_PAPER = "DISCHARGE_PAPER"
    VNEID_HISTORY = "VNEID_HISTORY"


class PreprocessRequest(_Strict):
    """Metadata accompanying the raw image bytes (sent as the request body).

    The declared values come from the trusted upload record; the worker
    re-verifies every one of them against the actual bytes.
    """

    document_id: UUID = Field(alias="documentId")
    doc_type: DocumentType = Field(alias="docType")
    declared_content_type: str = Field(
        alias="declaredContentType", min_length=3, max_length=100, pattern=r"^[a-z]+/[a-z0-9.+-]+$"
    )
    declared_sha256: Sha256Hex = Field(alias="declaredSha256")
    declared_size_bytes: int = Field(alias="declaredSizeBytes", ge=1, le=TECHNICAL_MAX_BYTES)

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class ArtifactRole(StrEnum):
    ORIGINAL = "ORIGINAL"
    DERIVED = "DERIVED"


class Transform(_Strict):
    name: Literal["red_stamp_suppression"]
    version: str
    parameters: dict[str, int | str]


class ArtifactProvenance(_Strict):
    role: ArtifactRole
    sha256: Sha256Hex
    size_bytes: int = Field(serialization_alias="sizeBytes")
    content_type: str = Field(serialization_alias="contentType")
    width_px: int = Field(serialization_alias="widthPx")
    height_px: int = Field(serialization_alias="heightPx")
    derived_from_sha256: Sha256Hex | None = Field(serialization_alias="derivedFromSha256")
    transform: Transform | None


class OriginalIntegrity(_Strict):
    declared_sha256: Sha256Hex = Field(serialization_alias="declaredSha256")
    sha256_before: Sha256Hex = Field(serialization_alias="sha256Before")
    sha256_after: Sha256Hex = Field(serialization_alias="sha256After")
    unchanged: bool


class QualityGate(StrEnum):
    PASSED = "PASSED"
    FAILED_BLUR = "FAILED_BLUR"


class QualityWarning(_Strict):
    code: Literal["BLURRY_IMAGE"]
    message_vi: str = Field(serialization_alias="messageVi")
    rule_version: str = Field(serialization_alias="ruleVersion")


class QualityResult(_Strict):
    gate: QualityGate
    blur_score: DecimalString = Field(serialization_alias="blurScore")
    blur_threshold: DecimalString = Field(serialization_alias="blurThreshold")
    rule_version: str = Field(serialization_alias="ruleVersion")
    warnings: tuple[QualityWarning, ...]


class DerivedArtifact(_Strict):
    provenance: ArtifactProvenance
    content_base64: str = Field(serialization_alias="contentBase64")


class ProcessingProvenance(_Strict):
    worker: str
    worker_version: str = Field(serialization_alias="workerVersion")
    opencv_version: str = Field(serialization_alias="opencvVersion")
    numpy_version: str = Field(serialization_alias="numpyVersion")
    # Constant markers stating what this output is NOT allowed to be used for.
    proposal_only: Literal[True] = Field(default=True, serialization_alias="proposalOnly")
    decision_authority: Literal["NONE"] = Field(default="NONE", serialization_alias="decisionAuthority")


class PreprocessResult(_Strict):
    document_id: UUID = Field(serialization_alias="documentId")
    doc_type: DocumentType = Field(serialization_alias="docType")
    original: ArtifactProvenance
    integrity: OriginalIntegrity
    quality: QualityResult
    derived: tuple[DerivedArtifact, ...]
    provenance: ProcessingProvenance


class HealthResponse(_Strict):
    status: Literal["ok"]
    service: str
    version: str


class ErrorBody(_Strict):
    code: str
    message: str


class ErrorResponse(_Strict):
    error: ErrorBody
