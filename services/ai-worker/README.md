# tpa-ai-worker (AI-01, AI-02)

Python FastAPI worker for image quality checks and immutable preprocessing. It
**proposes technical evidence only**: it never approves a claim, never writes
money, and does not log content or personal data. The only network access is
the SSRF-hardened invoice XML fetch in `tpa_ai_worker/invoice/fetch.py`.

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

## Invoice QR/XML extraction (AI-02, `tpa_ai_worker.invoice`)

- **QR:** `pyzbar` decodes QR codes only; payloads > 2 KiB or non-UTF-8 are
  dropped; more than one distinct payload is `QR_AMBIGUOUS`.
- **Trusted hosts:** `AI_WORKER_INVOICE_FETCH_ALLOWED_HOSTS` is a comma list
  of exact host names (no wildcards, schemes, ports or IPs). **Empty means no
  fetch at all.** The real provider lookup hosts are an owner/provider
  decision and are not shipped as defaults.
- **SSRF:** `https` on port 443 only; userinfo, IP literals, backslashes and
  control characters are refused. Each hop resolves DNS once, requires
  *every* address to be public (private, loopback, link-local/metadata,
  CGNAT, multicast, reserved, documentation, IPv4-mapped/6to4/Teredo/NAT64
  IPv6 are refused), then connects to that pinned IP with TLS SNI and
  certificate verification for the host name (DNS-rebinding safe). Redirects
  (max 3) are re-validated from scratch.
- **Limits:** 10 s total deadline, 5 s per socket operation, 2 MiB on the
  wire (`AI_WORKER_INVOICE_MAX_FETCH_BYTES` may only tighten), 5 MiB after
  gzip/deflate/zip decompression with a 100x ratio cap; zip must contain
  exactly one `.xml` member.
- **XML:** lxml with `resolve_entities=False`, `load_dtd=False`,
  `no_network=True`, `huge_tree=False`; any DOCTYPE/ENTITY is refused (also
  in UTF-16), XInclude is never processed, depth ≤ 64 and ≤ 20 000 elements.
- **Extraction:** TT78 GDT layout (`HDon/DLHDon/TTChung`, `NDHDon/NBan`,
  `DSHHDVu/HHDVu`, `TToan`), namespace-agnostic. Money is `Decimal` and a
  2-dp string (`ROUND_HALF_UP`); exponents, signs, separators and NaN are
  refused. `isMergedSummary` is true when the XML has at most one goods line
  (TChat 1), so it must be reconciled against the itemized list (TC05).
  Buyer name is used only for PERSONAL/COMPANY classification and is never
  kept; no buyer address, phone or identifier is returned.
- **Verification:** `parseStatus` (`PARSED`/`FAILED`/`UNAVAILABLE`) is kept
  apart from `verificationStatus`, which this worker can only set to
  `UNVERIFIED` (typed and guarded at runtime). An `MCCQT` code or signature
  block in the XML is recorded as present but is **not** verification.

## Not in scope (honest limits)

- No Viettel AI / VLM / model call and no OCR or field extraction (#30).
- QR/XML invoice extraction (#29) is a library (`tpa_ai_worker.invoice`) with
  no HTTP endpoint yet; wiring it to a job/endpoint needs service identity.
- No tax verification: parsed QR/XML is always `UNVERIFIED` (see below).
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
