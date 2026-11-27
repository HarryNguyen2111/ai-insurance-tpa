-- AUTH-01: global identity discovery metadata is principal-scoped; tenant grants remain FORCE RLS.
-- No passwords, raw subjects/tokens, tenant assertions, provider configuration or business tables.
CREATE TABLE tpa.identity_principals (
 id uuid PRIMARY KEY, identity_hash text NOT NULL UNIQUE CHECK(identity_hash ~ '^[0-9a-f]{64}$'),
 kind text NOT NULL DEFAULT 'HUMAN' CHECK(kind IN ('HUMAN','SERVICE')), active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0)
);
--> statement-breakpoint
ALTER TABLE tpa.identity_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.identity_principals FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_principals_self ON tpa.identity_principals
 USING (identity_hash=pg_catalog.current_setting('app.identity_hash',true))
 WITH CHECK(identity_hash=pg_catalog.current_setting('app.identity_hash',true));
GRANT SELECT ON tpa.identity_principals TO tpa_app;
--> statement-breakpoint
CREATE FUNCTION tpa.identity_principal_id() RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER
 SET search_path=pg_catalog AS $$
 SELECT id FROM tpa.identity_principals WHERE identity_hash=pg_catalog.current_setting('app.identity_hash',true) AND active AND kind='HUMAN'
$$;
REVOKE ALL ON FUNCTION tpa.identity_principal_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tpa.identity_principal_id() TO tpa_app;
--> statement-breakpoint
CREATE FUNCTION tpa.identity_unique_roles(value text[]) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER
 SET search_path=pg_catalog AS $$ SELECT cardinality(value)=(SELECT count(DISTINCT role) FROM unnest(value) role) $$;
REVOKE ALL ON FUNCTION tpa.identity_unique_roles(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tpa.identity_unique_roles(text[]) TO tpa_app;
--> statement-breakpoint
CREATE TABLE tpa.identity_memberships (
 tenant_id uuid NOT NULL, id uuid PRIMARY KEY, principal_id uuid NOT NULL REFERENCES tpa.identity_principals(id),
 roles text[] NOT NULL CHECK(cardinality(roles) BETWEEN 1 AND 6 AND array_position(roles,NULL) IS NULL
   AND roles <@ ARRAY['MEMBER','GUARDIAN','CLAIM_REVIEWER','INSURER_REVIEWER','FINANCE','CURATOR']::text[] AND tpa.identity_unique_roles(roles)),
 workflow_roles text[] NOT NULL DEFAULT '{}' CHECK(cardinality(workflow_roles)<=4 AND array_position(workflow_roles,NULL) IS NULL
   AND workflow_roles <@ ARRAY['WORKFLOW_DESIGNER','WORKFLOW_PUBLISHER','WORKFLOW_SUPERVISOR','WORKFLOW_OBSERVER']::text[] AND tpa.identity_unique_roles(workflow_roles)),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,principal_id)
);
--> statement-breakpoint
-- Minimal global lookup only: permits a verified principal to discover its own opaque grants.
CREATE TABLE tpa.identity_membership_directory (
 membership_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, principal_id uuid NOT NULL REFERENCES tpa.identity_principals(id),
 FOREIGN KEY(tenant_id,membership_id,principal_id) REFERENCES tpa.identity_memberships(tenant_id,id,principal_id)
);
ALTER TABLE tpa.identity_membership_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.identity_membership_directory FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_directory_self ON tpa.identity_membership_directory
 USING(principal_id=tpa.identity_principal_id()) WITH CHECK(principal_id=tpa.identity_principal_id());
GRANT SELECT ON tpa.identity_membership_directory TO tpa_app;
--> statement-breakpoint
-- Enrollment identifiers are granted by a trusted provisioner; future domain repositories resolve actual members/objects.
-- Deliberately no duplicated insured_members/claims/document schema and no public grant-management endpoint.
CREATE TABLE tpa.identity_member_grants (
 tenant_id uuid NOT NULL, membership_id uuid NOT NULL, member_id uuid NOT NULL,
 relation text NOT NULL CHECK(relation IN ('SELF','GUARDIAN')), active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(tenant_id,membership_id,member_id), FOREIGN KEY(tenant_id,membership_id) REFERENCES tpa.identity_memberships(tenant_id,id)
);
-- A membership represents at most one insured person as SELF; guardianship may cover several dependants.
CREATE UNIQUE INDEX identity_member_grant_one_self ON tpa.identity_member_grants(tenant_id,membership_id) WHERE relation='SELF';
--> statement-breakpoint
CREATE TABLE tpa.identity_object_assignments (
 tenant_id uuid NOT NULL, membership_id uuid NOT NULL,
 object_kind text NOT NULL CHECK(object_kind IN ('CLAIM','DOCUMENT','POLICY','WORKFLOW_DEFINITION','WORKFLOW_TASK')),
 object_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('READ','WRITE')), active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(tenant_id,membership_id,object_kind,object_id,action), FOREIGN KEY(tenant_id,membership_id) REFERENCES tpa.identity_memberships(tenant_id,id)
);
--> statement-breakpoint
CREATE TABLE tpa.identity_contexts (
 tenant_id uuid NOT NULL, id uuid PRIMARY KEY, membership_id uuid NOT NULL, principal_id uuid NOT NULL,
 membership_version integer NOT NULL CHECK(membership_version>0), principal_version integer NOT NULL CHECK(principal_version>0),
 token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'), created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,membership_id,principal_id) REFERENCES tpa.identity_memberships(tenant_id,id,principal_id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes')
);
CREATE INDEX identity_context_expiry ON tpa.identity_contexts(expires_at);
--> statement-breakpoint
ALTER TABLE tpa.identity_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.identity_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_membership_self ON tpa.identity_memberships
 USING(tenant_id=tpa.current_tenant_id() AND principal_id=tpa.identity_principal_id())
 WITH CHECK(tenant_id=tpa.current_tenant_id() AND principal_id=tpa.identity_principal_id());
GRANT SELECT ON tpa.identity_memberships TO tpa_app;
--> statement-breakpoint
ALTER TABLE tpa.identity_member_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.identity_member_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_member_grants_self ON tpa.identity_member_grants
 USING(tenant_id=tpa.current_tenant_id() AND EXISTS(SELECT 1 FROM tpa.identity_memberships m WHERE m.tenant_id=identity_member_grants.tenant_id AND m.id=identity_member_grants.membership_id AND m.principal_id=tpa.identity_principal_id()))
 WITH CHECK(tenant_id=tpa.current_tenant_id() AND EXISTS(SELECT 1 FROM tpa.identity_memberships m WHERE m.tenant_id=identity_member_grants.tenant_id AND m.id=identity_member_grants.membership_id AND m.principal_id=tpa.identity_principal_id()));
GRANT SELECT ON tpa.identity_member_grants TO tpa_app;
--> statement-breakpoint
ALTER TABLE tpa.identity_object_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.identity_object_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_object_assignments_self ON tpa.identity_object_assignments
 USING(tenant_id=tpa.current_tenant_id() AND EXISTS(SELECT 1 FROM tpa.identity_memberships m WHERE m.tenant_id=identity_object_assignments.tenant_id AND m.id=identity_object_assignments.membership_id AND m.principal_id=tpa.identity_principal_id()))
 WITH CHECK(tenant_id=tpa.current_tenant_id() AND EXISTS(SELECT 1 FROM tpa.identity_memberships m WHERE m.tenant_id=identity_object_assignments.tenant_id AND m.id=identity_object_assignments.membership_id AND m.principal_id=tpa.identity_principal_id()));
GRANT SELECT ON tpa.identity_object_assignments TO tpa_app;
--> statement-breakpoint
ALTER TABLE tpa.identity_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.identity_contexts FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_context_self ON tpa.identity_contexts
 USING(tenant_id=tpa.current_tenant_id() AND principal_id=tpa.identity_principal_id())
 WITH CHECK(tenant_id=tpa.current_tenant_id() AND principal_id=tpa.identity_principal_id()
   AND EXISTS(SELECT 1 FROM tpa.identity_memberships m WHERE m.tenant_id=identity_contexts.tenant_id AND m.id=identity_contexts.membership_id AND m.principal_id=identity_contexts.principal_id AND m.active AND m.version=identity_contexts.membership_version)
   AND principal_version=(SELECT version FROM tpa.identity_principals WHERE id=identity_contexts.principal_id));
GRANT SELECT,INSERT ON tpa.identity_contexts TO tpa_app;
--> statement-breakpoint
CREATE FUNCTION tpa.identity_principal_version() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.identity_hash<>OLD.identity_hash THEN RAISE EXCEPTION 'Identity binding immutable' USING ERRCODE='42501'; END IF;
 IF NEW.active IS DISTINCT FROM OLD.active OR NEW.kind IS DISTINCT FROM OLD.kind THEN NEW.version=OLD.version+1;
 ELSIF NEW.version<>OLD.version THEN RAISE EXCEPTION 'Principal version managed by server' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER identity_principal_version BEFORE UPDATE ON tpa.identity_principals FOR EACH ROW EXECUTE FUNCTION tpa.identity_principal_version();
--> statement-breakpoint
CREATE FUNCTION tpa.identity_membership_version() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.principal_id<>OLD.principal_id THEN RAISE EXCEPTION 'Membership binding immutable' USING ERRCODE='42501'; END IF;
 IF NEW.roles IS DISTINCT FROM OLD.roles OR NEW.workflow_roles IS DISTINCT FROM OLD.workflow_roles OR NEW.active IS DISTINCT FROM OLD.active THEN NEW.version=OLD.version+1;
 ELSIF NEW.version<>OLD.version AND NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Membership version monotonic' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER identity_membership_version BEFORE UPDATE ON tpa.identity_memberships FOR EACH ROW EXECUTE FUNCTION tpa.identity_membership_version();
--> statement-breakpoint
CREATE FUNCTION tpa.identity_grant_version() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE prior_tenant uuid; prior_member uuid; next_tenant uuid; next_member uuid; item record;
BEGIN
 IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' THEN prior_tenant=OLD.tenant_id; prior_member=OLD.membership_id; END IF;
 IF TG_OP<>'DELETE' THEN next_tenant=NEW.tenant_id; next_member=NEW.membership_id; END IF;
 FOR item IN SELECT x.tenant_id,x.membership_id FROM (VALUES(prior_tenant,prior_member),(next_tenant,next_member)) x(tenant_id,membership_id)
   WHERE x.tenant_id IS NOT NULL GROUP BY x.tenant_id,x.membership_id ORDER BY x.tenant_id,x.membership_id LOOP
   UPDATE tpa.identity_memberships SET version=version+1 WHERE tenant_id=item.tenant_id AND id=item.membership_id;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER identity_member_grant_version AFTER INSERT OR UPDATE OR DELETE ON tpa.identity_member_grants FOR EACH ROW EXECUTE FUNCTION tpa.identity_grant_version();
CREATE TRIGGER identity_assignment_version AFTER INSERT OR UPDATE OR DELETE ON tpa.identity_object_assignments FOR EACH ROW EXECUTE FUNCTION tpa.identity_grant_version();
--> statement-breakpoint
-- No bypass policy: even the table-owning definer remains subject to FORCE RLS.
-- Lock only the current principal + its current-tenant membership, without granting app UPDATE rights.
CREATE FUNCTION tpa.identity_lock_membership(membership uuid) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path=pg_catalog SET row_security=on AS $$
DECLARE principal uuid;
BEGIN
 SELECT id INTO principal FROM tpa.identity_principals WHERE id=tpa.identity_principal_id() AND active AND kind='HUMAN' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Identity access denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM tpa.identity_memberships WHERE tenant_id=tpa.current_tenant_id() AND id=membership AND principal_id=principal AND active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Identity access denied' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION tpa.identity_lock_membership(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tpa.identity_lock_membership(uuid) TO tpa_app;
