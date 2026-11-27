-- CLM-02 (#37): claim aggregate + immutable document attachments. Technical records only: no PII columns,
-- no raw Idempotency-Key, no storage keys/URLs. Money NUMERIC(15,2); state changes only via expected-version updates.
CREATE TABLE tpa.claims (
 tenant_id uuid NOT NULL, id uuid NOT NULL,
 claim_code varchar(50) NOT NULL CHECK (claim_code ~ '^CLM-[0-9A-F]{20}$'),
 member_id uuid NOT NULL, principal_id uuid NOT NULL, membership_id uuid NOT NULL, consent_id uuid NOT NULL,
 -- SHA-256 of the (operation, actor, key) submission scope: a durable backstop after idempotency retention lapses.
 submission_hash text NOT NULL CHECK (submission_hash ~ '^[0-9a-f]{64}$'),
 benefit_type varchar(40) NOT NULL CHECK (benefit_type IN ('OUTPATIENT','INPATIENT','DENTAL','MATERNITY','ACCIDENT','HOSPITAL_INCOME')),
 visit_date date NOT NULL,
 total_requested numeric(15,2) NOT NULL CHECK (total_requested > 0),
 provider_id uuid, admit_datetime timestamptz, discharge_datetime timestamptz,
 has_surgery_cert boolean NOT NULL DEFAULT false,
 icd10_code varchar(20) CHECK (icd10_code IS NULL OR length(btrim(icd10_code)) BETWEEN 1 AND 20),
 preflight_id uuid NOT NULL, preflight_version integer NOT NULL CHECK (preflight_version > 0),
 status text NOT NULL CHECK (status IN ('PREFLIGHT','SUBMITTED','AI_PROCESSING','GREEN_STP','DOCTOR_REVIEW','FRAUD_HOLD',
   'SUPPLEMENT_REQUIRED','WAITING_ORIGINAL_DOCS','EOB_READY','OTP_SIGNED','PAYOUT_PROCESSING','PAID','REJECTED','CLOSED_EXPIRED')),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 supplement_deadline timestamptz,
 last_command_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,claim_code), UNIQUE (tenant_id,submission_hash),
 FOREIGN KEY (tenant_id,consent_id,member_id,principal_id,membership_id)
   REFERENCES tpa.consent_records(tenant_id,id,member_id,principal_id,membership_id),
 CHECK (discharge_datetime IS NULL OR admit_datetime IS NULL OR discharge_datetime >= admit_datetime),
 CHECK ((status = 'SUPPLEMENT_REQUIRED') = (supplement_deadline IS NOT NULL))
);
CREATE INDEX claims_list_order ON tpa.claims (tenant_id, created_at DESC, id DESC);
CREATE INDEX claims_member_order ON tpa.claims (tenant_id, member_id, created_at DESC, id DESC);
--> statement-breakpoint
-- A document is evidence for exactly one claim; attachments are append-only.
CREATE TABLE tpa.claim_documents (
 tenant_id uuid NOT NULL, claim_id uuid NOT NULL, document_id uuid NOT NULL,
 claim_version integer NOT NULL CHECK (claim_version > 0),
 attached_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (tenant_id,claim_id,document_id), UNIQUE (tenant_id,document_id),
 FOREIGN KEY (tenant_id,claim_id) REFERENCES tpa.claims(tenant_id,id),
 FOREIGN KEY (tenant_id,document_id) REFERENCES tpa.document_versions(tenant_id,id)
);
CREATE TRIGGER claim_documents_immutable BEFORE UPDATE OR DELETE ON tpa.claim_documents FOR EACH ROW EXECUTE FUNCTION tpa.document_immutable();
--> statement-breakpoint
-- Mirror of apps/core-api/src/claims/claim-state.ts CLAIM_TRANSITIONS (PG test asserts equality).
CREATE FUNCTION tpa.claim_transition_allowed(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT EXISTS (SELECT 1 FROM (VALUES
  ('PREFLIGHT','SUBMITTED'),
  ('SUBMITTED','AI_PROCESSING'),
  ('AI_PROCESSING','GREEN_STP'),('AI_PROCESSING','DOCTOR_REVIEW'),('AI_PROCESSING','FRAUD_HOLD'),('AI_PROCESSING','SUPPLEMENT_REQUIRED'),
  ('GREEN_STP','EOB_READY'),('GREEN_STP','DOCTOR_REVIEW'),
  ('DOCTOR_REVIEW','EOB_READY'),('DOCTOR_REVIEW','SUPPLEMENT_REQUIRED'),('DOCTOR_REVIEW','FRAUD_HOLD'),
  ('DOCTOR_REVIEW','WAITING_ORIGINAL_DOCS'),('DOCTOR_REVIEW','REJECTED'),
  ('FRAUD_HOLD','DOCTOR_REVIEW'),('FRAUD_HOLD','REJECTED'),
  ('SUPPLEMENT_REQUIRED','SUBMITTED'),('SUPPLEMENT_REQUIRED','CLOSED_EXPIRED'),
  ('WAITING_ORIGINAL_DOCS','DOCTOR_REVIEW'),('WAITING_ORIGINAL_DOCS','EOB_READY'),('WAITING_ORIGINAL_DOCS','PAYOUT_PROCESSING'),
  ('EOB_READY','OTP_SIGNED'),('EOB_READY','DOCTOR_REVIEW'),
  ('OTP_SIGNED','PAYOUT_PROCESSING'),('OTP_SIGNED','WAITING_ORIGINAL_DOCS'),('OTP_SIGNED','EOB_READY'),
  ('PAYOUT_PROCESSING','PAID')
 ) t(f,s) WHERE t.f=p_from AND t.s=p_to)
$$;
REVOKE ALL ON FUNCTION tpa.claim_transition_allowed(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tpa.claim_transition_allowed(text,text) TO tpa_app;
--> statement-breakpoint
-- Defense in depth below the repository: new claims start SUBMITTED/v1; every update is exactly one allowed
-- transition with version+1; identity, money and evidence columns are immutable; no DELETE/TRUNCATE.
CREATE FUNCTION tpa.claim_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE mutable text[] := ARRAY['status','version','supplement_deadline','last_command_id','updated_at'];
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.status <> 'SUBMITTED' OR NEW.version <> 1 OR NEW.last_command_id IS NOT NULL THEN
   RAISE EXCEPTION 'Claims start SUBMITTED at version 1' USING ERRCODE='23514';
  END IF;
  NEW.created_at := clock_timestamp(); NEW.updated_at := NEW.created_at; RETURN NEW;
 END IF;
 IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Claims are never deleted' USING ERRCODE='42501'; END IF;
 IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
  RAISE EXCEPTION 'Claim submission facts are immutable' USING ERRCODE='42501';
 END IF;
 IF NEW.version <> OLD.version + 1 OR NOT tpa.claim_transition_allowed(OLD.status, NEW.status) THEN
  RAISE EXCEPTION 'Claim transition rejected' USING ERRCODE='23514';
 END IF;
 NEW.updated_at := clock_timestamp(); RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION tpa.claim_guard() FROM PUBLIC;
CREATE TRIGGER claims_guard BEFORE INSERT OR UPDATE OR DELETE ON tpa.claims FOR EACH ROW EXECUTE FUNCTION tpa.claim_guard();
CREATE TRIGGER claims_no_truncate BEFORE TRUNCATE ON tpa.claims FOR EACH STATEMENT EXECUTE FUNCTION tpa.document_immutable();
CREATE TRIGGER claim_documents_no_truncate BEFORE TRUNCATE ON tpa.claim_documents FOR EACH STATEMENT EXECUTE FUNCTION tpa.document_immutable();
--> statement-breakpoint
ALTER TABLE tpa.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.claims FORCE ROW LEVEL SECURITY;
CREATE POLICY claims_tenant ON tpa.claims USING (tenant_id=tpa.current_tenant_id()) WITH CHECK (tenant_id=tpa.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON tpa.claims TO tpa_app;
--> statement-breakpoint
ALTER TABLE tpa.claim_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.claim_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY claim_documents_tenant ON tpa.claim_documents USING (tenant_id=tpa.current_tenant_id()) WITH CHECK (tenant_id=tpa.current_tenant_id());
GRANT SELECT, INSERT ON tpa.claim_documents TO tpa_app;
