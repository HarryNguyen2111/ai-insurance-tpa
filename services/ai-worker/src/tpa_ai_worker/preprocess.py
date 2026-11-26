"""Immutable preprocessing pipeline: verify -> quality gate -> derived artifacts.

The original bytes are never modified or replaced. Their SHA-256 is computed
before and after processing and must be identical; every transformed image is a
separate DERIVED artifact whose provenance points back at the original hash.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from enum import StrEnum

import cv2
import numpy as np
import numpy.typing as npt

from tpa_ai_worker import SERVICE_NAME, __version__
from tpa_ai_worker import redstamp
from tpa_ai_worker.config import BLUR_THRESHOLD, QUALITY_RULE_VERSION, Limits
from tpa_ai_worker.models import (
    ArtifactProvenance,
    ArtifactRole,
    DerivedArtifact,
    OriginalIntegrity,
    PreprocessRequest,
    PreprocessResult,
    ProcessingProvenance,
    QualityGate,
    QualityResult,
    QualityWarning,
    Transform,
)
from tpa_ai_worker.quality import format_score, is_blurry, laplacian_variance
from tpa_ai_worker.sniff import (
    PNG,
    SUPPORTED_IMAGE_TYPES,
    HeaderError,
    read_dimensions,
    sniff_content_type,
)

BLURRY_MESSAGE_VI = "Ảnh bị mờ, vui lòng chụp lại rõ nét hơn."


class RejectionCode(StrEnum):
    EMPTY_BODY = "EMPTY_BODY"
    PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE"
    SIZE_MISMATCH = "SIZE_MISMATCH"
    CHECKSUM_MISMATCH = "CHECKSUM_MISMATCH"
    UNSUPPORTED_MEDIA_TYPE = "UNSUPPORTED_MEDIA_TYPE"
    CONTENT_TYPE_MISMATCH = "CONTENT_TYPE_MISMATCH"
    IMAGE_DIMENSIONS_EXCEEDED = "IMAGE_DIMENSIONS_EXCEEDED"
    IMAGE_TOO_SMALL = "IMAGE_TOO_SMALL"
    UNDECODABLE_IMAGE = "UNDECODABLE_IMAGE"
    ORIGINAL_MUTATED = "ORIGINAL_MUTATED"


class Rejection(Exception):
    """A request the worker refuses to process. Messages never echo content."""

    def __init__(self, code: RejectionCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _decode(data: bytes) -> npt.NDArray[np.uint8]:
    buffer = np.frombuffer(data, dtype=np.uint8)  # read-only view over immutable bytes
    try:
        image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    except cv2.error as exc:  # e.g. OPENCV_IO_MAX_IMAGE_PIXELS exceeded
        raise Rejection(RejectionCode.UNDECODABLE_IMAGE, "image could not be decoded") from exc
    if image is None or image.ndim != 3 or image.shape[2] != 3:
        raise Rejection(RejectionCode.UNDECODABLE_IMAGE, "image could not be decoded")
    return np.asarray(image, dtype=np.uint8)


def _encode_png(image: npt.NDArray[np.uint8]) -> bytes:
    ok, encoded = cv2.imencode(".png", image)
    if not ok:  # pragma: no cover - OpenCV PNG encoder failure is not reproducible
        raise RuntimeError("PNG encoding failed")
    return bytes(encoded.tobytes())


def validate(request: PreprocessRequest, data: bytes, limits: Limits) -> str:
    """Check size, type and checksum against the actual bytes. Returns the sniffed type."""
    if not data:
        raise Rejection(RejectionCode.EMPTY_BODY, "request body is empty")
    if len(data) > limits.max_bytes:
        raise Rejection(RejectionCode.PAYLOAD_TOO_LARGE, f"body exceeds {limits.max_bytes} bytes")
    if len(data) != request.declared_size_bytes:
        raise Rejection(RejectionCode.SIZE_MISMATCH, "actual size differs from declared size")

    declared = request.declared_content_type
    if declared not in SUPPORTED_IMAGE_TYPES:
        raise Rejection(
            RejectionCode.UNSUPPORTED_MEDIA_TYPE,
            "supported types: image/jpeg, image/png, image/webp (convert HEIC/HEIF to a derived WebP first)",
        )
    sniffed = sniff_content_type(data)
    if sniffed != declared:
        raise Rejection(RejectionCode.CONTENT_TYPE_MISMATCH, "declared type does not match file content")

    if not hmac.compare_digest(sha256_hex(data), request.declared_sha256):
        raise Rejection(RejectionCode.CHECKSUM_MISMATCH, "SHA-256 differs from declared checksum")
    return sniffed


def preprocess(request: PreprocessRequest, data: bytes, limits: Limits) -> PreprocessResult:
    content_type = validate(request, data, limits)
    sha_before = sha256_hex(data)

    try:
        dims = read_dimensions(data, content_type)
    except HeaderError as exc:
        raise Rejection(RejectionCode.UNDECODABLE_IMAGE, "image header is malformed") from exc
    if dims.pixels > limits.max_pixels:
        raise Rejection(
            RejectionCode.IMAGE_DIMENSIONS_EXCEEDED, f"image exceeds {limits.max_pixels} pixels"
        )
    if min(dims.width, dims.height) < limits.min_side_px:
        raise Rejection(RejectionCode.IMAGE_TOO_SMALL, f"image side below {limits.min_side_px} px")

    bgr = _decode(data)
    height, width = bgr.shape[:2]
    if (width, height) != (dims.width, dims.height):
        raise Rejection(RejectionCode.UNDECODABLE_IMAGE, "decoded size differs from header")

    original = ArtifactProvenance(
        role=ArtifactRole.ORIGINAL,
        sha256=sha_before,
        size_bytes=len(data),
        content_type=content_type,
        width_px=width,
        height_px=height,
        derived_from_sha256=None,
        transform=None,
    )

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    score = laplacian_variance(np.asarray(gray, dtype=np.uint8))
    blurry = is_blurry(score)
    quality = QualityResult(
        gate=QualityGate.FAILED_BLUR if blurry else QualityGate.PASSED,
        blur_score=format_score(score),
        blur_threshold=format_score(BLUR_THRESHOLD),
        rule_version=QUALITY_RULE_VERSION,
        warnings=(
            (QualityWarning(code="BLURRY_IMAGE", message_vi=BLURRY_MESSAGE_VI, rule_version=QUALITY_RULE_VERSION),)
            if blurry
            else ()
        ),
    )

    derived: tuple[DerivedArtifact, ...] = ()
    if not blurry:  # blurry images are rejected before any OCR-oriented derivation
        suppressed = redstamp.suppress_red_stamp(bgr)
        png = _encode_png(suppressed.image)
        derived = (
            DerivedArtifact(
                provenance=ArtifactProvenance(
                    role=ArtifactRole.DERIVED,
                    sha256=sha256_hex(png),
                    size_bytes=len(png),
                    content_type=PNG,
                    width_px=width,
                    height_px=height,
                    derived_from_sha256=sha_before,
                    transform=Transform(
                        name=redstamp.TRANSFORM_NAME,
                        version=redstamp.TRANSFORM_VERSION,
                        parameters=redstamp.parameters(),
                    ),
                ),
                content_base64=base64.b64encode(png).decode("ascii"),
            ),
        )

    sha_after = sha256_hex(data)
    if sha_after != sha_before:  # pragma: no cover - bytes are immutable; defensive invariant
        raise Rejection(RejectionCode.ORIGINAL_MUTATED, "original bytes changed during processing")

    return PreprocessResult(
        document_id=request.document_id,
        doc_type=request.doc_type,
        original=original,
        integrity=OriginalIntegrity(
            declared_sha256=request.declared_sha256,
            sha256_before=sha_before,
            sha256_after=sha_after,
            unchanged=True,
        ),
        quality=quality,
        derived=derived,
        provenance=ProcessingProvenance(
            worker=SERVICE_NAME,
            worker_version=__version__,
            opencv_version=cv2.__version__,
            numpy_version=np.__version__,
        ),
    )
