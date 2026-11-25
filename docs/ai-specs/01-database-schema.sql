-- BASELINE ONLY: chưa phải schema production hoàn chỉnh.
-- Bắt buộc bổ sung migrations/RLS/constraints/versioning theo 07-domain-data-and-api-requirements.md
-- và nghiệm thu theo 08-delivery-and-acceptance.md trước khi dùng dữ liệu thật.
-- PostgreSQL 16+ Schema for MPS Health & Life TPA Platform (Phase 1 & Ready for Scale)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =====================================================================
-- 1. MULTI-TENANT & HỢP ĐỒNG BẢO HIỂM
-- =====================================================================
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) UNIQUE NOT NULL,              -- VD: 'PVI', 'BAOMINH'
    name VARCHAR(255) NOT NULL,
    zalo_oa_id VARCHAR(100),
    branding_config JSONB DEFAULT '{}'::jsonb,     -- White-label logo, primary color
    float_account_balance NUMERIC(15,2) DEFAULT 0.00 NOT NULL,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE benefit_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    plan_code VARCHAR(50) NOT NULL,
    plan_name VARCHAR(255) NOT NULL,
    contract_doc_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    UNIQUE(tenant_id, plan_code)
);

CREATE TABLE benefit_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    plan_id UUID NOT NULL REFERENCES benefit_plans(id),
    benefit_type VARCHAR(50) NOT NULL,             -- 'OUTPATIENT', 'INPATIENT', 'DENTAL', 'MATERNITY', 'ACCIDENT', 'HOSPITAL_INCOME'
    annual_limit NUMERIC(15,2) NOT NULL,
    per_visit_limit NUMERIC(15,2),
    max_visits_per_year INT,
    copay_insurer_pct NUMERIC(5,2) DEFAULT 100.00 NOT NULL,
    deductible_per_claim NUMERIC(15,2) DEFAULT 0.00 NOT NULL,
    waiting_days_normal INT DEFAULT 30 NOT NULL,
    waiting_days_special INT DEFAULT 365 NOT NULL,
    waiting_days_maternity INT DEFAULT 270 NOT NULL,
    max_prescription_days INT DEFAULT 5 NOT NULL,
    stp_auto_approve_limit NUMERIC(15,2) DEFAULT 2000000.00 NOT NULL,
    dual_approval_threshold NUMERIC(15,2) DEFAULT 15000000.00 NOT NULL,
    contract_clause_ref VARCHAR(255) NOT NULL
);

CREATE TABLE insured_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    plan_id UUID NOT NULL REFERENCES benefit_plans(id),
    primary_member_id UUID REFERENCES insured_members(id), -- Cha/me/nguoi giam ho cho tre <18t
    policy_number VARCHAR(100) NOT NULL,
    card_number VARCHAR(100) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    dob DATE NOT NULL,
    cccd_encrypted TEXT NOT NULL,                  -- AES-256-GCM
    cccd_hash VARCHAR(64) NOT NULL,                -- SHA-256 lookup
    phone_encrypted TEXT NOT NULL,                 -- AES-256-GCM
    bank_bin VARCHAR(20),
    bank_account_encrypted TEXT,
    bank_account_holder_name VARCHAR(255),
    effective_from DATE NOT NULL,
    effective_to DATE NOT NULL,
    is_premium_paid BOOLEAN DEFAULT TRUE NOT NULL,
    consent_signed_at TIMESTAMPTZ,                 -- Luat BVDLCN 91/2025
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX idx_members_cccd_hash ON insured_members(tenant_id, cccd_hash);

-- =====================================================================
-- 2. DANH MỤC CƠ SỞ Y TẾ, BỆNH ICD-10 & THUỐC/TPCN
-- =====================================================================
CREATE TABLE providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tax_code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    province_code VARCHAR(20),
    is_electronic_medical_record BOOLEAN DEFAULT FALSE NOT NULL, -- TT 13/2025 (mien dau do)
    direct_billing_surcharge NUMERIC(15,2) DEFAULT 0.00,
    risk_tier VARCHAR(20) DEFAULT 'NORMAL' NOT NULL
);

CREATE TABLE tenant_provider_policies (
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    provider_id UUID NOT NULL REFERENCES providers(id),
    policy_status VARCHAR(30) NOT NULL,            -- 'DIRECT_BILLING', 'REIMBURSEMENT_ONLY', 'BLACKLISTED'
    exclusion_clause_ref VARCHAR(255),
    PRIMARY KEY (tenant_id, provider_id)
);

CREATE TABLE icd10_codes (
    code VARCHAR(20) PRIMARY KEY,
    name_vi VARCHAR(500) NOT NULL,
    is_chronic_special BOOLEAN DEFAULT FALSE NOT NULL -- Benh dac biet/co san cho 365 ngay
);

CREATE TABLE medical_catalog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_code VARCHAR(100) UNIQUE,
    item_name_norm VARCHAR(255) NOT NULL,          -- Lowercase khong dau de fuzzy match
    category VARCHAR(30) NOT NULL,                 -- 'DRUG', 'SUPPLEMENT_TPCN', 'COSMETIC', 'LAB_TEST', 'CONSULTATION'
    is_covered_default BOOLEAN NOT NULL,
    default_exclusion_clause VARCHAR(255),
    reference_unit_price NUMERIC(15,2),
    updated_by VARCHAR(100) DEFAULT 'SYSTEM',
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX idx_catalog_name_trgm ON medical_catalog USING gin (item_name_norm gin_trgm_ops);

-- =====================================================================
-- 3. HỒ SƠ CLAIMS, HÓA ĐƠN XML & PHÁP Y ẢNH (PGVECTOR)
-- =====================================================================
CREATE TABLE claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    claim_code VARCHAR(50) UNIQUE NOT NULL,
    idempotency_key VARCHAR(100) NOT NULL,
    member_id UUID NOT NULL REFERENCES insured_members(id),
    provider_id UUID REFERENCES providers(id),
    claim_channel VARCHAR(30) DEFAULT 'REIMBURSEMENT_ZALO' NOT NULL,
    benefit_type VARCHAR(50) NOT NULL,
    visit_date DATE NOT NULL,
    admit_datetime TIMESTAMPTZ,
    discharge_datetime TIMESTAMPTZ,
    has_surgery_cert BOOLEAN DEFAULT FALSE NOT NULL,
    icd10_code VARCHAR(20) REFERENCES icd10_codes(code),
    diagnosis_text TEXT,
    total_requested NUMERIC(15,2) NOT NULL,
    total_approved NUMERIC(15,2) DEFAULT 0.00 NOT NULL,
    total_rejected NUMERIC(15,2) DEFAULT 0.00 NOT NULL,
    status VARCHAR(40) NOT NULL,
    triage_lane VARCHAR(20),                       -- 'GREEN_STP', 'YELLOW_REVIEW', 'RED_FRAUD'
    fraud_risk_score NUMERIC(5,2) DEFAULT 0.00 NOT NULL,
    requires_original_docs BOOLEAN DEFAULT FALSE NOT NULL, -- Ca >= 20-30 trieu
    original_doc_tracking_code VARCHAR(100),
    workflow_job_id VARCHAR(150),
    sla_deadline_at TIMESTAMPTZ,
    assigned_doctor_id UUID,
    insurer_approved_by UUID,                      -- Dual Approval ca lon
    member_otp_signed_at TIMESTAMPTZ,
    payout_idempotency_key VARCHAR(100) UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    UNIQUE(tenant_id, idempotency_key)
);
CREATE INDEX idx_claims_tenant_status ON claims(tenant_id, status, created_at DESC);

-- Bang Hoa don vat ly toan he thong (Chong nop trung cheo giua cac hang, ho tro Dong bao hiem)
CREATE TABLE e_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_tax_code VARCHAR(30) NOT NULL,
    invoice_serial VARCHAR(30) NOT NULL,
    invoice_number VARCHAR(30) NOT NULL,
    invoice_date DATE NOT NULL,
    buyer_address_type VARCHAR(20) NOT NULL,       -- 'PERSONAL', 'COMPANY'
    total_amount NUMERIC(15,2) NOT NULL,
    is_merged_summary BOOLEAN DEFAULT FALSE NOT NULL, -- TRUE neu la XML gop vien cong
    raw_xml TEXT,
    lookup_url TEXT,
    tax_lookup_status VARCHAR(30) NOT NULL,        -- 'VERIFIED_VALID', 'CANCELLED', 'NOT_FOUND', 'PAPER_BILL_ONLY'
    invoice_unique_hash VARCHAR(64) UNIQUE NOT NULL, -- SHA256(MST|Serial|Number)
    verified_at TIMESTAMPTZ
);

-- Bang phan bo hoa don cho Claim (Cho phep Dong bao hiem 2 hang chia chung 1 hoa don <= 100%)
CREATE TABLE invoice_claim_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    invoice_id UUID NOT NULL REFERENCES e_invoices(id),
    claim_id UUID NOT NULL REFERENCES claims(id),
    allocated_amount NUMERIC(15,2) NOT NULL,
    co_insurance_proof_url TEXT,
    UNIQUE(invoice_id, claim_id)
);

CREATE TABLE claim_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    claim_id UUID NOT NULL REFERENCES claims(id),
    doc_type VARCHAR(30) NOT NULL,                 -- 'INVOICE_PHOTO', 'ITEMIZED_LIST', 'PRESCRIPTION', 'LAB_ORDER', 'LAB_RESULT', 'DISCHARGE_PAPER', 'VNEID_HISTORY'
    s3_object_key TEXT NOT NULL,
    file_sha256 VARCHAR(64) NOT NULL,
    image_phash VARCHAR(64),
    embedding VECTOR(512),
    blur_score NUMERIC(8,2),
    exif_tamper_flag BOOLEAN DEFAULT FALSE NOT NULL,
    has_hospital_stamp BOOLEAN,
    document_date DATE,
    preflight_passed BOOLEAN DEFAULT TRUE NOT NULL,
    preflight_warnings JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX idx_docs_embedding_hnsw ON claim_documents USING hnsw (embedding vector_cosine_ops);

-- =====================================================================
-- 4. BẢNG GIẢI TRÌNH EOB, SỔ CÁI KẾ TOÁN KÉP & AUDIT BẤT BIẾN
-- =====================================================================
CREATE TABLE claim_line_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    claim_id UUID NOT NULL REFERENCES claims(id),
    source_type VARCHAR(20) NOT NULL,              -- 'XML_INVOICE', 'OCR_ITEMIZED_LIST', 'OCR_RECEIPT'
    raw_item_name VARCHAR(255) NOT NULL,
    catalog_id UUID REFERENCES medical_catalog(id),
    item_category VARCHAR(30) NOT NULL,
    quantity NUMERIC(10,2) DEFAULT 1 NOT NULL,
    unit_price NUMERIC(15,2) NOT NULL,
    requested_amount NUMERIC(15,2) NOT NULL,
    approved_amount NUMERIC(15,2) DEFAULT 0.00 NOT NULL,
    rejected_amount NUMERIC(15,2) DEFAULT 0.00 NOT NULL,
    ai_flag VARCHAR(30) DEFAULT 'NONE' NOT NULL,   -- 'NONE', 'TPCN_EXCLUDED', 'PRICE_ANOMALY', 'ICD_MISMATCH'
    decision_status VARCHAR(20) NOT NULL,          -- 'APPROVED', 'PARTIAL', 'REJECTED'
    contract_clause_cited VARCHAR(255),
    explanation_vi TEXT NOT NULL,
    reviewed_by VARCHAR(64) DEFAULT 'RULE_ENGINE' NOT NULL
);

CREATE TABLE float_ledger_entries (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    claim_id UUID REFERENCES claims(id),
    entry_type VARCHAR(30) NOT NULL,               -- 'TOPUP_CREDIT', 'PAYOUT_DEBIT', 'REVERSAL_CREDIT'
    amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
    balance_before NUMERIC(15,2) NOT NULL,
    balance_after NUMERIC(15,2) NOT NULL,
    idempotency_key VARCHAR(100) UNIQUE NOT NULL,
    bank_ref_id VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    tenant_id UUID NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    actor_type VARCHAR(30) NOT NULL,
    actor_id VARCHAR(100) NOT NULL,
    action VARCHAR(50) NOT NULL,
    payload_diff JSONB NOT NULL,
    prev_hash VARCHAR(64) NOT NULL,
    curr_hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Security Violation: audit_logs table is strictly append-only!';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

-- =====================================================================
-- 5. ROW-LEVEL SECURITY (RLS) BẮT BUỘC DÙNG VỚI SET LOCAL
-- =====================================================================
ALTER TABLE benefit_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE benefit_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE insured_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_claim_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE float_ledger_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_benefit_plans ON benefit_plans USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY rls_benefit_rules ON benefit_rules USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY rls_members ON insured_members USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY rls_claims ON claims USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY rls_allocations ON invoice_claim_allocations USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY rls_docs ON claim_documents USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY rls_lines ON claim_line_items USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
CREATE POLICY rls_ledger ON float_ledger_entries USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
