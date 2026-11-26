"""FastAPI application for the AI worker.

Not exposed publicly. Service identity (mTLS/HMAC) for internal callers is not
implemented in AI-01 and must exist before any deployment.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from tpa_ai_worker import SERVICE_NAME, __version__
from tpa_ai_worker.config import Limits, load_limits
from tpa_ai_worker.models import ErrorBody, ErrorResponse, HealthResponse, PreprocessRequest, PreprocessResult
from tpa_ai_worker.preprocess import Rejection, RejectionCode, preprocess

logger = logging.getLogger("tpa_ai_worker")

NO_STORE = {"Cache-Control": "no-store"}

_STATUS = {
    RejectionCode.PAYLOAD_TOO_LARGE: 413,
    RejectionCode.IMAGE_DIMENSIONS_EXCEEDED: 413,
    RejectionCode.UNSUPPORTED_MEDIA_TYPE: 415,
    RejectionCode.CONTENT_TYPE_MISMATCH: 415,
}


def _error(status: int, code: str, message: str) -> JSONResponse:
    body = ErrorResponse(error=ErrorBody(code=code, message=message))
    return JSONResponse(status_code=status, content=body.model_dump(), headers=NO_STORE)


async def _read_capped(request: Request, max_bytes: int) -> bytes:
    """Read the body, refusing to buffer more than ``max_bytes`` (+1 to detect overflow)."""
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > max_bytes:
        raise Rejection(RejectionCode.PAYLOAD_TOO_LARGE, f"body exceeds {max_bytes} bytes")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise Rejection(RejectionCode.PAYLOAD_TOO_LARGE, f"body exceeds {max_bytes} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


def create_app(limits: Limits | None = None) -> FastAPI:
    active = limits if limits is not None else load_limits()
    app = FastAPI(title="TPA AI Worker", version=__version__, docs_url=None, redoc_url=None)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Report only field locations; never echo submitted values.
        fields = sorted({".".join(str(p) for p in err.get("loc", ())) for err in exc.errors()})
        return _error(422, "INVALID_REQUEST", "invalid fields: " + ", ".join(fields))

    @app.exception_handler(Rejection)
    async def _rejection(_: Request, exc: Rejection) -> JSONResponse:
        logger.info("preprocess rejected code=%s", exc.code.value)
        return _error(_STATUS.get(exc.code, 422), exc.code.value, exc.message)

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(status="ok", service=SERVICE_NAME, version=__version__)

    @app.post(
        "/internal/v1/images/preprocess",
        response_model=PreprocessResult,
        responses={413: {"model": ErrorResponse}, 415: {"model": ErrorResponse}, 422: {"model": ErrorResponse}},
        openapi_extra={
            "requestBody": {
                "required": True,
                "content": {t: {"schema": {"type": "string", "format": "binary"}} for t in ("image/jpeg", "image/png", "image/webp")},
            }
        },
    )
    async def preprocess_image(
        request: Request, params: Annotated[PreprocessRequest, Query()]
    ) -> JSONResponse:
        data = await _read_capped(request, active.max_bytes)
        result = await run_in_threadpool(preprocess, params, data, active)
        logger.info("preprocess done gate=%s derived=%d", result.quality.gate.value, len(result.derived))
        return JSONResponse(content=result.model_dump(mode="json", by_alias=True), headers=NO_STORE)

    return app


app = create_app()
