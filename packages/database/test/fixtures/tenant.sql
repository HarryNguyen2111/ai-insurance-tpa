-- TEST ONLY: representative relations; not runtime business/domain schema.
CREATE TABLE tpa.isolation_parent (
  tenant_id uuid NOT NULL, id uuid NOT NULL, label text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE tpa.isolation_child (
  tenant_id uuid NOT NULL, id uuid NOT NULL, parent_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES tpa.isolation_parent(tenant_id, id)
);
ALTER TABLE tpa.isolation_parent ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.isolation_parent FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tpa.isolation_parent TO tpa_app, tpa_migrator
  USING (tenant_id = tpa.current_tenant_id())
  WITH CHECK (tenant_id = tpa.current_tenant_id());
ALTER TABLE tpa.isolation_child ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.isolation_child FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tpa.isolation_child TO tpa_app, tpa_migrator
  USING (tenant_id = tpa.current_tenant_id())
  WITH CHECK (tenant_id = tpa.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tpa.isolation_parent, tpa.isolation_child TO tpa_app;
-- Controlled global boundary: explicit read-only public catalog vs closed registry.
CREATE TABLE tpa.isolation_global_read (id integer PRIMARY KEY);
INSERT INTO tpa.isolation_global_read VALUES (1);
GRANT SELECT ON tpa.isolation_global_read TO tpa_app;
CREATE TABLE tpa.isolation_global_private (id integer PRIMARY KEY);
-- No grant on private registry. No app-wide bypass or privileged function.
