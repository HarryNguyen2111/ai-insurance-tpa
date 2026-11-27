# DOC-01 (#26)

Four existing API-C1 endpoints: consent, direct private S3 upload grant, complete, authorized status.
No binary upload endpoint or caller-selected storage key/URL. Original filename is validated by the
contract but never persisted, logged, or put in a key. Member/guardian relationships come from AUTH-01.
Staff status reads require explicit DOCUMENT READ assignment. Content consumers call `consume` within
their business transaction and must not bypass its CLEAN, ownership and current-consent gates.

Provision `DocumentsModule.register` with the same approved identity module, `S3DocumentStorage` and
an approved upload-purpose string. The default app deliberately remains unconfigured/503, consistent
with AUTH-01; this change does not approve an identity/storage/scanner provider. Trusted provisioning
inserts `consent_policies` with exact purpose/version/hash; no legal text or default purpose is invented.
Deactivate obsolete policies through the trusted provisioner. Consent is append-only server-timed evidence.
No TTL, erasure, legal hold or retention policy is inferred here.

S3 must be private (deny public ACL/policy, least-privilege credentials, TLS, versioning, lifecycle/retention
approved separately). Versioning is checked at grant. Presigned PUT binds exact length/type/SHA256,
expires within 300s, and uses a unique server key. Repeated PUTs can create versions of the SAME checksum;
completion pins an immutable version and every subsequent consumer/scanner reads that version. Do not
provide application credentials with delete-version permission. No storage URL is persisted in idempotency,
audit, events or Temporal. A replay re-signs the same upload with its ORIGINAL expiry, never extends it.

Complete verifies HEAD and bounded GET SHA256/type before atomically inserting the immutable document,
hash-chain audit and `document_scan_outbox`. It returns 202 QUARANTINED; replay returns that original
response even after scan. Poll GET for current status. `document_scan_outbox` is a transactional work
outbox, not a new Kafka domain event (no unapproved event contract). Scan workers claim rows with
SKIP LOCKED and hold a transaction through bounded S3/scanner I/O; outage/crash rolls back to quarantine.
Scanner results and audit commit together. This favors a small, safe initial batch over long-running leases.

Run the compiled worker `node dist/documents-consents/scan-worker.js` from core-api after build (confirm
build output root in your packaging). Environment: DATABASE_URL (tpa_app), DOCUMENT_TENANT_ID,
DOCUMENT_SCANNER_SERVICE_ID (opaque provisioned UUID), DOCUMENT_S3_ENDPOINT (HTTPS), DOCUMENT_S3_REGION,
DOCUMENT_S3_BUCKET, AWS credentials via SDK credential provider chain, DOCUMENT_SCANNER_URL (HTTPS),
DOCUMENT_SCANNER_TOKEN (secret). A trusted worker scheduler invokes bounded batches; tenant discovery
and production deployment remain platform integration, not a public endpoint. TLS CA may be supplied
with NODE_EXTRA_CA_CERTS at process startup.

Scanner protocol: POST bounded binary bytes to the operator-configured sandbox URL, Authorization Bearer,
Content-Type application/octet-stream, X-Document-Content-Type declared MIME. Response <=4096 bytes:
`{sha256,contentType,malwareFree:boolean,structurallySafe:boolean,scannerVersion}`. Both safety booleans
must be true, digest and type must match the actual bytes. Version is a bounded technical code, never free
text. Redirects, timeout, missing/mismatched evidence and malformed responses fail closed. Full structural
inspection MUST enforce pixel/page/expansion limits, reject polyglots/embedded executables, prohibit
network/SSRF/XXE and isolate parsers. Local gates inspect MIME and reject DTD/entities without parsing.
This adapter is NOT a production antivirus engine or evidence of approved provider safety. The integration
scanner uses synthetic deterministic attacks only; real engine provisioning/evaluation is an explicit boundary.

Acceptance: DOC synthetic tests map to PT01 tenant/object isolation, PT15 size/type/XML/malware gates,
PT17 minimal audit/URL/PII boundary, PT22 payload conflict/replay. These are scoped subsets, not full
platform acceptance (QR fetch/real scanner evaluation, Kafka/history/index/DLQ, retention and pilot consent
need their owning integrations). Golden TC01–TC06 are unchanged regression tests, not document scenarios.
