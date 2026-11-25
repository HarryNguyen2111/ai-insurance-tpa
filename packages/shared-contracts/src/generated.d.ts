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
    "/v1/claims/{claimId}/eob": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Lay Bang Giai Trinh Quyen Loi (Explainable EOB) cho Zalo Mini App */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    claimId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Bang giai trình tung dong kem dieu khoan trich dan va audit hash */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ExplainableEOBResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
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
        /** Bac si tham dinh dieu chinh/duyet/tu choi 1 dong chi phi (Contract-Locked) */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    claimId: string;
                    lineId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        decisionStatus: "APPROVED" | "PARTIAL" | "REJECTED";
                        /** @example 0.00 */
                        approvedAmount: string;
                        /** @example Dieu 5.3 - Loai tru Thuc pham chuc nang */
                        contractClauseCited: string;
                        explanationVi: string;
                        /** @enum {string} */
                        updateMedicalCatalogAs?: "NONE" | "DRUG" | "SUPPLEMENT_TPCN" | "COSMETIC";
                    };
                };
            };
            responses: {
                /** @description Da cap nhat dong chi phi va ghi noi chuoi Audit Hash */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ExplainableEOBResponse: {
            eobVersion: number;
            eobHash: string;
            /** Format: uuid */
            contractVersionId?: string;
            claimCode: string;
            status: string;
            summary: {
                totalRequested?: string;
                totalApproved?: string;
                totalRejected?: string;
                remainingAnnualLimit?: string;
            };
            lineItems: {
                lineId?: string;
                itemName?: string;
                requested?: string;
                approved?: string;
                rejected?: string;
                status?: string;
                clauseCited?: string;
                explanationVi?: string;
            }[];
            auditProof: {
                hashChainTail?: string;
                contractLocked?: boolean;
            };
        };
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
}
