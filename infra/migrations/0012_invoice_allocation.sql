-- BEN-04 (#35): global invoice identity, cross-tenant duplicate check and co-insurance allocation.
-- Spec 03 §3.1 / 07 §2: one physical e-invoice (SHA-256 of MST|Serial|Number) may be shared by several
-- claims only as co-insurance, with SUM(allocated) <= invoice total across ALL tenants.
--
-- REVIEWED PRIVILEGED SURFACE (least privilege):
--  * Global tables tpa.invoice_registry / tpa.invoice_registry_allocations carry no tenant policy, have RLS
--    enabled with NO policy (default deny for non-owners) and NO grant to tpa_app. Only the owner
--    (tpa_migrator) can touch them, and only through the two SECURITY DEFINER functions below.
--  * tpa.invoice_allocate / tpa.invoice_release: SET search_path = pg_catalog, schema-qualified objects,
--    tenant taken from tpa.current_tenant_id() (transaction-local SET LOCAL context; never an argument),
--    EXECUTE revoked from PUBLIC and granted to tpa_app only. They return only an outcome code (and, on a
--    successful allocation, the opaque registry id). They never return other tenants, claims,
--    allocated/remaining amounts or proof data.
--  * Deferred constraint triggers pair every tenant allocation row with its global ledger row at commit,
--    so tpa_app can neither insert/release a tenant row without the global check nor leave an orphan
--    global allocation. Money is NUMERIC(15,2); arithmetic happens only in PostgreSQL. Synthetic data only.
CREATE TABLE tpa.invoice_registry (
  id uuid PRIMARY KEY,
  invoice_hash varchar(64) NOT NULL UNIQUE CHECK (invoice_hash ~ '^[0-9a-f]{64}$'),
  total_amount numeric(15,2) NOT NULL CHECK (total_amount > 0),
  allocated_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (allocated_amount >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_registry_within_total CHECK (allocated_amount <= total_amount)
);
--> statement-breakpoint
CREATE TABLE tpa.invoice_registry_allocations (
  tenant_id uuid NOT NULL, allocation_id uuid NOT NULL,
  registry_id uuid NOT NULL REFERENCES tpa.invoice_registry(id),
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  co_insurance boolean NOT NULL,
  status varchar(16) NOT NULL CHECK (status IN ('ACTIVE','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, allocation_id)
);
--> statement-breakpoint
-- One live allocation per insurer (tenant) per physical invoice.
CREATE UNIQUE INDEX invoice_registry_allocations_one_active ON tpa.invoice_registry_allocations (registry_id, tenant_id) WHERE status = 'ACTIVE';
--> statement-breakpoint
CREATE TABLE tpa.invoice_allocations (
  tenant_id uuid NOT NULL, id uuid NOT NULL, claim_id uuid NOT NULL,
  invoice_registry_id uuid NOT NULL,
  invoice_hash varchar(64) NOT NULL CHECK (invoice_hash ~ '^[0-9a-f]{64}$'),
  invoice_total numeric(15,2) NOT NULL CHECK (invoice_total > 0),
  allocated_amount numeric(15,2) NOT NULL CHECK (allocated_amount > 0 AND allocated_amount <= invoice_total),
  co_insurance boolean NOT NULL,
  proof_document_id uuid,
  proof_document_sha256 varchar(64) CHECK (proof_document_sha256 ~ '^[0-9a-f]{64}$'),
  proof_verified_by uuid,
  status varchar(16) NOT NULL CHECK (status IN ('ACTIVE','RELEASED')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  -- Co-insurance requires complete second-insurer proof evidence; non co-insurance carries none.
  CONSTRAINT invoice_allocations_proof CHECK (
    (co_insurance AND proof_document_id IS NOT NULL AND proof_document_sha256 IS NOT NULL AND proof_verified_by IS NOT NULL)
    OR (NOT co_insurance AND proof_document_id IS NULL AND proof_document_sha256 IS NULL AND proof_verified_by IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX invoice_allocations_one_active ON tpa.invoice_allocations (tenant_id, invoice_registry_id) WHERE status = 'ACTIVE';
--> statement-breakpoint
CREATE INDEX invoice_allocations_claim ON tpa.invoice_allocations (tenant_id, claim_id);
--> statement-breakpoint
-- Semantic idempotency for allocate/release: same key + same request hash replays the stored result.
CREATE TABLE tpa.invoice_allocation_operations (
  tenant_id uuid NOT NULL, operation_key varchar(100) NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9._:-]{16,100}$'),
  operation_type varchar(16) NOT NULL CHECK (operation_type IN ('ALLOCATE','RELEASE')),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_key)
);
--> statement-breakpoint
CREATE FUNCTION tpa.guard_invoice_allocation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Invoice allocation rows cannot be deleted' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME = 'invoice_registry' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.allocated_amount := 0; NEW.version := 1; NEW.created_at := now(); NEW.updated_at := now(); RETURN NEW;
    END IF;
    IF (NEW.id,NEW.invoice_hash,NEW.total_amount,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.invoice_hash,OLD.total_amount,OLD.created_at)
      OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Invoice identity and total are immutable' USING ERRCODE='42501';
    END IF;
    NEW.updated_at := now(); RETURN NEW;
  END IF;
  IF TG_TABLE_NAME IN ('invoice_registry_allocations','invoice_allocations') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'ACTIVE' THEN RAISE EXCEPTION 'Invoice allocations start ACTIVE' USING ERRCODE='23514'; END IF;
      IF TG_TABLE_NAME = 'invoice_allocations' THEN NEW.version := 1; END IF;
      NEW.created_at := now(); NEW.updated_at := now(); RETURN NEW;
    END IF;
    IF OLD.status <> 'ACTIVE' OR NEW.status <> 'RELEASED' THEN
      RAISE EXCEPTION 'Invalid invoice allocation transition' USING ERRCODE='23514';
    END IF;
    IF TG_TABLE_NAME = 'invoice_registry_allocations' THEN
      IF (NEW.tenant_id,NEW.allocation_id,NEW.registry_id,NEW.amount,NEW.co_insurance,NEW.created_at)
        IS DISTINCT FROM (OLD.tenant_id,OLD.allocation_id,OLD.registry_id,OLD.amount,OLD.co_insurance,OLD.created_at) THEN
        RAISE EXCEPTION 'Invoice allocation is immutable' USING ERRCODE='42501';
      END IF;
    ELSIF (NEW.tenant_id,NEW.id,NEW.claim_id,NEW.invoice_registry_id,NEW.invoice_hash,NEW.invoice_total,NEW.allocated_amount,
        NEW.co_insurance,NEW.proof_document_id,NEW.proof_document_sha256,NEW.proof_verified_by,NEW.created_at)
      IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.claim_id,OLD.invoice_registry_id,OLD.invoice_hash,OLD.invoice_total,OLD.allocated_amount,
        OLD.co_insurance,OLD.proof_document_id,OLD.proof_document_sha256,OLD.proof_verified_by,OLD.created_at)
      OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Invoice allocation is immutable' USING ERRCODE='42501';
    END IF;
    NEW.updated_at := now(); RETURN NEW;
  END IF;
  -- invoice_allocation_operations: result is written once, in the inserting transaction.
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); RETURN NEW; END IF;
  IF OLD.result IS NOT NULL OR NEW.result IS NULL
    OR (NEW.tenant_id,NEW.operation_key,NEW.operation_type,NEW.request_hash,NEW.created_at)
      IS DISTINCT FROM (OLD.tenant_id,OLD.operation_key,OLD.operation_type,OLD.request_hash,OLD.created_at) THEN
    RAISE EXCEPTION 'Invoice allocation operation results are immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['invoice_registry','invoice_registry_allocations','invoice_allocations','invoice_allocation_operations'] LOOP
    EXECUTE format('CREATE TRIGGER invoice_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON tpa.%I FOR EACH ROW EXECUTE FUNCTION tpa.guard_invoice_allocation()', tab);
    EXECUTE format('CREATE TRIGGER invoice_allocation_no_truncate BEFORE TRUNCATE ON tpa.%I FOR EACH STATEMENT EXECUTE FUNCTION tpa.guard_invoice_allocation()', tab);
    EXECUTE format('ALTER TABLE tpa.%I ENABLE ROW LEVEL SECURITY', tab);
  END LOOP;
  -- Tenant-owned: FORCE RLS on the transaction tenant. Global: no policy (non-owners see nothing) and no grant.
  FOREACH tab IN ARRAY ARRAY['invoice_allocations','invoice_allocation_operations'] LOOP
    EXECUTE format('ALTER TABLE tpa.%I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON tpa.%I USING (tenant_id = tpa.current_tenant_id()) WITH CHECK (tenant_id = tpa.current_tenant_id())', tab);
    EXECUTE format('GRANT SELECT, INSERT ON tpa.%I TO tpa_app', tab);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON tpa.invoice_registry, tpa.invoice_registry_allocations FROM PUBLIC, tpa_app;
--> statement-breakpoint
GRANT UPDATE (status, version) ON tpa.invoice_allocations TO tpa_app;
--> statement-breakpoint
GRANT UPDATE (result) ON tpa.invoice_allocation_operations TO tpa_app;
--> statement-breakpoint
-- Global check + allocation. Every caller for the same invoice, from any tenant, serializes on the
-- registry row lock. Outcomes: ALLOCATED | DUPLICATE | EXCEEDS_TOTAL | TOTAL_MISMATCH.
CREATE FUNCTION tpa.invoice_allocate(p_invoice_hash text, p_invoice_total numeric, p_allocation_id uuid,
  p_amount numeric, p_co_insurance boolean)
RETURNS TABLE (result_code text, result_registry_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE tenant uuid := tpa.current_tenant_id(); reg tpa.invoice_registry%ROWTYPE; ledger numeric;
BEGIN
  IF p_invoice_hash IS NULL OR p_invoice_hash !~ '^[0-9a-f]{64}$' OR p_allocation_id IS NULL OR p_co_insurance IS NULL
    OR p_invoice_total IS NULL OR p_amount IS NULL OR p_invoice_total <= 0 OR p_amount <= 0
    OR p_invoice_total <> round(p_invoice_total, 2) OR p_amount <> round(p_amount, 2)
    OR p_invoice_total > 9999999999999.99 OR p_amount > p_invoice_total THEN
    RAISE EXCEPTION 'Invalid invoice allocation input' USING ERRCODE='22023';
  END IF;
  INSERT INTO tpa.invoice_registry (id, invoice_hash, total_amount)
    VALUES (gen_random_uuid(), p_invoice_hash, p_invoice_total) ON CONFLICT (invoice_hash) DO NOTHING;
  SELECT * INTO STRICT reg FROM tpa.invoice_registry WHERE invoice_hash = p_invoice_hash FOR UPDATE;
  IF reg.total_amount <> p_invoice_total THEN
    RETURN QUERY SELECT 'TOTAL_MISMATCH'::text, NULL::uuid; RETURN;
  END IF;
  -- Same insurer twice is always a duplicate; another insurer's live allocation needs co-insurance proof.
  IF EXISTS (SELECT 1 FROM tpa.invoice_registry_allocations a WHERE a.registry_id = reg.id AND a.status = 'ACTIVE'
      AND (a.tenant_id = tenant OR NOT p_co_insurance)) THEN
    RETURN QUERY SELECT 'DUPLICATE'::text, NULL::uuid; RETURN;
  END IF;
  UPDATE tpa.invoice_registry r SET allocated_amount = r.allocated_amount + p_amount, version = r.version + 1
    WHERE r.id = reg.id AND r.allocated_amount + p_amount <= r.total_amount;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'EXCEEDS_TOTAL'::text, NULL::uuid; RETURN;
  END IF;
  INSERT INTO tpa.invoice_registry_allocations (tenant_id, allocation_id, registry_id, amount, co_insurance, status)
    VALUES (tenant, p_allocation_id, reg.id, p_amount, p_co_insurance, 'ACTIVE');
  SELECT coalesce(sum(a.amount), 0) INTO ledger FROM tpa.invoice_registry_allocations a WHERE a.registry_id = reg.id AND a.status = 'ACTIVE';
  IF ledger <> (SELECT r.allocated_amount FROM tpa.invoice_registry r WHERE r.id = reg.id) THEN
    RAISE EXCEPTION 'Invoice ledger does not match registry' USING ERRCODE='23514';
  END IF;
  RETURN QUERY SELECT 'ALLOCATED'::text, reg.id;
END $$;
--> statement-breakpoint
-- Releases the calling tenant's own allocation. Outcomes: RELEASED | NOT_ACTIVE | NOT_FOUND.
CREATE FUNCTION tpa.invoice_release(p_allocation_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE tenant uuid := tpa.current_tenant_id(); alloc tpa.invoice_registry_allocations%ROWTYPE; ledger numeric;
BEGIN
  IF p_allocation_id IS NULL THEN RAISE EXCEPTION 'Invalid invoice allocation input' USING ERRCODE='22023'; END IF;
  SELECT * INTO alloc FROM tpa.invoice_registry_allocations a WHERE a.tenant_id = tenant AND a.allocation_id = p_allocation_id;
  IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
  -- Same lock order as allocate: registry row first, then the ledger row.
  PERFORM 1 FROM tpa.invoice_registry r WHERE r.id = alloc.registry_id FOR UPDATE;
  SELECT * INTO STRICT alloc FROM tpa.invoice_registry_allocations a WHERE a.tenant_id = tenant AND a.allocation_id = p_allocation_id FOR UPDATE;
  IF alloc.status <> 'ACTIVE' THEN RETURN 'NOT_ACTIVE'; END IF;
  UPDATE tpa.invoice_registry r SET allocated_amount = r.allocated_amount - alloc.amount, version = r.version + 1
    WHERE r.id = alloc.registry_id AND r.allocated_amount >= alloc.amount;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice ledger does not match registry' USING ERRCODE='23514'; END IF;
  UPDATE tpa.invoice_registry_allocations a SET status = 'RELEASED' WHERE a.tenant_id = tenant AND a.allocation_id = p_allocation_id;
  SELECT coalesce(sum(a.amount), 0) INTO ledger FROM tpa.invoice_registry_allocations a WHERE a.registry_id = alloc.registry_id AND a.status = 'ACTIVE';
  IF ledger <> (SELECT r.allocated_amount FROM tpa.invoice_registry r WHERE r.id = alloc.registry_id) THEN
    RAISE EXCEPTION 'Invoice ledger does not match registry' USING ERRCODE='23514';
  END IF;
  RETURN 'RELEASED';
END $$;
--> statement-breakpoint
-- Commit-time pairing of tenant row <-> global ledger row (both directions). The tenant row is read under
-- FORCE RLS with the still-active transaction tenant context; the ledger row always belongs to that tenant.
CREATE FUNCTION tpa.check_invoice_allocation_pair() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE target uuid;
BEGIN
  -- IF (not CASE): PL/pgSQL resolves every CASE branch against NEW, and each table has only one of these fields.
  IF TG_TABLE_NAME = 'invoice_allocations' THEN target := NEW.id; ELSE target := NEW.allocation_id; END IF;
  IF NOT EXISTS (SELECT 1 FROM tpa.invoice_allocations x
      JOIN tpa.invoice_registry_allocations g ON g.tenant_id = x.tenant_id AND g.allocation_id = x.id
      JOIN tpa.invoice_registry r ON r.id = g.registry_id
      WHERE x.tenant_id = NEW.tenant_id AND x.id = target AND x.invoice_registry_id = g.registry_id
        AND x.invoice_hash = r.invoice_hash AND x.invoice_total = r.total_amount
        AND x.allocated_amount = g.amount AND x.co_insurance = g.co_insurance AND x.status = g.status) THEN
    RAISE EXCEPTION 'Invoice allocation does not match the global invoice ledger' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER invoice_allocation_pair AFTER INSERT OR UPDATE ON tpa.invoice_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tpa.check_invoice_allocation_pair();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER invoice_registry_allocation_pair AFTER INSERT OR UPDATE ON tpa.invoice_registry_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tpa.check_invoice_allocation_pair();
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.guard_invoice_allocation() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.check_invoice_allocation_pair() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.invoice_allocate(text, numeric, uuid, numeric, boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.invoice_release(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tpa.invoice_allocate(text, numeric, uuid, numeric, boolean) TO tpa_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tpa.invoice_release(uuid) TO tpa_app;
