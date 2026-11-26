export interface paths {
    "/v1/auth/zalo/exchange": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Exchange verified Zalo identity
         * @description BLOCKED pending provider evidence: code, PKCE, state and redirect semantics are adapter proposals, not a claim of Zalo support. Fail closed 503 PROVIDER_NOT_CONFIGURED until approved. Verify upstream identity server-side; rate-limit; no client-asserted tenant. Idempotency scoped to verified exchange transaction; never log code/tokens.
         */
        post: operations["exchangeZaloIdentity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read verified principal and granted memberships
         * @description Read verified principal and granted memberships
         */
        get: operations["getMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/memberships": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List active verified memberships
         * @description List active verified memberships
         */
        get: operations["getMemberships"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/membership": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Select an existing membership grant
         * @description Select an existing membership grant
         */
        post: operations["selectMembership"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/consents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record versioned consent evidence
         * @description Record versioned consent evidence
         */
        post: operations["recordConsent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/members/{memberId}/e-card": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read dynamic authorized e-card
         * @description Verify member ownership/guardian or granted staff access; Cache-Control: no-store; QR rotates within 60 seconds. Token is opaque and excludes PII. Redemption protocol blocked pending provider decision.
         */
        get: operations["getECard"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims/upload-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create owner-bound upload session
         * @description Presigned direct-to-S3 only. Bind subject, membership, member, declared type/size/checksum. Expiry <=300s, unique immutable key, quarantine bucket; no public ACL. Never trust caller object keys. Consent required before processing.
         */
        post: operations["presignUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/uploads/{uploadId}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Verify and quarantine uploaded object
         * @description Owner-only; independently verify HEAD/checksum/size/sniffed type. Return QUARANTINED/SCANNING, never CLEAN before scan. SSRF/XXE/decompression and page limits enforced by downstream scanner. Replayed completion returns original result.
         */
        post: operations["completeUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/documents/{documentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read authorized document scan status
         * @description Read authorized document scan status
         */
        get: operations["getDocument"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims/preflight-check": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Run fast or pending preflight
         * @description Fast target p95 <=3s is not a guaranteed SLA. 200 only COMPLETED; 202 only PENDING with Location/statusUrl and Retry-After. Verify CLEAN document ownership; warnings use versioned verified rules, never legal/benefit approval.
         */
        post: operations["preflightClaim"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/preflights/{preflightId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Poll authorized preflight
         * @description Poll authorized preflight
         */
        get: operations["getPreflight"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List authorized claims using stable cursor
         * @description Allowlist cursor/limit/status/memberId only; reject unknown filters/sort/tenant/DSL 422. Stable createdAt+claimId ordering, opaque cursor bound to membership and filters; authorize every object. PostgreSQL business truth.
         */
        get: operations["listClaims"];
        put?: never;
        /**
         * Submit reimbursement claim
         * @description Submit reimbursement claim
         */
        post: operations["submitClaim"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims/{claimId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read authorized claim detail
         * @description Read authorized claim detail
         */
        get: operations["getClaim"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims/{claimId}/documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Attach authorized supplement documents
         * @description Attach authorized supplement documents
         */
        post: operations["supplementClaim"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/webhooks/ai-result": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Accept authenticated versioned AI proposal
         * @description Ingress mTLS/service identity AND HMAC-SHA256 required. Sign UTF-8 timestamp + newline + event ID + newline + exact raw body bytes; lowercase hex digest, constant-time comparison. Reject timestamps outside +/-300 seconds (including future), invalid signature 401, untrusted service 403. Header/body eventId must match. Dedup by verified service/run/event ID plus raw-body hash; changed payload 409. Tenant resolved from authorized extraction run; check expected claim version and referenced evidence. Duplicate in replay window returns durable original acknowledgement; expired signed replay rejected 401 even if previously seen. Key rotation/identity trust deployment blocked until approved.
         */
        post: operations["receiveAiResult"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/policies/{policyId}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create policy version
         * @description Authorized policy administrator with MFA; exact approved source clauses, dates and precedence. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        post: operations["createPolicyVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/policies/{policyId}/versions/{versionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get policy version
         * @description Authorized assigned policy/coverage reader only; used versions immutable. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store.
         */
        get: operations["getPolicyVersion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/benefit-plans/{planId}/rule-versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create benefit rule version
         * @description Policy administrator with MFA; verify plan/policy ownership and approved terms/config. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        post: operations["createBenefitRuleVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/benefit-plans/{planId}/rule-versions/{versionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get benefit rule version
         * @description Only authorized plan/coverage rules; no universal defaults. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store.
         */
        get: operations["getBenefitRuleVersion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims/{claimId}/calculations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Calculate claim
         * @description Assigned MFA reviewer; reproducible immutable snapshot, not monetary authorization. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        post: operations["calculateClaim"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims/{claimId}/calculations/{calculationRunId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get calculation run
         * @description Assigned staff reviewer only; member-safe EOB separate, no raw input exposed. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store.
         */
        get: operations["getCalculationRun"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims/{claimId}/eob": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get eob
         * @description Owner/guardian or assigned staff; PostgreSQL published snapshot only. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store.
         */
        get: operations["getEob"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims/{claimId}/eob/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Publish eob
         * @description Assigned MFA adjudicator verifies clauses/snapshot and atomic limit reservation. New EOB invalidates old OTP/approvals; payout submitted blocks edits. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        post: operations["publishEob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/workbench/claims/{claimId}/lines/{lineId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Decide claim line
         * @description Assigned MFA reviewer; immutable clause/explanationVi for reductions/rejections. Relabel creates proposal only. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        patch: operations["decideClaimLine"];
        trace?: never;
    };
    "/v1/claims/{claimId}/otp/challenges": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create otp challenge
         * @description Owner/guardian only. Durable resend/attempt/expiry/one-use policy; no OTP/hash output or logging. Provider pending, fail closed 503 PROVIDER_NOT_CONFIGURED. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        post: operations["createOtpChallenge"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims/{claimId}/otp/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Verify eob otp
         * @description Owner/guardian; current EOB/member binding, durable attempt cap/expiry/one-use lock; invalid code 422, stale 409, abuse 429. Idempotent replay does not consume twice. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        post: operations["verifyEobOtp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims/{claimId}/signatures/{signatureId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get eob signature
         * @description Owner/guardian or assigned staff; effective validity checked against current EOB/expiry/revocation, never trust historical VALID alone. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store.
         */
        get: operations["getEobSignature"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/insurer/claims/{claimId}/approvals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Decide insurer approval
         * @description Assigned insurer MFA reviewer; server derives stage; checker differs from maker and references current decision/EOB/config. New EOB revokes older approvals. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        post: operations["decideInsurerApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/claims/{claimId}/original-documents/receive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Receive original documents
         * @description Authorized receipt staff MFA verifies actual receipt/evidence; tracking alone insufficient. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        post: operations["receiveOriginalDocuments"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/payments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create payment intent
         * @description Finance MFA; current signature/approval/original/reservations/funds gates under lock. UNKNOWN never blind retry. Provider submission blocked pending actual bank contract. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        post: operations["createPaymentIntent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/payments/{paymentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get payment intent
         * @description Finance/insurer with payment object permission; PostgreSQL status, no payee PII. UNKNOWN requires reconciliation, not resubmission. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store.
         */
        get: operations["getPaymentIntent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/payments/callbacks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Receive payment callback
         * @description Generic INTERNAL adapter contract, NOT actual bank wire format. Require ingress mTLS/service identity AND HMAC-SHA256 of UTF-8 timestamp + newline + event ID + newline + exact raw body; lowercase hex, constant-time check. Reject outside +/-300s including future 401 REPLAY_REJECTED; invalid signature 401, untrusted service 403. Header/body eventId equal. Tenant resolved from verified service/payment/attempt. Durable service/payment/attempt/event dedup + raw body hash; identical valid replay ack, changed body 409. Expired replay rejected even if seen. Stale/reordered/conflicting terminal updates 409 then reconcile, never downgrade success. Evidence verification/key rotation/identity trust/provider mapping pending; fail closed until approved. Server verifies service identity and payment/attempt permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store.
         */
        post: operations["receivePaymentCallback"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/payment-reconciliations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record payment reconciliation
         * @description Finance MFA; independently verify provider evidence to resolve UNKNOWN without resending. Atomic balanced journal/reservation/audit/outbox on success; POSTED corrections via reversal only. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        post: operations["recordPaymentReconciliation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/search/claims": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search claims
         * @description Inject verified tenant and per-object permissions for query/get/mget/count/suggest/aggregation/export. Reject unknown filters/tenant/DSL 422; no direct Elasticsearch. Cursor bound to membership/filter/order, stable updatedAt+claimId. Minimal projection only, no PII/raw source or money aggregation. Eventual consistency; detail/decisions from PostgreSQL. Search outage 503 never blocks submit/payment. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store.
         */
        get: operations["searchClaims"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/insurer/payment-exports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create payment export
         * @description Finance/insurer export permission; each payment authorized at creation/execution/download; cancel on revocation. CSV formula mitigation =,+,-,@ after leading whitespace/control, quote CSV and force XLSX text cells; fixed safe columns. No PII or signed URLs in logs/events/history. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        post: operations["createPaymentExport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/insurer/payment-exports/{exportId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get payment export
         * @description Revalidate subject/membership and every payment permission; status 200 may PENDING/READY/FAILED. READY private signed URL TTL <=300s via authorized download gateway if revocation otherwise impossible. No URL logging. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store.
         */
        get: operations["getPaymentExport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/catalog-proposals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create catalog proposal
         * @description Assigned MFA reviewer creates evidenced proposal, never global catalog mutation. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        post: operations["createCatalogProposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/catalog-proposals/{proposalId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get catalog proposal
         * @description Assigned tenant reviewer or separately authorized curator; no cross-tenant evidence leakage. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store.
         */
        get: operations["getCatalogProposal"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/catalog-proposals/{proposalId}/review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Review catalog proposal
         * @description MFA reviewer differs from proposer; tenant authority separate from global curator. Approval creates scoped immutable version, rejection leaves catalog unchanged. Server verifies principal, active membership and object permissions; conceal inaccessible objects 404, action denied 403. Revalidate on replay; no-store. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. Retention >=24h never permits duplicate semantic side effects. Business state + audit + outbox atomic in withTenantTransaction using SET LOCAL/RLS. Stale aggregate/EOB version/hash 409 STALE_VERSION.
         */
        post: operations["reviewCatalogProposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/workspaces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create organisation workspace (TPA ops)
         * @description Decided OD-05: only a TPA operations principal with platform workspace-administration authority and verified MFA, acting through its own server-issued operator membership context, may create a workspace; authority is provisioned separately (#21) and never inferred from a tenant membership or request field. Decided OD-02: TPA assigns the slug here; it is globally unique, routing-only and never proof of access. Creates tenant workspace profile, default theme when omitted, and grants WORKSPACE_ADMIN to initialAdminPrincipalId (an existing verified principal) in one transaction with audit and outbox workspace.changed. Slug already used or reserved returns 422 DOMAIN_VIOLATION (concurrent creates with one slug: exactly one 201). Low colour contrast is a warning only (decided OD-WS1). No tenantId accepted or returned. Durable tenant/actor/operation/key canonical hash: same body returns original, changed body 409 IDEMPOTENCY_CONFLICT; in-progress 409 with Retry-After. No-store.
         */
        post: operations["createWorkspace"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/workspaces/{workspaceId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read workspace profile, theme and active logo
         * @description WORKSPACE_ADMIN of this workspace (membership context bound to it) or TPA operations authority. Other workspaces return 404 without revealing existence. Logo preview URL is private, signed and expires in at most 300 seconds; never logged. No-store.
         */
        get: operations["getWorkspace"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/workspaces/{workspaceId}/profile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Replace workspace profile (not slug)
         * @description WORKSPACE_ADMIN of this workspace with verified MFA. Full replacement of displayName, shortName, orgType and description (absent description clears it). The slug is not editable here (decided OD-02: TPA assigns slugs; a controlled slug change is a separate future operation pending OD-WS3). expectedVersion must equal the current version or 409 STALE_VERSION. Business state + audit + outbox workspace.changed atomic in withTenantTransaction using SET LOCAL/RLS. Idempotency as createWorkspace. No-store.
         */
        put: operations["updateWorkspaceProfile"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/workspaces/{workspaceId}/theme": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Replace workspace theme from the closed allowlist
         * @description WORKSPACE_ADMIN with verified MFA. Theme accepts only the closed allowlist (hex colour, radius, mode, sidebar style); no CSS, fonts, HTML or URLs. Button text colour is derived server-side (white or black, always >= 4.5:1). Decided OD-WS1: primary colour contrast against the page surface below 3:1 is returned as a LOW_SURFACE_CONTRAST warning and never rejected. expectedVersion mismatch 409 STALE_VERSION. Audit + outbox atomic. Idempotency as createWorkspace. No-store.
         */
        put: operations["updateWorkspaceTheme"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/workspaces/{workspaceId}/logo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Activate a processed logo asset or clear the logo
         * @description WORKSPACE_ADMIN with verified MFA. Activation requires an asset of this workspace in state READY, otherwise 422 DOMAIN_VIOLATION (assets of other workspaces 404). Clearing keeps the immutable original asset for audit/retention. expectedVersion mismatch 409 STALE_VERSION. Audit + outbox atomic. Idempotency as createWorkspace. No-store.
         */
        put: operations["setWorkspaceLogo"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/workspaces/{workspaceId}/logo-assets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request a pre-signed upload for a new logo asset
         * @description WORKSPACE_ADMIN with verified MFA. Pre-signed PUT into a private quarantine location bound to this workspace, declared type, size and checksum; core-api never receives file bytes. PNG, JPEG or WebP only (SVG never accepted); 2 MiB raw maximum. URL expires in at most 300 seconds and never enters logs, events or history. Does not change the workspace version. Idempotency as createWorkspace. No-store.
         */
        post: operations["createWorkspaceLogoUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/workspaces/{workspaceId}/logo-assets/{assetId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Poll logo asset processing state
         * @description WORKSPACE_ADMIN of this workspace. Other workspaces' assets return 404. No-store.
         */
        get: operations["getWorkspaceLogoAsset"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/workspaces/{workspaceId}/logo-assets/{assetId}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Finish logo upload and start safe processing
         * @description WORKSPACE_ADMIN with verified MFA. Server independently checks object owner, size and checksum, sniffs magic bytes (SVG and type mismatches rejected), enforces pixel/decompression limits, scans, then decodes and re-encodes (EXIF/GPS and other metadata dropped), producing 512px and 64px derivatives. The original object stays immutable. Returns 202 PROCESSING; poll the Location resource. A READY asset still needs setWorkspaceLogo to become active. Idempotency as createWorkspace. No-store.
         */
        post: operations["completeWorkspaceLogoUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Hash: string;
        /** @description VND NUMERIC(15,2); Decimal ROUND_HALF_UP for computation; never JSON number. */
        Money: string;
        /** @enum {string} */
        BenefitType: "OUTPATIENT" | "INPATIENT" | "DENTAL" | "MATERNITY" | "ACCIDENT" | "HOSPITAL_INCOME";
        /** @enum {string} */
        DocumentType: "INVOICE_PHOTO" | "ITEMIZED_LIST" | "PRESCRIPTION" | "LAB_ORDER" | "LAB_RESULT" | "DISCHARGE_PAPER" | "VNEID_HISTORY";
        /** @enum {string} */
        ClaimStatus: "PREFLIGHT" | "SUBMITTED" | "AI_PROCESSING" | "GREEN_STP" | "DOCTOR_REVIEW" | "FRAUD_HOLD" | "SUPPLEMENT_REQUIRED" | "WAITING_ORIGINAL_DOCS" | "EOB_READY" | "OTP_SIGNED" | "PAYOUT_PROCESSING" | "PAID" | "REJECTED" | "CLOSED_EXPIRED";
        ApiError: {
            /** @enum {string} */
            code: "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "STALE_VERSION" | "OPERATION_IN_PROGRESS" | "VALIDATION_FAILED" | "DOMAIN_VIOLATION" | "RATE_LIMITED" | "DEPENDENCY_UNAVAILABLE" | "PROVIDER_NOT_CONFIGURED" | "INVALID_SIGNATURE" | "REPLAY_REJECTED";
            messageVi: string;
            /** Format: uuid */
            correlationId: string;
        };
        /** @description Server-issued active grant; roles alone do not grant object access. No client tenant assertion. */
        Membership: {
            /** Format: uuid */
            membershipId: string;
            roles: ("MEMBER" | "GUARDIAN" | "CLAIM_REVIEWER" | "INSURER_REVIEWER" | "FINANCE" | "CURATOR")[];
            memberIds: string[];
            version: number;
        };
        Me: {
            /** Format: uuid */
            principalId: string;
            memberships: components["schemas"]["Membership"][];
            mfaVerified: boolean;
        };
        /** @description Select an existing grant; server revalidates active membership on every request. */
        MembershipSelection: {
            /** Format: uuid */
            membershipId: string;
        };
        /** @description Opaque server-bound context, never a tenant ID. Revoke on membership change. */
        MembershipContext: {
            /** Format: uuid */
            membershipId: string;
            /** Format: date-time */
            expiresAt: string;
            contextToken: string;
        };
        /** @description Technical adapter proposal only; blocked until provider-supported code/PKCE/state semantics are verified. No client userId/tenantId accepted. */
        ZaloExchange: {
            authorizationCode: string;
            codeVerifier: string;
            /** Format: uri */
            redirectUri: string;
            state: string;
        };
        /** @description No local identity/password server. Issuer/audience/algorithms/JWKS/MFA mapping require approved OIDC provider configuration. */
        AuthSession: {
            accessToken: string;
            /** @enum {string} */
            tokenType: "Bearer";
            expiresIn: number;
        };
        /** @description Server verifies subject/guardian, approved purpose and exact presented policy; records server time and evidence. Client boolean alone is insufficient. */
        ConsentRequest: {
            /** Format: uuid */
            memberId: string;
            purpose: string;
            policyVersion: string;
            policyHash: components["schemas"]["Hash"];
            /** @enum {boolean} */
            accepted: true;
        };
        ConsentRecord: {
            /** Format: uuid */
            consentId: string;
            /** Format: uuid */
            memberId: string;
            purpose: string;
            policyVersion: string;
            policyHash: components["schemas"]["Hash"];
            /** Format: date-time */
            recordedAt: string;
            version: number;
        };
        /** @description Opaque short-lived token, maximum 60 seconds; no raw CCCD/phone/bank data. Backend authorization required on redemption; coverage is not benefit approval. */
        ECard: {
            /** Format: uuid */
            memberId: string;
            /** Format: uuid */
            coverageVersionId: string;
            displayNameMasked: string;
            cardNumberMasked: string;
            qrToken: string;
            /** Format: date-time */
            issuedAt: string;
            /** Format: date-time */
            expiresAt: string;
        };
        /** @enum {string} */
        ContentType: "image/jpeg" | "image/png" | "image/heic" | "image/heif" | "application/pdf" | "application/xml" | "text/xml";
        /** @description 20 MiB technical maximum; deploy policy may be stricter. Bind immutable object key, verified subject/membership/member and checksum. No arbitrary object key accepted. */
        UploadRequest: {
            /** Format: uuid */
            memberId: string;
            fileName: string;
            contentType: components["schemas"]["ContentType"];
            docType: components["schemas"]["DocumentType"];
            sizeBytes: number;
            sha256: components["schemas"]["Hash"];
        };
        UploadHeaders: {
            "Content-Type": components["schemas"]["ContentType"];
            "x-amz-checksum-sha256": string;
        };
        /** @description Expires in at most 300 seconds. Private bucket; URL/header secrets must never enter logs/events/history; checksum header is base64 SHA-256. */
        UploadGrant: {
            /** Format: uuid */
            uploadId: string;
            /** Format: uri */
            uploadUrl: string;
            /** @enum {string} */
            method: "PUT";
            /** Format: date-time */
            expiresAt: string;
            requiredHeaders: components["schemas"]["UploadHeaders"];
        };
        /** @description Server independently HEAD/checks owner, immutable key/version, actual size/checksum and sniffed type. Mismatch 422; expired session 409; no fetch of caller URLs. */
        UploadComplete: {
            sha256: components["schemas"]["Hash"];
            sizeBytes: number;
        };
        /** @description Original immutable, inaccessible to AI/preflight/claim attachment until CLEAN. Reject malware, polyglots, decompression bombs; no storage keys or PII in response. */
        Document: {
            /** Format: uuid */
            documentId: string;
            /** Format: uuid */
            memberId: string;
            docType: components["schemas"]["DocumentType"];
            contentType: components["schemas"]["ContentType"];
            sizeBytes: number;
            sha256: components["schemas"]["Hash"];
            version: number;
            /** @enum {string} */
            scanStatus: "QUARANTINED" | "SCANNING" | "CLEAN" | "REJECTED";
            /** Format: date-time */
            createdAt: string;
        };
        /** @description Only CLEAN documents owned by same subject/member/membership. Does not approve benefits or reserve money. */
        PreflightRequest: {
            /** Format: uuid */
            memberId: string;
            benefitType: components["schemas"]["BenefitType"];
            documentIds: string[];
        };
        /** @description Warnings require versioned verified policy evidence; examples are not universal legal exclusions. */
        Warning: {
            /** @enum {string} */
            code: "BLURRY_IMAGE" | "ND70_COMPANY_ADDRESS" | "MISSING_STAMP" | "PRESCRIPTION_WINDOW" | "SUPPLEMENT_REQUIRED" | "UNVERIFIED_SOURCE" | "MANUAL_REVIEW";
            /** @enum {string} */
            severity: "BLOCKER" | "WARNING";
            messageVi: string;
            /** Format: uuid */
            documentId?: string;
            /** Format: uuid */
            evidenceId?: string;
            ruleVersion: string;
        };
        PreflightCompleted: {
            /** Format: uuid */
            preflightId: string;
            /** @enum {string} */
            status: "COMPLETED";
            version: number;
            passed: boolean;
            warnings: components["schemas"]["Warning"][];
            /** Format: date-time */
            completedAt: string;
        };
        PreflightPending: {
            /** Format: uuid */
            preflightId: string;
            /** @enum {string} */
            status: "PENDING";
            version: number;
            statusUrl: string;
            retryAfterSeconds: number;
        };
        PreflightFailed: {
            /** Format: uuid */
            preflightId: string;
            /** @enum {string} */
            status: "FAILED";
            version: number;
            error: components["schemas"]["ApiError"];
        };
        PreflightStatus: components["schemas"]["PreflightCompleted"] | components["schemas"]["PreflightPending"] | components["schemas"]["PreflightFailed"];
        /** @description Server verifies ownership, CLEAN docs, current consent/purpose/policy, preflight version and coverage. No raw storage keys. Post-commit only: business state + audit hash chain + outbox in withTenantTransaction using SET LOCAL/RLS. */
        ClaimSubmit: {
            /** Format: uuid */
            memberId: string;
            benefitType: components["schemas"]["BenefitType"];
            /** Format: date */
            visitDate: string;
            totalRequested: components["schemas"]["Money"];
            /** @enum {boolean} */
            consentAccepted: true;
            /** Format: uuid */
            consentId: string;
            documentIds: string[];
            /** Format: uuid */
            preflightId: string;
            expectedPreflightVersion: number;
            /** Format: uuid */
            providerId?: string;
            /** Format: date-time */
            admitDatetime?: string;
            /** Format: date-time */
            dischargeDatetime?: string;
            hasSurgeryCert?: boolean;
            icd10Code?: string;
        };
        ClaimSummary: {
            /** Format: uuid */
            claimId: string;
            claimCode: string;
            /** Format: uuid */
            memberId: string;
            benefitType: components["schemas"]["BenefitType"];
            /** Format: date */
            visitDate: string;
            totalRequested: components["schemas"]["Money"];
            status: components["schemas"]["ClaimStatus"];
            version: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        /** @description Owner/verified guardian or explicitly assigned staff only; detail reads PostgreSQL, not search. No cross-tenant existence disclosure. */
        ClaimDetail: {
            claim: components["schemas"]["ClaimSummary"];
            documents: components["schemas"]["Document"][];
            supplementAllowed: boolean;
            /** Format: date-time */
            supplementDeadline?: string;
        };
        ClaimList: {
            items: components["schemas"]["ClaimSummary"][];
            nextCursor?: string;
        };
        /** @description Only SUPPLEMENT_REQUIRED before deadline; server checks status, CLEAN owner/member docs and aggregate version under lock. Atomic audit/outbox; duplicate command has no repeated transition. */
        ClaimSupplement: {
            expectedVersion: number;
            documentIds: string[];
        };
        Region: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        /** @description Normalized page region; confidence is not money. Evidence resolves authorized immutable original, never an arbitrary URL. */
        Evidence: {
            /** Format: uuid */
            evidenceId: string;
            /** Format: uuid */
            documentId: string;
            documentVersion: number;
            page: number;
            field: string;
            /** @enum {string} */
            source: "XML" | "OCR" | "VLM" | "QR" | "IMAGE_ANALYSIS";
            confidence: number;
            region?: components["schemas"]["Region"];
        };
        /** @description Parsing QR/XML never implies VERIFIED_VALID. Verified outcomes require independently authenticated source evidence; provider semantics remain blocked pending sandbox verification. */
        TaxVerification: {
            /** @enum {string} */
            parseStatus: "PARSED" | "FAILED" | "UNAVAILABLE";
            /** @enum {string} */
            verificationStatus: "UNVERIFIED" | "VERIFIED_VALID" | "CANCELLED" | "NOT_FOUND" | "UNAVAILABLE";
            source: string;
            /** Format: date-time */
            checkedAt: string;
            evidenceIds: string[];
        };
        /** @description AI proposal only; no approved/rejected amount or contract decision. PII-redacted item text; core recomputes monetary consistency with Decimal. */
        ExtractedLine: {
            /** Format: uuid */
            lineId: string;
            itemName: string;
            quantity: string;
            unitPrice: components["schemas"]["Money"];
            requestedAmount: components["schemas"]["Money"];
            evidenceIds: string[];
        };
        /** @description Signal for review, never sufficient to deny coverage. */
        FraudSignal: {
            /** @enum {string} */
            code: "IMAGE_SIMILARITY" | "EXIF_TAMPER" | "SOURCE_MISMATCH" | "PRICE_ANOMALY" | "ICD_MISMATCH";
            confidence: number;
            evidenceIds: string[];
        };
        /** @description Service identity maps run to tenant/claim; no caller tenant. Core verifies run, document ownership/version, evidence references and stale version. No raw XML/OCR/PII, URLs, benefit decisions. Never log body. Invoice is omitted if not extracted; failure/unavailable source status must not become VERIFIED_VALID. */
        AiResult: {
            /** @enum {string} */
            schemaVersion: "1.0.0";
            /** Format: uuid */
            eventId: string;
            /** Format: uuid */
            claimId: string;
            expectedClaimVersion: number;
            /** Format: uuid */
            extractionRunId: string;
            /** Format: date-time */
            occurredAt: string;
            modelVersion: string;
            promptVersion: string;
            ruleVersion: string;
            inputDocumentIds: string[];
            taxVerification: components["schemas"]["TaxVerification"];
            extractedLines: components["schemas"]["ExtractedLine"][];
            fraudSignals: components["schemas"]["FraudSignal"][];
            evidence: components["schemas"]["Evidence"][];
            invoice?: components["schemas"]["ExtractedInvoice"];
        };
        /** @description 200 only after durable inbox/dedup+result+audit+outbox commit. Same eventId/different raw body hash 409; valid identical replay returns DUPLICATE without side effects. */
        AiAcknowledgement: {
            /** Format: uuid */
            eventId: string;
            /** @enum {string} */
            disposition: "ACCEPTED" | "DUPLICATE";
        };
        Error401: {
            /** @enum {string} */
            code: "UNAUTHENTICATED" | "INVALID_SIGNATURE" | "REPLAY_REJECTED";
            messageVi: string;
            /** Format: uuid */
            correlationId: string;
        };
        Error403: {
            /** @enum {string} */
            code: "FORBIDDEN";
            messageVi: string;
            /** Format: uuid */
            correlationId: string;
        };
        Error404: {
            /** @enum {string} */
            code: "NOT_FOUND";
            messageVi: string;
            /** Format: uuid */
            correlationId: string;
        };
        Error409: {
            /** @enum {string} */
            code: "IDEMPOTENCY_CONFLICT" | "STALE_VERSION" | "OPERATION_IN_PROGRESS";
            messageVi: string;
            /** Format: uuid */
            correlationId: string;
        };
        Error422: {
            /** @enum {string} */
            code: "VALIDATION_FAILED" | "DOMAIN_VIOLATION";
            messageVi: string;
            /** Format: uuid */
            correlationId: string;
        };
        Error429: {
            /** @enum {string} */
            code: "RATE_LIMITED";
            messageVi: string;
            /** Format: uuid */
            correlationId: string;
        };
        Error503: {
            /** @enum {string} */
            code: "DEPENDENCY_UNAVAILABLE" | "PROVIDER_NOT_CONFIGURED";
            messageVi: string;
            /** Format: uuid */
            correlationId: string;
        };
        IdempotencyKeyValue: string;
        /** @description Redacted extraction proposal, not verified tax evidence; excludes raw buyer name/address/identity. Seller identifier must be authorized for service processing; never log payload. */
        ExtractedInvoice: {
            sellerTaxCode: string;
            invoiceSerial: string;
            invoiceNumber: string;
            /** Format: date */
            invoiceDate: string;
            /** @enum {string} */
            buyerAddressType: "PERSONAL" | "COMPANY" | "UNKNOWN";
            totalAmount: components["schemas"]["Money"];
            isMergedSummary: boolean;
            evidenceIds: string[];
        };
        VersionNumber: number;
        VersionedReference: {
            /** Format: uuid */
            id: string;
            version: components["schemas"]["VersionNumber"];
            hash: components["schemas"]["Hash"];
        };
        /** @description Exact immutable EOB binding. Stale version/hash returns 409 STALE_VERSION; republication invalidates older challenges, signatures and approvals. */
        EobBinding: {
            eobVersion: components["schemas"]["VersionNumber"];
            eobHash: components["schemas"]["Hash"];
        };
        /** @description Immutable cited text and Vietnamese explanation from approved source version. Server verifies ownership, exact text and applicability; no invented exclusions. */
        ContractClause: {
            /** Format: uuid */
            clauseId: string;
            /** @enum {string} */
            source: "BENEFIT_RULE" | "MEDICAL_CATALOG";
            sourceVersion: components["schemas"]["VersionedReference"];
            contractClauseCited: string;
            explanationVi: string;
        };
        /** @description Creates immutable version, never edits/deletes used policy. Verify approved source, interval and complete deterministic endorsement precedence; no default terms. */
        PolicyVersionInput: {
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            /** Format: date */
            effectiveFrom: string;
            /** Format: date */
            effectiveTo: string;
            sourceDocument: components["schemas"]["VersionedReference"];
            endorsements: components["schemas"]["VersionedReference"][];
            precedence: string[];
            clauses: components["schemas"]["ContractClause"][];
        };
        PolicyVersion: {
            /** Format: uuid */
            policyId: string;
            policyVersion: components["schemas"]["VersionedReference"];
            aggregateVersion: components["schemas"]["VersionNumber"];
            definition: components["schemas"]["PolicyVersionInput"];
            /** Format: date-time */
            createdAt: string;
        };
        /** @description All values from approved immutable contract/config; no thresholds/defaults inferred. Plan-specific terms resolve via configurationVersion; missing terms require review, not invented rejection. */
        BenefitRuleVersionInput: {
            configuration: components["schemas"]["BenefitConfiguration"];
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            policyVersion: components["schemas"]["VersionedReference"];
            benefitType: components["schemas"]["BenefitType"];
            annualLimit: components["schemas"]["Money"];
            perVisitLimit?: components["schemas"]["Money"];
            deductiblePerClaim: components["schemas"]["Money"];
            copayInsurerPct: string;
            waitingDaysNormal: number;
            waitingDaysSpecial: number;
            configurationVersion: components["schemas"]["VersionedReference"];
            clauses: components["schemas"]["ContractClause"][];
        };
        BenefitRuleVersion: {
            ruleVersion: components["schemas"]["VersionedReference"];
            aggregateVersion: components["schemas"]["VersionNumber"];
            definition: components["schemas"]["BenefitRuleVersionInput"];
            /** Format: date-time */
            createdAt: string;
        };
        /** @description Core selects authorized claim/member/coverage/documents and reservation accounts under lock. Caller cannot assert balances/totals. Calculation alone is not publication or payout authorization. */
        CalculationRequest: {
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            policyVersion: components["schemas"]["VersionedReference"];
            benefitRuleVersion: components["schemas"]["VersionedReference"];
            configurationVersion: components["schemas"]["VersionedReference"];
        };
        /** @description All reductions/rejections require immutable cited clause and explanationVi. Server verifies Decimal amount conservation and status consistency; schema alone cannot compare money. */
        LineDecision: {
            /** @enum {string} */
            decisionStatus: "APPROVED" | "PARTIAL" | "REJECTED";
            approvedAmount: components["schemas"]["Money"];
            contractClause: components["schemas"]["ContractClause"];
            explanationVi: string;
        };
        EobLine: {
            /** Format: uuid */
            lineId: string;
            itemName: string;
            requested: components["schemas"]["Money"];
            approved: components["schemas"]["Money"];
            rejected: components["schemas"]["Money"];
            /** @enum {string} */
            status: "APPROVED" | "PARTIAL" | "REJECTED";
            clauseCited: string;
            contractClause: components["schemas"]["ContractClause"];
            explanationVi: string;
            evidenceIds: string[];
        };
        EobSummary: {
            totalRequested: components["schemas"]["Money"];
            totalApproved: components["schemas"]["Money"];
            totalRejected: components["schemas"]["Money"];
            remainingAnnualLimit: components["schemas"]["Money"];
        };
        /** @description Committed immutable audit chain. Business state + audit + outbox in same withTenantTransaction using SET LOCAL and RLS. Not an independent external anchor. */
        AuditProof: {
            hashChainTail: components["schemas"]["Hash"];
            /** @enum {boolean} */
            contractLocked: true;
        };
        /** @description Immutable input/output snapshots, stable line order and exact engine/rule/config/catalog/model/prompt versions. Decimal ROUND_HALF_UP only; no float calculations. STP operational default SHADOW until approved per tenant/plan. TC03 cap requires review; TC06 defines routing only, no inferred amounts. */
        CalculationRun: {
            /** Format: uuid */
            calculationRunId: string;
            /** Format: uuid */
            claimId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            inputSnapshot: components["schemas"]["VersionedReference"];
            policyVersion: components["schemas"]["VersionedReference"];
            benefitRuleVersion: components["schemas"]["VersionedReference"];
            configurationVersion: components["schemas"]["VersionedReference"];
            catalogVersion: components["schemas"]["VersionedReference"];
            modelVersion: string;
            promptVersion: string;
            engineVersion: string;
            /** @enum {string} */
            roundingMode: "ROUND_HALF_UP";
            /** @enum {integer} */
            roundingScale: 0;
            lineOrder: string[];
            summary: components["schemas"]["EobSummary"];
            lineItems: components["schemas"]["EobLine"][];
            outputHash: components["schemas"]["Hash"];
            /** @enum {string} */
            triageLane: "GREEN_STP" | "YELLOW_REVIEW" | "RED_FRAUD";
            stpEligible: boolean;
            /** @enum {string} */
            stpExecutionMode: "SHADOW" | "ENABLED" | "DISABLED";
            /** Format: date-time */
            createdAt: string;
        };
        /** @description First publish version=0 without hash; replacement requires current nonzero version AND hash. Server validates relationship, current snapshot and clauses, atomically reserves/releases limits and creates immutable EOB version. Revoke old OTP/approvals. Submitted payout blocks edits; adjustments use controlled reversal flow. */
        PublishEobRequest: {
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            expectedEobVersion: number;
            expectedEobHash?: components["schemas"]["Hash"];
            calculationRun: components["schemas"]["VersionedReference"];
        } & ({
            /** @enum {integer} */
            expectedEobVersion?: 0;
        } | {
            expectedEobHash: string;
            expectedEobVersion?: number;
        });
        /** @description Immutable published snapshot; canonicalization version comes from approved config. Every read authorized; PostgreSQL truth. New version invalidates earlier signatures and approvals. */
        ExplainableEOBResponse: {
            claimCode: string;
            /** Format: uuid */
            claimId: string;
            status: components["schemas"]["ClaimStatus"];
            aggregateVersion: components["schemas"]["VersionNumber"];
            eobVersion: components["schemas"]["VersionNumber"];
            eobHash: components["schemas"]["Hash"];
            /** Format: uuid */
            contractVersionId: string;
            policyVersion: components["schemas"]["VersionedReference"];
            benefitRuleVersion: components["schemas"]["VersionedReference"];
            configurationVersion: components["schemas"]["VersionedReference"];
            calculationRun: components["schemas"]["VersionedReference"];
            summary: components["schemas"]["EobSummary"];
            lineItems: components["schemas"]["EobLine"][];
            reservationIds: string[];
            auditProof: components["schemas"]["AuditProof"];
            /** Format: date-time */
            publishedAt: string;
        };
        /** @description Assigned MFA reviewer records versioned decision, never mutates published EOB or catalog. Non-NONE relabel creates proposal with provenance only; invalidates old confirmations and requires republish. */
        LineDecisionRequest: {
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            expectedEobVersion: number;
            expectedEobHash?: components["schemas"]["Hash"];
            decision: components["schemas"]["LineDecision"];
            /** @enum {string} */
            updateMedicalCatalogAs?: "NONE" | "DRUG" | "SUPPLEMENT_TPCN" | "COSMETIC";
        } & ({
            /** @enum {integer} */
            expectedEobVersion?: 0;
        } | {
            expectedEobHash: string;
            expectedEobVersion?: number;
        });
        LineDecisionResult: {
            /** Format: uuid */
            claimId: string;
            /** Format: uuid */
            lineId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            decision: components["schemas"]["LineDecision"];
            /** @enum {boolean} */
            requiresEobPublication: true;
            auditProof: components["schemas"]["AuditProof"];
            /** Format: uuid */
            catalogProposalId?: string;
        };
        /** @description Owner/guardian; destination resolved from verified member, never caller phone. Durable resend/attempt/expiry/one-use policy from approved config. Provider delivery semantics pending #11/#12/#13/#14. */
        OtpChallengeRequest: {
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            eob: components["schemas"]["EobBinding"];
        };
        /** @description No OTP, hash or phone in output/log/event/history. Server-issued policy times/limits; not proof of provider delivery. */
        OtpChallenge: {
            /** Format: uuid */
            challengeId: string;
            /** Format: uuid */
            claimId: string;
            /** Format: uuid */
            memberId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            eob: components["schemas"]["EobBinding"];
            /** Format: date-time */
            expiresAt: string;
            /** Format: date-time */
            resendAfter: string;
            maxAttempts: number;
            policyVersion: components["schemas"]["VersionedReference"];
            /** @enum {string} */
            status: "PENDING";
        };
        /** @description Opaque secret code, no guessed provider digit count. Never log/retain plaintext. Verify durable hash, expiry, attempts, subject and one-use under lock. Wrong/expired/consumed 422; stale EOB 409; abuse 429. Idempotent success replay returns original signature without consuming twice. */
        OtpVerifyRequest: {
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            eob: components["schemas"]["EobBinding"];
            /** Format: uuid */
            challengeId: string;
            code: string;
        };
        /** @description Exact EOB confirmation evidence, not assertion of legally qualified signature. Recheck validity/revocation and current EOB at payout. */
        EobSignature: {
            /** Format: uuid */
            signatureId: string;
            /** Format: uuid */
            claimId: string;
            /** Format: uuid */
            memberId: string;
            /** Format: uuid */
            challengeId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            eob: components["schemas"]["EobBinding"];
            /** Format: date-time */
            signedAt: string;
            /** Format: date-time */
            validUntil: string;
            /** @enum {string} */
            status: "VALID" | "INVALIDATED" | "EXPIRED";
            policyVersion: components["schemas"]["VersionedReference"];
            auditProof: components["schemas"]["AuditProof"];
        };
        /** @description Server derives maker/checker and actor from verified grant/config. Checker differs from maker and references current maker decision. Cite approved clause for rejection; no hardcoded amount thresholds. */
        InsurerDecisionRequest: {
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            eob: components["schemas"]["EobBinding"];
            /** @enum {string} */
            decision: "APPROVE" | "REJECT";
            /** Format: uuid */
            makerDecisionId?: string;
            reasonVi: string;
            contractClause: components["schemas"]["ContractClause"];
        };
        InsurerDecision: {
            /** Format: uuid */
            decisionId: string;
            /** Format: uuid */
            claimId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            eob: components["schemas"]["EobBinding"];
            /** @enum {string} */
            decision: "APPROVE" | "REJECT";
            /** @enum {string} */
            stage: "MAKER" | "CHECKER";
            /** Format: uuid */
            actorId: string;
            /** Format: uuid */
            makerDecisionId?: string;
            configurationVersion: components["schemas"]["VersionedReference"];
            reasonVi: string;
            contractClause: components["schemas"]["ContractClause"];
            /** Format: date-time */
            decidedAt: string;
            auditProof: components["schemas"]["AuditProof"];
        };
        /** @description Authorized receipt staff physically verifies receipt and immutable CLEAN evidence linked to claim/member. Tracking alone insufficient. Server records receiver/time; missing/mismatched evidence 422. */
        OriginalReceiptRequest: {
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            eob: components["schemas"]["EobBinding"];
            receivedDocumentIds: string[];
            receiptEvidence: components["schemas"]["VersionedReference"];
            trackingCode?: string;
        };
        OriginalReceipt: {
            /** Format: uuid */
            receiptId: string;
            /** Format: uuid */
            claimId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            eob: components["schemas"]["EobBinding"];
            receivedDocumentIds: string[];
            receiptEvidence: components["schemas"]["VersionedReference"];
            /** Format: uuid */
            receivedBy: string;
            /** Format: date-time */
            receivedAt: string;
            /** @enum {string} */
            status: "RECEIVED";
            auditProof: components["schemas"]["AuditProof"];
        };
        /** @description Core derives immutable amount/currency/payee from current approved EOB and authorized payee snapshot. Caller cannot assert bank/amount. Lock/check valid signature, required maker-checker/originals, reservations and funds. Semantic key uniqueness outlives transport key. UNKNOWN blocks new payout; failed retry only after definitive non-success evidence. */
        PaymentIntentRequest: {
            /** Format: uuid */
            claimId: string;
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            eob: components["schemas"]["EobBinding"];
            /** Format: uuid */
            signatureId: string;
            approvalDecisionIds: string[];
            /** Format: uuid */
            originalReceiptId?: string;
            reservationIds: string[];
            payeeSnapshot: components["schemas"]["VersionedReference"];
            semanticPayoutKey: components["schemas"]["IdempotencyKeyValue"];
        };
        /** @enum {string} */
        PaymentStatus: "CREATED" | "SUBMITTED" | "UNKNOWN" | "SUCCEEDED" | "FAILED";
        /** @description CREATED -> SUBMITTED -> SUCCEEDED|FAILED|UNKNOWN. Timeout UNKNOWN never blind retry. Only authenticated evidence-backed callback/query/reconciliation resolves UNKNOWN. PAID only after definitive success with balanced journal + audit + reservation consumption + outbox atomically. POSTED journals immutable, corrections only by new balanced reversal referencing original; no UPDATE/DELETE. Payee/amount locked after approval/submission. */
        PaymentIntent: {
            /**
             * Format: uuid
             * @description Server-created stable non-PII identifier of the applicable payment attempt. Returned by authorized payment reads for every state after CREATED; use this exact reference in reconciliation. Never regenerate it on retries or UNKNOWN timeout. Core verifies it belongs to this payment and current obligation; stale or mismatched attempt returns 409 STALE_VERSION.
             */
            attemptId?: string;
            /** Format: uuid */
            paymentId: string;
            /** Format: uuid */
            claimId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            eob: components["schemas"]["EobBinding"];
            amount: components["schemas"]["Money"];
            /** @enum {string} */
            currency: "VND";
            payeeSnapshot: components["schemas"]["VersionedReference"];
            semanticPayoutKey: components["schemas"]["IdempotencyKeyValue"];
            status: components["schemas"]["PaymentStatus"];
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            /** Format: uuid */
            journalId?: string;
            auditProof: components["schemas"]["AuditProof"];
        } & ({
            /** @enum {string} */
            status?: "CREATED";
        } | {
            /** Format: uuid */
            attemptId: string;
            /** @enum {string} */
            status?: "SUBMITTED" | "UNKNOWN" | "SUCCEEDED" | "FAILED";
        });
        /** @description Generic internal adapter contract, NOT bank wire format. Verified service maps payment/attempt to tenant and verifies evidence against submitted amount/payee/semantic key. No caller tenant/raw bank/PII. Stale/out-of-order/conflicting terminal updates 409 then reconcile; never downgrade success. Actual bank contract pending. */
        PaymentCallback: {
            /** @enum {string} */
            schemaVersion: "1.0.0";
            /** Format: uuid */
            eventId: string;
            /** Format: uuid */
            paymentId: string;
            /** Format: uuid */
            attemptId: string;
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            /** Format: date-time */
            occurredAt: string;
            /** @enum {string} */
            status: "SUCCEEDED" | "FAILED" | "UNKNOWN";
            evidenceReference: string;
        };
        /** @description Commit durable inbox/dedup, status/audit/outbox and journal if applicable before ack. Valid identical replay no repeated side effects; changed body 409. No exactly-once promise. */
        PaymentAcknowledgement: {
            /** Format: uuid */
            eventId: string;
            /** Format: uuid */
            paymentId: string;
            /** @enum {string} */
            disposition: "ACCEPTED" | "DUPLICATE";
        };
        /** @description Finance MFA; independently verify immutable authorized evidence against provider, attempt, amount/payee and obligation. Caller assertion alone cannot settle; unresolved remains UNKNOWN, never resubmit blindly. */
        ReconciliationRequest: {
            /** Format: uuid */
            paymentId: string;
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            eob: components["schemas"]["EobBinding"];
            /** Format: uuid */
            attemptId: string;
            evidenceDocument: components["schemas"]["VersionedReference"];
            /** @enum {string} */
            observedStatus: "SUCCEEDED" | "FAILED" | "UNKNOWN";
            reasonVi: string;
        };
        ReconciliationRecord: {
            /** Format: uuid */
            reconciliationId: string;
            /** Format: uuid */
            paymentId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            evidenceDocument: components["schemas"]["VersionedReference"];
            resolvedStatus: components["schemas"]["PaymentStatus"];
            /** Format: date-time */
            recordedAt: string;
            /** Format: uuid */
            recordedBy: string;
            auditProof: components["schemas"]["AuditProof"];
        };
        /** @description Only these query fields. Reject tenant/DSL/PII/sort/unknown fields 422. HTTP adapter deliberately parses integer limit before validation; validator never coerces. */
        ClaimSearchQuery: {
            status?: components["schemas"]["ClaimStatus"];
            benefitType?: components["schemas"]["BenefitType"];
            cursor?: string;
            /** @default 20 */
            limit: number;
        };
        /** @description Minimal projection allowlist, no names/CCCD/phone/bank/documents/diagnosis/raw OCR/XML. No monetary aggregation; PostgreSQL business truth. */
        ClaimSearchHit: {
            /** Format: uuid */
            claimId: string;
            status: components["schemas"]["ClaimStatus"];
            benefitType: components["schemas"]["BenefitType"];
            aggregateVersion: components["schemas"]["VersionNumber"];
            /** Format: date-time */
            updatedAt: string;
        };
        ClaimSearchPage: {
            items: components["schemas"]["ClaimSearchHit"][];
            nextCursor?: string;
            /** Format: date-time */
            indexedAt: string;
            /** @enum {string} */
            consistency: "EVENTUAL";
        };
        /** @description Fixed column allowlist, no PII/tenant/DSL. Verify each payment at creation/execution/download. Neutralize CSV formulas =,+,-,@ after leading whitespace/control, quote/escape CSV and force XLSX text cells. Money exact decimal text; no bank T+N scheduling promise. */
        PaymentExportRequest: {
            /** @enum {string} */
            format: "CSV" | "XLSX";
            paymentIds: string[];
            columns: ("paymentId" | "claimId" | "status" | "amount" | "currency" | "updatedAt")[];
        };
        ExportJobPending: {
            /** Format: uuid */
            exportId: string;
            /** @enum {string} */
            status: "PENDING";
            statusUrl: string;
            /** Format: date-time */
            createdAt: string;
        };
        /** @description Private signed URL TTL <=300s, no-store, no logs/events/history. Revalidate membership/object permission; use authorized download gateway if storage cannot enforce revocation. */
        ExportJobReady: {
            /** Format: uuid */
            exportId: string;
            /** @enum {string} */
            status: "READY";
            /** Format: uri */
            downloadUrl: string;
            /** Format: date-time */
            expiresAt: string;
            sha256: components["schemas"]["Hash"];
        };
        ExportJobFailed: {
            /** Format: uuid */
            exportId: string;
            /** @enum {string} */
            status: "FAILED";
            error: components["schemas"]["ApiError"];
        };
        ExportJob: components["schemas"]["ExportJobPending"] | components["schemas"]["ExportJobReady"] | components["schemas"]["ExportJobFailed"];
        /** @description Assigned reviewer creates tenant-scoped proposal with immutable provenance, never direct global catalog update. Global curator authority separate; no caller global scope. */
        CatalogProposalRequest: {
            /** Format: uuid */
            claimId: string;
            /** Format: uuid */
            lineId: string;
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            eob: components["schemas"]["EobBinding"];
            expectedCatalogVersion: components["schemas"]["VersionedReference"];
            /** @enum {string} */
            proposedCategory: "DRUG" | "SUPPLEMENT_TPCN" | "COSMETIC" | "LAB_TEST" | "CONSULTATION";
            evidenceIds: string[];
            contractClause: components["schemas"]["ContractClause"];
            reasonVi: string;
        };
        CatalogProposal: {
            /** Format: uuid */
            proposalId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            /** Format: uuid */
            proposerId: string;
            /** @enum {string} */
            scope: "TENANT";
            proposal: components["schemas"]["CatalogProposalRequest"];
            /** @enum {string} */
            status: "PENDING" | "APPROVED" | "REJECTED";
            /** Format: date-time */
            createdAt: string;
            auditProof: components["schemas"]["AuditProof"];
        };
        /** @description Reviewer differs from proposer. Verify tenant authority or separately provisioned global curator authority; tenant membership never grants global writes. Stale proposal/catalog 409. Approval creates new scoped version; immutable cited versions unchanged. */
        CatalogReviewRequest: {
            expectedAggregateVersion: components["schemas"]["VersionNumber"];
            expectedCatalogVersion: components["schemas"]["VersionedReference"];
            /** @enum {string} */
            decision: "APPROVE" | "REJECT";
            reasonVi: string;
        };
        CatalogReview: {
            /** Format: uuid */
            reviewId: string;
            /** Format: uuid */
            proposalId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            /** Format: uuid */
            reviewerId: string;
            /** @enum {string} */
            decision: "APPROVE" | "REJECT";
            reasonVi: string;
            /** Format: date-time */
            reviewedAt: string;
            resultingCatalogVersion?: components["schemas"]["VersionedReference"];
            auditProof: components["schemas"]["AuditProof"];
        };
        /** @description Internal outbox envelope only, tenantId derived by trusted core. No public tenant selector. Minimal non-PII payload; partition by tenantId:aggregateId, consumer inbox dedup and aggregate version ordering/gap reconciliation required. No exactly-once promise. */
        EobPublishedEvent: {
            /** Format: uuid */
            eventId: string;
            /** @enum {string} */
            eventType: "eob.published";
            /** @enum {string} */
            schemaVersion: "1.0.0";
            /** Format: uuid */
            tenantId: string;
            /** Format: uuid */
            aggregateId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            /** Format: date-time */
            occurredAt: string;
            /** Format: uuid */
            correlationId: string;
            /** Format: uuid */
            causationId: string;
            payload: {
                eob: components["schemas"]["EobBinding"];
                /** Format: uuid */
                calculationRunId: string;
            };
        };
        /** @description Internal outbox envelope only, tenantId derived by trusted core. No public tenant selector. Minimal non-PII payload; partition by tenantId:aggregateId, consumer inbox dedup and aggregate version ordering/gap reconciliation required. No exactly-once promise. */
        PaymentStatusChangedEvent: {
            /** Format: uuid */
            eventId: string;
            /** @enum {string} */
            eventType: "payment.status-changed";
            /** @enum {string} */
            schemaVersion: "1.0.0";
            /** Format: uuid */
            tenantId: string;
            /** Format: uuid */
            aggregateId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            /** Format: date-time */
            occurredAt: string;
            /** Format: uuid */
            correlationId: string;
            /** Format: uuid */
            causationId: string;
            payload: {
                status: components["schemas"]["PaymentStatus"];
            };
        };
        /** @description Internal outbox envelope only, tenantId derived by trusted core. No public tenant selector. Minimal non-PII payload; partition by tenantId:aggregateId, consumer inbox dedup and aggregate version ordering/gap reconciliation required. No exactly-once promise. */
        CatalogProposalReviewedEvent: {
            /** Format: uuid */
            eventId: string;
            /** @enum {string} */
            eventType: "catalog.proposal-reviewed";
            /** @enum {string} */
            schemaVersion: "1.0.0";
            /** Format: uuid */
            tenantId: string;
            /** Format: uuid */
            aggregateId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            /** Format: date-time */
            occurredAt: string;
            /** Format: uuid */
            correlationId: string;
            /** Format: uuid */
            causationId: string;
            payload: {
                /** @enum {string} */
                decision: "APPROVE" | "REJECT";
                catalogVersion?: components["schemas"]["VersionedReference"];
            };
        };
        /** @description Approved immutable configuration snapshot; no default thresholds/periods. Optional rules absent means unspecified, not zero/unlimited/waived. Server requires complete applicable contract terms before publication; missing terms require review. Rule order contains approved stable rule identifiers; shadow is deployment default until explicit tenant/plan approval. */
        BenefitConfiguration: {
            /** @enum {string} */
            stpExecutionMode: "SHADOW" | "ENABLED" | "DISABLED";
            ruleOrder: string[];
            maxVisitsPerYear?: number;
            waitingDaysMaternity?: number;
            maxPrescriptionDays?: number;
            stpAutoApproveLimit?: components["schemas"]["Money"];
            dualApprovalThreshold?: components["schemas"]["Money"];
            originalDocumentsThreshold?: components["schemas"]["Money"];
        };
        /** @enum {string} */
        WorkspaceOrgType: "INSURER" | "TPA_OPERATOR" | "CORPORATE_CLIENT";
        /** @description Server trims and NFC-normalizes before validation; no markup characters or control characters. */
        WorkspaceDisplayName: string;
        WorkspaceShortName: string;
        /** @description Assigned by TPA operations (decided OD-02); globally unique, routing-only, never proof of access. Uniqueness is enforced server-side (422 DOMAIN_VIOLATION). */
        WorkspaceSlug: string;
        /** @description Optional plain text; line breaks allowed. Organisation data only (P0), no personal data. */
        WorkspaceDescription: string;
        /** @description Closed allowlist only; no CSS, font, HTML or URL. Contrast never rejects (decided OD-WS1). */
        WorkspaceTheme: {
            primaryColor: string;
            /** @enum {string} */
            radius: "NONE" | "SM" | "MD" | "LG";
            /** @enum {string} */
            mode: "LIGHT" | "DARK";
            /** @enum {string} */
            sidebarStyle: "LIGHT" | "BRAND";
        };
        /** @description TPA operations only (decided OD-05). initialAdminPrincipalId must be an existing verified principal and receives WORKSPACE_ADMIN. Absent theme means the platform default theme. No tenant ID field. */
        WorkspaceCreateRequest: {
            displayName: components["schemas"]["WorkspaceDisplayName"];
            shortName: components["schemas"]["WorkspaceShortName"];
            slug: components["schemas"]["WorkspaceSlug"];
            orgType: components["schemas"]["WorkspaceOrgType"];
            description?: components["schemas"]["WorkspaceDescription"];
            theme?: components["schemas"]["WorkspaceTheme"];
            /** Format: uuid */
            initialAdminPrincipalId: string;
        };
        /** @description Full replacement; absent description clears it. Slug is not editable here (decided OD-02). */
        WorkspaceProfileUpdateRequest: {
            expectedVersion: components["schemas"]["VersionNumber"];
            displayName: components["schemas"]["WorkspaceDisplayName"];
            shortName: components["schemas"]["WorkspaceShortName"];
            orgType: components["schemas"]["WorkspaceOrgType"];
            description?: components["schemas"]["WorkspaceDescription"];
        };
        WorkspaceThemeUpdateRequest: {
            expectedVersion: components["schemas"]["VersionNumber"];
            theme: components["schemas"]["WorkspaceTheme"];
        };
        WorkspaceLogoActivateRequest: {
            expectedVersion: components["schemas"]["VersionNumber"];
            /** Format: uuid */
            logoAssetId: string;
        };
        WorkspaceLogoClearRequest: {
            expectedVersion: components["schemas"]["VersionNumber"];
            /** @enum {boolean} */
            clear: true;
        };
        WorkspaceLogoSetRequest: components["schemas"]["WorkspaceLogoActivateRequest"] | components["schemas"]["WorkspaceLogoClearRequest"];
        /**
         * @description SVG is never accepted because it can carry executable content.
         * @enum {string}
         */
        WorkspaceLogoMime: "image/png" | "image/jpeg" | "image/webp";
        /** @description Active re-encoded derivative. Private signed preview URL expires in at most 300 seconds; never logged or put in events. */
        WorkspaceLogo: {
            /** Format: uuid */
            assetId: string;
            mime: components["schemas"]["WorkspaceLogoMime"];
            width: number;
            height: number;
            /** Format: uri */
            previewUrl: string;
            /** Format: date-time */
            previewUrlExpiresAt: string;
        };
        /** @description Absent description or logo means none. No tenant ID is exposed. */
        Workspace: {
            /** Format: uuid */
            workspaceId: string;
            slug: components["schemas"]["WorkspaceSlug"];
            displayName: components["schemas"]["WorkspaceDisplayName"];
            shortName: components["schemas"]["WorkspaceShortName"];
            orgType: components["schemas"]["WorkspaceOrgType"];
            description?: components["schemas"]["WorkspaceDescription"];
            theme: components["schemas"]["WorkspaceTheme"];
            logo?: components["schemas"]["WorkspaceLogo"];
            version: components["schemas"]["VersionNumber"];
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
        };
        /** @description Advisory only (decided OD-WS1); the mutation is committed. */
        WorkspaceWarning: {
            /** @enum {string} */
            code: "LOW_SURFACE_CONTRAST";
            messageVi: string;
            contrastRatio: number;
        };
        WorkspaceResult: {
            workspace: components["schemas"]["Workspace"];
            warnings: components["schemas"]["WorkspaceWarning"][];
        };
        /** @description 2 MiB raw technical maximum; no file name or object key accepted. */
        WorkspaceLogoUploadRequest: {
            contentType: components["schemas"]["WorkspaceLogoMime"];
            sizeBytes: number;
            sha256: components["schemas"]["Hash"];
        };
        WorkspaceLogoUploadHeaders: {
            "Content-Type": components["schemas"]["WorkspaceLogoMime"];
            "x-amz-checksum-sha256": string;
        };
        /** @description Expires in at most 300 seconds; private quarantine location; URL/header secrets never logged. */
        WorkspaceLogoUploadGrant: {
            /** Format: uuid */
            assetId: string;
            /** Format: uri */
            uploadUrl: string;
            /** @enum {string} */
            method: "PUT";
            /** Format: date-time */
            expiresAt: string;
            requiredHeaders: components["schemas"]["WorkspaceLogoUploadHeaders"];
        };
        WorkspaceLogoAssetPending: {
            /** Format: uuid */
            assetId: string;
            /** @enum {string} */
            state: "PENDING_UPLOAD" | "PROCESSING";
            /** Format: date-time */
            createdAt: string;
        };
        WorkspaceLogoAssetReady: {
            /** Format: uuid */
            assetId: string;
            /** @enum {string} */
            state: "READY";
            mime: components["schemas"]["WorkspaceLogoMime"];
            width: number;
            height: number;
            /** Format: date-time */
            createdAt: string;
        };
        WorkspaceLogoAssetRejected: {
            /** Format: uuid */
            assetId: string;
            /** @enum {string} */
            state: "REJECTED";
            /** @enum {string} */
            rejectionCode: "SVG_NOT_ALLOWED" | "UNSUPPORTED_TYPE" | "TYPE_MISMATCH" | "CHECKSUM_MISMATCH" | "TOO_LARGE" | "DIMENSIONS_OUT_OF_RANGE" | "ASPECT_RATIO_OUT_OF_RANGE" | "DECODE_FAILED" | "SCAN_FAILED";
            /** Format: date-time */
            createdAt: string;
        };
        WorkspaceLogoAsset: components["schemas"]["WorkspaceLogoAssetPending"] | components["schemas"]["WorkspaceLogoAssetReady"] | components["schemas"]["WorkspaceLogoAssetRejected"];
        /** @description Internal outbox envelope; tenantId derived by trusted core, aggregateId is the workspaceId. Payload carries no names, slugs, colours, images or URLs; consumers reload the authorized resource. Inbox dedup and aggregate version ordering required. */
        WorkspaceChangedEvent: {
            /** Format: uuid */
            eventId: string;
            /** @enum {string} */
            eventType: "workspace.changed";
            /** @enum {string} */
            schemaVersion: "1.0.0";
            /** Format: uuid */
            tenantId: string;
            /** Format: uuid */
            aggregateId: string;
            aggregateVersion: components["schemas"]["VersionNumber"];
            /** Format: date-time */
            occurredAt: string;
            /** Format: uuid */
            correlationId: string;
            /** Format: uuid */
            causationId: string;
            payload: {
                /** @enum {string} */
                changeKind: "CREATED" | "PROFILE" | "THEME" | "LOGO";
            };
        };
    };
    responses: {
        /** @description Missing/invalid/expired authentication or service signature */
        Error401: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error401"];
            };
        };
        /** @description Authenticated principal lacks action permission */
        Error403: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error403"];
            };
        };
        /** @description Missing or inaccessible object; conceal cross-tenant existence */
        Error404: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error404"];
            };
        };
        /** @description Stale version, idempotency mismatch or in-progress operation */
        Error409: {
            headers: {
                /** @description Seconds before retry when retryable; omit for payload/stale conflicts */
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error409"];
            };
        };
        /** @description Invalid schema/domain/ownership/scan state; no raw input echoed */
        Error422: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error422"];
            };
        };
        /** @description Rate limited */
        Error429: {
            headers: {
                /** @description Seconds before retry when retryable; omit for payload/stale conflicts */
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error429"];
            };
        };
        /** @description Dependency unavailable or provider not configured; no false success */
        Error503: {
            headers: {
                /** @description Seconds before retry when retryable; omit for payload/stale conflicts */
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["Error503"];
            };
        };
    };
    parameters: {
        /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
        IdempotencyKey: components["schemas"]["IdempotencyKeyValue"];
        /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
        MembershipContext: string;
        /** @description Opaque workspace identifier; never a tenant ID. Authorization is checked against the verified membership context. */
        WorkspaceId: string;
        LogoAssetId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    exchangeZaloIdentity: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ZaloExchange"];
            };
        };
        responses: {
            /** @description Successful response */
            200: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthSession"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful response */
            200: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Me"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getMemberships: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful response */
            200: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Me"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    selectMembership: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MembershipSelection"];
            };
        };
        responses: {
            /** @description Successful response */
            200: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MembershipContext"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    recordConsent: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ConsentRequest"];
            };
        };
        responses: {
            /** @description Successful response */
            201: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConsentRecord"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getECard: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                memberId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful response */
            200: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ECard"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    presignUpload: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UploadRequest"];
            };
        };
        responses: {
            /** @description Successful response */
            200: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadGrant"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    completeUpload: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                uploadId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UploadComplete"];
            };
        };
        responses: {
            /** @description Successful response */
            202: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    /** @description Seconds before polling */
                    "Retry-After"?: number;
                    /** @description Authorized status resource */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Document"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getDocument: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                documentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful response */
            200: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Document"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    preflightClaim: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PreflightRequest"];
            };
        };
        responses: {
            /** @description Successful response */
            200: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PreflightCompleted"];
                };
            };
            /** @description Durably scheduled; poll statusUrl. Retry-After seconds. */
            202: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    /** @description Seconds before polling */
                    "Retry-After"?: number;
                    /** @description Authorized status resource */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PreflightPending"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getPreflight: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                preflightId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful response */
            200: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PreflightStatus"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    listClaims: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                status?: components["schemas"]["ClaimStatus"];
                memberId?: string;
            };
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful response */
            200: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClaimList"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    submitClaim: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ClaimSubmit"];
            };
        };
        responses: {
            /** @description Successful response */
            201: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClaimSummary"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getClaim: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                claimId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful response */
            200: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClaimDetail"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    supplementClaim: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                claimId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ClaimSupplement"];
            };
        };
        responses: {
            /** @description Successful response */
            200: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClaimDetail"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    receiveAiResult: {
        parameters: {
            query?: never;
            header: {
                "X-Signature-HMAC": string;
                "X-Event-Id": string;
                "X-Signature-Timestamp": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AiResult"];
            };
        };
        responses: {
            /** @description Successful response */
            200: {
                headers: {
                    /** @description Must be no-store for sensitive data */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AiAcknowledgement"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    createPolicyVersion: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                policyId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PolicyVersionInput"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyVersion"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getPolicyVersion: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                policyId: string;
                versionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorized committed result */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PolicyVersion"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    createBenefitRuleVersion: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                planId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BenefitRuleVersionInput"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BenefitRuleVersion"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getBenefitRuleVersion: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                planId: string;
                versionId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorized committed result */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BenefitRuleVersion"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    calculateClaim: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                claimId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CalculationRequest"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CalculationRun"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getCalculationRun: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                claimId: string;
                calculationRunId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorized committed result */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CalculationRun"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getEob: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                claimId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorized committed result */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExplainableEOBResponse"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    publishEob: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                claimId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PublishEobRequest"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExplainableEOBResponse"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    decideClaimLine: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                claimId: string;
                lineId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LineDecisionRequest"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LineDecisionResult"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    createOtpChallenge: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                claimId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OtpChallengeRequest"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OtpChallenge"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    verifyEobOtp: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                claimId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OtpVerifyRequest"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EobSignature"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getEobSignature: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                claimId: string;
                signatureId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorized committed result */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EobSignature"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    decideInsurerApproval: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                claimId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InsurerDecisionRequest"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InsurerDecision"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    receiveOriginalDocuments: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                claimId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OriginalReceiptRequest"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OriginalReceipt"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    createPaymentIntent: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PaymentIntentRequest"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaymentIntent"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getPaymentIntent: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                paymentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorized committed result */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaymentIntent"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    receivePaymentCallback: {
        parameters: {
            query?: never;
            header: {
                "X-Signature-HMAC": string;
                "X-Event-Id": string;
                "X-Signature-Timestamp": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PaymentCallback"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaymentAcknowledgement"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    recordPaymentReconciliation: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReconciliationRequest"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReconciliationRecord"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    searchClaims: {
        parameters: {
            query?: {
                /** @description Exploded allowlisted query fields; reject all other query keys. */
                filters?: components["schemas"]["ClaimSearchQuery"];
            };
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorized committed result */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClaimSearchPage"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    createPaymentExport: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PaymentExportRequest"];
            };
        };
        responses: {
            /** @description Durably scheduled; poll authorized status */
            202: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    /** @description Authorized status resource */
                    Location?: string;
                    /** @description Poll interval seconds */
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExportJobPending"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getPaymentExport: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                exportId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorized committed result */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExportJob"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    createCatalogProposal: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CatalogProposalRequest"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogProposal"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getCatalogProposal: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                proposalId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorized committed result */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogProposal"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    reviewCatalogProposal: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                proposalId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CatalogReviewRequest"];
            };
        };
        responses: {
            /** @description Authorized committed result */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogReview"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    createWorkspace: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceCreateRequest"];
            };
        };
        responses: {
            /** @description Workspace committed with profile, theme and first administrator grant */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceResult"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getWorkspace: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                /** @description Opaque workspace identifier; never a tenant ID. Authorization is checked against the verified membership context. */
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current workspace */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Workspace"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    updateWorkspaceProfile: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                /** @description Opaque workspace identifier; never a tenant ID. Authorization is checked against the verified membership context. */
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceProfileUpdateRequest"];
            };
        };
        responses: {
            /** @description Profile committed with incremented version */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceResult"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    updateWorkspaceTheme: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                /** @description Opaque workspace identifier; never a tenant ID. Authorization is checked against the verified membership context. */
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceThemeUpdateRequest"];
            };
        };
        responses: {
            /** @description Theme committed; warnings are advisory */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceResult"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    setWorkspaceLogo: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                /** @description Opaque workspace identifier; never a tenant ID. Authorization is checked against the verified membership context. */
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceLogoSetRequest"];
            };
        };
        responses: {
            /** @description Logo selection committed with incremented version */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceResult"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    createWorkspaceLogoUpload: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                /** @description Opaque workspace identifier; never a tenant ID. Authorization is checked against the verified membership context. */
                workspaceId: components["parameters"]["WorkspaceId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceLogoUploadRequest"];
            };
        };
        responses: {
            /** @description Upload grant for a PENDING_UPLOAD asset */
            201: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceLogoUploadGrant"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    getWorkspaceLogoAsset: {
        parameters: {
            query?: never;
            header: {
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                /** @description Opaque workspace identifier; never a tenant ID. Authorization is checked against the verified membership context. */
                workspaceId: components["parameters"]["WorkspaceId"];
                assetId: components["parameters"]["LogoAssetId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current asset state */
            200: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceLogoAsset"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
    completeWorkspaceLogoUpload: {
        parameters: {
            query?: never;
            header: {
                /** @description Durable scope: verified tenant/membership + actor + operation + key; >=24h retention. Same payload replays original; mismatch/in-progress 409. Never log secrets. */
                "Idempotency-Key": components["parameters"]["IdempotencyKey"];
                /** @description Opaque server-issued context from membership selection. Verify binding to current principal, active grant and expiry; never accept tenant IDs. */
                "X-Membership-Context": components["parameters"]["MembershipContext"];
            };
            path: {
                /** @description Opaque workspace identifier; never a tenant ID. Authorization is checked against the verified membership context. */
                workspaceId: components["parameters"]["WorkspaceId"];
                assetId: components["parameters"]["LogoAssetId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Accepted for asynchronous processing */
            202: {
                headers: {
                    /** @description Sensitive response */
                    "Cache-Control"?: "no-store";
                    /** @description Logo asset status resource */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceLogoAsset"];
                };
            };
            401: components["responses"]["Error401"];
            403: components["responses"]["Error403"];
            404: components["responses"]["Error404"];
            409: components["responses"]["Error409"];
            422: components["responses"]["Error422"];
            429: components["responses"]["Error429"];
            503: components["responses"]["Error503"];
        };
    };
}
