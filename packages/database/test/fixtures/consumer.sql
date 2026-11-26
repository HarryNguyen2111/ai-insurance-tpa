-- TEST ONLY: synthetic consumer harness targets (EVT-02 #24); not business schema.
-- synthetic_effects deliberately has NO unique key on event_id, so any repeated
-- effect is observable. synthetic_source plays the authoritative PostgreSQL
-- snapshot that a gap reconcile reloads.
CREATE TABLE tpa.synthetic_projection (
  tenant_id uuid NOT NULL, aggregate_id uuid NOT NULL, version integer NOT NULL, status text NOT NULL,
  PRIMARY KEY (tenant_id, aggregate_id)
);
CREATE TABLE tpa.synthetic_effects (
  tenant_id uuid NOT NULL, id bigint GENERATED ALWAYS AS IDENTITY, consumer_name text NOT NULL, event_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE tpa.synthetic_source (
  tenant_id uuid NOT NULL, aggregate_id uuid NOT NULL, version integer NOT NULL, status text NOT NULL,
  PRIMARY KEY (tenant_id, aggregate_id)
);
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['synthetic_projection', 'synthetic_effects', 'synthetic_source'] LOOP
    EXECUTE format('ALTER TABLE tpa.%I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE tpa.%I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_scope ON tpa.%I TO tpa_app, tpa_migrator USING (tenant_id = tpa.current_tenant_id()) WITH CHECK (tenant_id = tpa.current_tenant_id())', tab);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON tpa.%I TO tpa_app', tab);
  END LOOP;
END $$;
