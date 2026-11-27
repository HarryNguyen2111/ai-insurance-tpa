-- DOC-01: technical records only. Approved policy text/retention remain operator decisions.
CREATE TABLE tpa.consent_policies (
 tenant_id uuid NOT NULL, purpose varchar(100) NOT NULL, policy_version varchar(500) NOT NULL,
 policy_hash text NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'), active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(tenant_id,purpose,policy_version,policy_hash)
);
--> statement-breakpoint
CREATE TABLE tpa.consent_records (
 tenant_id uuid NOT NULL, id uuid NOT NULL, member_id uuid NOT NULL,
 principal_id uuid NOT NULL, membership_id uuid NOT NULL,
 purpose varchar(100) NOT NULL, policy_version varchar(500) NOT NULL, policy_hash text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), version integer NOT NULL DEFAULT 1 CHECK(version=1),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,member_id,principal_id,membership_id),
 FOREIGN KEY(tenant_id,membership_id,principal_id) REFERENCES tpa.identity_memberships(tenant_id,id,principal_id),
 FOREIGN KEY(tenant_id,purpose,policy_version,policy_hash) REFERENCES tpa.consent_policies(tenant_id,purpose,policy_version,policy_hash)
);
--> statement-breakpoint
CREATE TABLE tpa.upload_sessions (
 tenant_id uuid NOT NULL, id uuid NOT NULL, member_id uuid NOT NULL,
 principal_id uuid NOT NULL, membership_id uuid NOT NULL, consent_id uuid NOT NULL,
 object_key text NOT NULL UNIQUE, content_type text NOT NULL CHECK(content_type IN
 ('image/jpeg','image/png','image/heic','image/heif','application/pdf','application/xml','text/xml')),
 doc_type text NOT NULL CHECK(doc_type IN ('INVOICE_PHOTO','ITEMIZED_LIST','PRESCRIPTION','LAB_ORDER','LAB_RESULT','DISCHARGE_PAPER','VNEID_HISTORY')),
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 20971520), sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,membership_id,principal_id) REFERENCES tpa.identity_memberships(tenant_id,id,principal_id),
 FOREIGN KEY(tenant_id,consent_id,member_id,principal_id,membership_id) REFERENCES tpa.consent_records(tenant_id,id,member_id,principal_id,membership_id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '300 seconds')
);
--> statement-breakpoint
CREATE TABLE tpa.document_versions (
 tenant_id uuid NOT NULL, id uuid NOT NULL, upload_id uuid NOT NULL,
 object_version text NOT NULL CHECK(length(object_version) BETWEEN 1 AND 1024 AND object_version<>'null'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), version integer NOT NULL DEFAULT 1 CHECK(version=1),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,upload_id),
 FOREIGN KEY(tenant_id,upload_id) REFERENCES tpa.upload_sessions(tenant_id,id)
);
--> statement-breakpoint
-- Transactional work outbox: no binary data, signed URL, filename, or external identity.
-- Pending rows survive restart; row locks serialize retries. No new Kafka event type is invented.
CREATE TABLE tpa.document_scan_outbox (
 tenant_id uuid NOT NULL, document_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'QUARANTINED' CHECK(status IN ('QUARANTINED','SCANNING','CLEAN','REJECTED')),
 scanner_version varchar(200), scanned_at timestamptz,
 PRIMARY KEY(tenant_id,document_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES tpa.document_versions(tenant_id,id),
 CHECK((status IN ('CLEAN','REJECTED'))=(scanner_version IS NOT NULL AND scanned_at IS NOT NULL))
);
--> statement-breakpoint
CREATE FUNCTION tpa.document_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Document evidence is append only'; END $$;
REVOKE ALL ON FUNCTION tpa.document_immutable() FROM PUBLIC;
CREATE TRIGGER consent_records_immutable BEFORE UPDATE OR DELETE ON tpa.consent_records FOR EACH ROW EXECUTE FUNCTION tpa.document_immutable();
CREATE TRIGGER upload_sessions_immutable BEFORE UPDATE OR DELETE ON tpa.upload_sessions FOR EACH ROW EXECUTE FUNCTION tpa.document_immutable();
CREATE TRIGGER document_versions_immutable BEFORE UPDATE OR DELETE ON tpa.document_versions FOR EACH ROW EXECUTE FUNCTION tpa.document_immutable();
--> statement-breakpoint
ALTER TABLE tpa.consent_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.consent_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_policies_tenant ON tpa.consent_policies USING(tenant_id=tpa.current_tenant_id()) WITH CHECK(tenant_id=tpa.current_tenant_id());
GRANT SELECT ON tpa.consent_policies TO tpa_app;
--> statement-breakpoint
ALTER TABLE tpa.consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.consent_records FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_records_tenant ON tpa.consent_records USING(tenant_id=tpa.current_tenant_id()) WITH CHECK(tenant_id=tpa.current_tenant_id());
GRANT SELECT,INSERT ON tpa.consent_records TO tpa_app;
--> statement-breakpoint
ALTER TABLE tpa.upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.upload_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY upload_sessions_tenant ON tpa.upload_sessions USING(tenant_id=tpa.current_tenant_id()) WITH CHECK(tenant_id=tpa.current_tenant_id());
GRANT SELECT,INSERT ON tpa.upload_sessions TO tpa_app;
--> statement-breakpoint
ALTER TABLE tpa.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.document_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY document_versions_tenant ON tpa.document_versions USING(tenant_id=tpa.current_tenant_id()) WITH CHECK(tenant_id=tpa.current_tenant_id());
GRANT SELECT,INSERT ON tpa.document_versions TO tpa_app;
--> statement-breakpoint
ALTER TABLE tpa.document_scan_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.document_scan_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY document_scan_outbox_tenant ON tpa.document_scan_outbox USING(tenant_id=tpa.current_tenant_id()) WITH CHECK(tenant_id=tpa.current_tenant_id());
GRANT SELECT,INSERT,UPDATE ON tpa.document_scan_outbox TO tpa_app;
--> statement-breakpoint
-- Narrow lock capability: application cannot provision/change approved policies. FORCE RLS still applies.
CREATE FUNCTION tpa.document_lock_policy(p_purpose text,p_version text,p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM 1 FROM tpa.consent_policies WHERE tenant_id=tpa.current_tenant_id()
  AND purpose=p_purpose AND policy_version=p_version AND policy_hash=p_hash AND active FOR SHARE;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION tpa.document_lock_policy(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tpa.document_lock_policy(text,text,text) TO tpa_app;
