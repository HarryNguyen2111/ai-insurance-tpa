# tpa-ai-worker (AI-01)

Python FastAPI worker for image quality checks and immutable preprocessing. It
**proposes technical evidence only**: it never approves a claim, never writes
money, makes **no network calls**, and does not log content or personal data.

## What it does

- `GET /health`: liveness.
- `POST /internal/v1/images/preprocess`: the raw image bytes go in the body,
  and the typed metadata (`documentId`, `docType`, `declaredContentType`,
  `declaredSha256`, `declaredSizeBytes`) goes in query parameters. The worker
  re-verifies every declared value:
  - **Limits:** body ≤ 20 MiB (the `UploadRequest.sizeBytes` technical maximum;
    `AI_WORKER_MAX_BYTES` may only tighten it), streamed with a hard cap. Header
    dimensions ≤ 40 MP, checked **before decoding** (decompression-bomb guard;
    `AI_WORKER_MAX_PIXELS` may only tighten it), and OpenCV's
    `OPENCV_IO_MAX_IMAGE_PIXELS` adds a second cap. Smallest side ≥ 32 px.
  - **Type:** JPEG, PNG and WebP are accepted, sniffed from magic bytes, and
    the declared type must match. HEIC/HEIF, PDF, XML and anything else return
    `415`. HEIC must be converted to a derived WebP (Imgproxy) first.
  - **Checksum:** the SHA-256 must equal the declared value. The original's
    hash is recomputed after processing and returned as `integrity`.
  - **Blur gate:** variance of the Laplacian on grayscale; `< 65.00` gives
    `FAILED_BLUR` plus a `BLURRY_IMAGE` warning (docs/ai-specs/03 §4.1). The
    score is a 2-dp decimal string clamped to `NUMERIC(8,2)`.
  - **Red-stamp suppression** (only when the gate passes) produces a **DERIVED**
    grayscale PNG. Provenance records `role`, `sha256`, `derivedFromSha256` (the
    original's hash), and the transform name, version and parameters. The
    original is never modified or replaced.
  - Every response carries `proposalOnly: true` and `decisionAuthority: "NONE"`.

## Not in scope (honest limits)

- No Viettel AI / VLM / model call and no OCR or field extraction (#30).
- No QR decoding or XML fetch/parse behaviour (#29). pyzbar and lxml are only
  bootstrapped and smoke-tested.
- No S3/MinIO access: storing the derived artifact is the caller's job. Derived
  bytes are returned base64-encoded.
- No service identity (mTLS/HMAC) yet, so the endpoint must not be deployed or
  exposed. No Dockerfile or Helm chart.
- The blur threshold is the spec's starting value and depends on resolution. It
  needs calibration on permitted real documents.
- Run uvicorn with `--no-access-log`. The query string carries only opaque IDs
  and hashes, but access logs aren't needed.

## Develop

Requires Python 3.12+ and [uv](https://docs.astral.sh/uv/) 0.13.x. pyzbar needs
the system `libzbar0` library (`apt-get install libzbar0`). Without it, the
pyzbar smoke test is skipped locally; CI sets `AI_WORKER_REQUIRE_ZBAR=1`.

```bash
cd services/ai-worker
uv sync --frozen
uv run --frozen mypy      # strict typing
uv run --frozen pytest    # synthetic image fixtures generated in tests
uv run --frozen uvicorn tpa_ai_worker.app:app --no-access-log --port 8090
```
