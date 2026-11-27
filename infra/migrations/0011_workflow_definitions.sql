-- VWF-03 (#80): tenant-owned versioned workflow definitions, scope bindings and pinned
-- executions (spec 14 §3). Definitions/catalog/policy are P0 configuration: no PII.
-- Published content is immutable; executions pin {definition, version, hash, catalog}
-- and are never re-pointed by later versions (VWF-OD-02: no automatic migration).
-- 0010 is reserved for BEN-03 (#34).
CREATE TABLE tpa.workflow_definitions (
  tenant_id uuid NOT NULL, id uuid NOT NULL,
  workflow_key varchar(48) NOT NULL CHECK (workflow_key ~ '^[a-z][a-z0-9_]{2,47}$'),
  aggregate_version integer NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, workflow_key)
);
--> statement-breakpoint
CREATE TABLE tpa.workflow_definition_versions (
  tenant_id uuid NOT NULL, definition_id uuid NOT NULL, version_no integer NOT NULL CHECK (version_no BETWEEN 1 AND 2147483647),
  status varchar(10) NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','RETIRED','REVOKED')),
  revision integer NOT NULL CHECK (revision > 0),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object' AND NOT content ? 'tenantId' AND octet_length(content::text) <= 262144),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  action_catalog_version integer NOT NULL CHECK (action_catalog_version > 0),
  benefit_types text[] NOT NULL CHECK (cardinality(benefit_types) BETWEEN 1 AND 6 AND array_position(benefit_types, NULL) IS NULL
    AND benefit_types <@ ARRAY['OUTPATIENT','INPATIENT','DENTAL','MATERNITY','ACCIDENT','HOSPITAL_INCOME']::text[]),
  -- Opaque principal UUIDs for maker-checker only; never exposed by the API.
  created_by uuid NOT NULL, editor_ids uuid[] NOT NULL CHECK (cardinality(editor_ids) BETWEEN 1 AND 64 AND array_position(editor_ids, NULL) IS NULL),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid, published_at timestamptz, retired_at timestamptz,
  revoked_by uuid, revoked_at timestamptz, revoked_reason varchar(16) CHECK (revoked_reason IN ('DEFECT','POLICY_CHANGE','SECURITY')),
  PRIMARY KEY (tenant_id, definition_id, version_no),
  FOREIGN KEY (tenant_id, definition_id) REFERENCES tpa.workflow_definitions(tenant_id, id),
  CONSTRAINT workflow_version_lifecycle CHECK (
    (status = 'DRAFT' AND published_by IS NULL AND published_at IS NULL AND retired_at IS NULL AND revoked_at IS NULL)
    OR (status = 'PUBLISHED' AND published_by IS NOT NULL AND published_at IS NOT NULL AND retired_at IS NULL AND revoked_at IS NULL)
    OR (status = 'RETIRED' AND published_at IS NOT NULL AND retired_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND published_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)),
  -- VWF-OD-01 fail-closed maker-checker, enforced in the database as well as the service.
  CONSTRAINT workflow_version_maker_checker CHECK (published_by IS NULL OR NOT (published_by = ANY (editor_ids)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_definition_one_draft ON tpa.workflow_definition_versions (tenant_id, definition_id) WHERE status = 'DRAFT';
--> statement-breakpoint
CREATE UNIQUE INDEX workflow_definition_one_published ON tpa.workflow_definition_versions (tenant_id, definition_id) WHERE status = 'PUBLISHED';
--> statement-breakpoint
-- Trusted-provisioner registry of PUBLISHED model/prompt/AI-policy/form versions that
-- definitions may pin. The app role can only read it, so unprovisioned refs fail closed
-- (REFERENCE_NOT_PUBLISHED) until owning modules (#28-#31, #65) publish their versions.
CREATE TABLE tpa.workflow_reference_versions (
  tenant_id uuid NOT NULL, ref_kind varchar(6) NOT NULL CHECK (ref_kind IN ('MODEL','PROMPT','POLICY','FORM')),
  ref_key varchar(64) NOT NULL CHECK (ref_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status varchar(10) NOT NULL CHECK (status IN ('PUBLISHED','REVOKED')),
  PRIMARY KEY (tenant_id, ref_kind, ref_key, version)
);
--> statement-breakpoint
-- At most one PUBLISHED workflow per (tenant, benefit type): AMBIGUOUS_BINDING is also a PK conflict.
CREATE TABLE tpa.workflow_scope_bindings (
  tenant_id uuid NOT NULL, benefit_type varchar(20) NOT NULL CHECK (benefit_type IN ('OUTPATIENT','INPATIENT','DENTAL')),
  definition_id uuid NOT NULL, version_no integer NOT NULL,
  PRIMARY KEY (tenant_id, benefit_type),
  FOREIGN KEY (tenant_id, definition_id, version_no) REFERENCES tpa.workflow_definition_versions(tenant_id, definition_id, version_no)
);
--> statement-breakpoint
CREATE TABLE tpa.workflow_executions (
  tenant_id uuid NOT NULL, id uuid NOT NULL,
  -- CLM-02 (#37) owns the claims table; until then the claim is an opaque reference.
  claim_id uuid NOT NULL,
  definition_id uuid NOT NULL, version_no integer NOT NULL,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  action_catalog_version integer NOT NULL CHECK (action_catalog_version > 0),
  benefit_type varchar(20) NOT NULL CHECK (benefit_type IN ('OUTPATIENT','INPATIENT','DENTAL')),
  -- [{kind,key,version,hash}] only: exact pins of every node reference at bind time.
  pins jsonb NOT NULL CHECK (jsonb_typeof(pins) = 'array' AND jsonb_array_length(pins) <= 200),
  status varchar(10) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUSPENDED','COMPLETED')),
  outcome varchar(24) CHECK (outcome IN ('REVIEW_COMPLETED','ROUTED_TO_MANUAL_REVIEW','SUPPLEMENT_EXPIRED')),
  current_node_id varchar(40) CHECK (current_node_id ~ '^[a-z][a-z0-9_]{1,39}$'),
  step_no integer NOT NULL DEFAULT 0 CHECK (step_no >= 0),
  aggregate_version integer NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, claim_id),
  FOREIGN KEY (tenant_id, definition_id, version_no) REFERENCES tpa.workflow_definition_versions(tenant_id, definition_id, version_no),
  CHECK ((status = 'COMPLETED') = (outcome IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX workflow_executions_by_version ON tpa.workflow_executions (tenant_id, definition_id, version_no, status);
--> statement-breakpoint
-- Activity-side semantic idempotency: one row per applied interpreter step. A repeated
-- Activity execution (retry, crash after commit) conflicts here and is a no-op.
CREATE TABLE tpa.workflow_execution_steps (
  tenant_id uuid NOT NULL, execution_id uuid NOT NULL, step_no integer NOT NULL CHECK (step_no > 0),
  node_id varchar(40) NOT NULL CHECK (node_id ~ '^[a-z][a-z0-9_]{1,39}$'),
  event_kind varchar(24) NOT NULL CHECK (event_kind ~ '^[A-Z][A-Z_]{1,23}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, execution_id, step_no),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES tpa.workflow_executions(tenant_id, id)
);
--> statement-breakpoint
CREATE FUNCTION tpa.guard_workflow_definition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.aggregate_version := 1; NEW.created_at := now(); RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND NEW.tenant_id = OLD.tenant_id AND NEW.id = OLD.id AND NEW.workflow_key = OLD.workflow_key
      AND NEW.created_at = OLD.created_at AND NEW.aggregate_version = OLD.aggregate_version + 1 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Workflow definition identity is immutable' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE FUNCTION tpa.guard_workflow_definition_version() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.revision <> 1 OR NEW.editor_ids <> ARRAY[NEW.created_by] THEN
      RAISE EXCEPTION 'Workflow versions start as DRAFT revision 1' USING ERRCODE = '42501';
    END IF;
    NEW.created_at := now(); NEW.updated_at := now(); RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Workflow versions are never deleted' USING ERRCODE = '42501'; END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.definition_id <> OLD.definition_id OR NEW.version_no <> OLD.version_no
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Workflow version identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
    IF NEW.revision <> OLD.revision + 1 OR NOT (NEW.editor_ids @> OLD.editor_ids) THEN
      RAISE EXCEPTION 'Draft edits advance revision and keep editors' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Content and its provenance are frozen from publication on (also the edge DRAFT -> PUBLISHED).
    IF NEW.content IS DISTINCT FROM OLD.content OR NEW.content_hash <> OLD.content_hash OR NEW.revision <> OLD.revision
       OR NEW.editor_ids <> OLD.editor_ids OR NEW.benefit_types <> OLD.benefit_types
       OR NEW.action_catalog_version <> OLD.action_catalog_version
       OR NOT ((OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED')
            OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('RETIRED','REVOKED'))
            OR (OLD.status = 'RETIRED' AND NEW.status = 'REVOKED'))
       OR (OLD.status <> 'DRAFT' AND (NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at))
       OR (OLD.status = 'RETIRED' AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
      RAISE EXCEPTION 'Published workflow versions are immutable' USING ERRCODE = '42501';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION tpa.guard_workflow_scope_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') AND NOT EXISTS (SELECT 1 FROM tpa.workflow_definition_versions v
      WHERE v.tenant_id = NEW.tenant_id AND v.definition_id = NEW.definition_id AND v.version_no = NEW.version_no AND v.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'Scope bindings target PUBLISHED versions only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id <> OLD.tenant_id OR NEW.benefit_type <> OLD.benefit_type OR NEW.definition_id <> OLD.definition_id) THEN
    RAISE EXCEPTION 'Scope binding key is immutable' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION tpa.guard_workflow_execution() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE pinned tpa.workflow_definition_versions;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO pinned FROM tpa.workflow_definition_versions
      WHERE tenant_id = NEW.tenant_id AND definition_id = NEW.definition_id AND version_no = NEW.version_no;
    IF NOT FOUND OR pinned.status <> 'PUBLISHED' OR pinned.content_hash <> NEW.content_hash
       OR pinned.action_catalog_version <> NEW.action_catalog_version OR NOT (NEW.benefit_type = ANY (pinned.benefit_types)) THEN
      RAISE EXCEPTION 'Executions bind the exact PUBLISHED version' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'RUNNING' OR NEW.step_no <> 0 OR NEW.outcome IS NOT NULL OR NEW.current_node_id IS NOT NULL THEN
      RAISE EXCEPTION 'Executions start RUNNING at step 0' USING ERRCODE = '42501';
    END IF;
    NEW.aggregate_version := 1; NEW.created_at := now(); NEW.updated_at := now(); RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Workflow executions are never deleted' USING ERRCODE = '42501'; END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.id <> OLD.id OR NEW.claim_id <> OLD.claim_id OR NEW.definition_id <> OLD.definition_id
     OR NEW.version_no <> OLD.version_no OR NEW.content_hash <> OLD.content_hash OR NEW.action_catalog_version <> OLD.action_catalog_version
     OR NEW.benefit_type <> OLD.benefit_type OR NEW.pins IS DISTINCT FROM OLD.pins OR NEW.created_at <> OLD.created_at
     OR OLD.status = 'COMPLETED' OR (OLD.status = 'SUSPENDED' AND NEW.status = 'RUNNING')
     OR NEW.step_no < OLD.step_no OR NEW.aggregate_version <> OLD.aggregate_version + 1 THEN
    RAISE EXCEPTION 'Execution pins are immutable and lifecycle is forward-only' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION tpa.guard_workflow_execution_step() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN NEW.applied_at := now(); RETURN NEW; END IF;
  RAISE EXCEPTION 'Workflow execution steps are append-only' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE FUNCTION tpa.guard_workflow_reference_version() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tenant_id = OLD.tenant_id AND NEW.ref_kind = OLD.ref_kind AND NEW.ref_key = OLD.ref_key
     AND NEW.version = OLD.version AND NEW.content_hash = OLD.content_hash AND OLD.status = 'PUBLISHED' AND NEW.status = 'REVOKED' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Pinned reference versions are immutable' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
DO $$
DECLARE item text[];
BEGIN
  FOREACH item SLICE 1 IN ARRAY ARRAY[
    ['workflow_definitions', 'SELECT, INSERT, UPDATE', 'guard_workflow_definition'],
    ['workflow_definition_versions', 'SELECT, INSERT, UPDATE', 'guard_workflow_definition_version'],
    ['workflow_reference_versions', 'SELECT', 'guard_workflow_reference_version'],
    ['workflow_scope_bindings', 'SELECT, INSERT, UPDATE, DELETE', 'guard_workflow_scope_binding'],
    ['workflow_executions', 'SELECT, INSERT, UPDATE', 'guard_workflow_execution'],
    ['workflow_execution_steps', 'SELECT, INSERT', 'guard_workflow_execution_step']] LOOP
    EXECUTE format('ALTER TABLE tpa.%I ENABLE ROW LEVEL SECURITY', item[1]);
    EXECUTE format('ALTER TABLE tpa.%I FORCE ROW LEVEL SECURITY', item[1]);
    EXECUTE format('CREATE POLICY tenant_isolation ON tpa.%I USING (tenant_id = tpa.current_tenant_id()) WITH CHECK (tenant_id = tpa.current_tenant_id())', item[1]);
    EXECUTE format('GRANT %s ON tpa.%I TO tpa_app', item[2], item[1]);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON tpa.%I FOR EACH ROW EXECUTE FUNCTION tpa.%I()', item[3], item[1], item[3]);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON tpa.%I FOR EACH STATEMENT EXECUTE FUNCTION tpa.guard_workflow_execution_step()', item[3] || '_no_truncate', item[1]);
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['guard_workflow_definition','guard_workflow_definition_version','guard_workflow_scope_binding',
      'guard_workflow_execution','guard_workflow_execution_step','guard_workflow_reference_version'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION tpa.%I() FROM PUBLIC', fn);
  END LOOP;
END $$;
