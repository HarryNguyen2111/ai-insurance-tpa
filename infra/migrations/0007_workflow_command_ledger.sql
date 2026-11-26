-- WF-01 (#25) activity-side semantic idempotency. Temporal may execute an
-- Activity more than once (retry after timeout, worker crash after the DB commit
-- but before completion was reported). Every workflow-driven state change records
-- (workflow_id, command_id, activity) in the SAME tenant transaction as the change,
-- so a repeated execution is a no-op. References/codes only — no PII (spec 06 §3).
CREATE TABLE tpa.workflow_command_ledger (
  tenant_id uuid NOT NULL,
  workflow_id varchar(120) NOT NULL
    CHECK (workflow_id ~ '^claim/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  command_id varchar(80) NOT NULL CHECK (command_id ~ '^evt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  activity varchar(64) NOT NULL CHECK (activity ~ '^[a-z][A-Za-z0-9]{0,63}$'),
  transition varchar(40) NOT NULL CHECK (transition ~ '^[A-Z][A-Z_]{0,39}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_command_ledger_pkey PRIMARY KEY (tenant_id, workflow_id, command_id, activity),
  -- The tenant in the workflow id must be the row's tenant (no cross-tenant references).
  CONSTRAINT workflow_command_ledger_tenant_matches CHECK (split_part(workflow_id, '/', 2) = tenant_id::text)
);
--> statement-breakpoint
ALTER TABLE tpa.workflow_command_ledger ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tpa.workflow_command_ledger FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tpa.workflow_command_ledger
  USING (tenant_id = tpa.current_tenant_id()) WITH CHECK (tenant_id = tpa.current_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON tpa.workflow_command_ledger TO tpa_app;
--> statement-breakpoint
CREATE FUNCTION tpa.guard_workflow_command_ledger() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.applied_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Workflow command ledger is append-only' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_workflow_command_ledger_guard BEFORE INSERT OR UPDATE OR DELETE ON tpa.workflow_command_ledger
FOR EACH ROW EXECUTE FUNCTION tpa.guard_workflow_command_ledger();
--> statement-breakpoint
CREATE TRIGGER trg_workflow_command_ledger_no_truncate BEFORE TRUNCATE ON tpa.workflow_command_ledger
FOR EACH STATEMENT EXECUTE FUNCTION tpa.guard_workflow_command_ledger();
