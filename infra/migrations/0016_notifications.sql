-- NOTIF-01 (#107) phase 1: in-app notification inboxes. Read-state only: unread/read is NOT provider
-- delivery (#41/#13) and NOT a legal/business confirmation (EOB/OTP/consent/claim action).
-- Stored text is rendered by the server from an allowlisted template; clients never supply recipient,
-- tenant, text or targets. No PII, amounts, diagnosis, document URLs or OTP. Targets are internal
-- descriptors (kind + UUID) that the target API re-authorizes; no URLs/HTML.
--
-- Two physically separate inboxes, so personal access never needs a tenant=NULL bypass:
--  * tpa.tenant_notifications: FORCE RLS on tenant (SET LOCAL) + recipient principal + ACTIVE membership.
--  * tpa.personal_notifications: principal-scoped RLS (app.identity_hash), no tenant column at all.
CREATE FUNCTION tpa.notification_text_safe(value text, max_len integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 -- Defence in depth for server templates: bounded, no markup/URLs/control chars, no long digit runs (phone/CCCD/account).
 SELECT value IS NOT NULL AND char_length(value) BETWEEN 1 AND max_len AND value = btrim(value)
   AND value !~ '[<>]' AND value !~* '(://|www\.)' AND value !~ '[[:cntrl:]]' AND value !~ '[0-9]{6,}'
$$;
REVOKE ALL ON FUNCTION tpa.notification_text_safe(text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tpa.notification_text_safe(text,integer) TO tpa_app;
--> statement-breakpoint
CREATE TABLE tpa.tenant_notifications (
 tenant_id uuid NOT NULL, id uuid NOT NULL,
 recipient_principal_id uuid NOT NULL, recipient_membership_id uuid NOT NULL,
 service text NOT NULL CHECK (service IN ('TPA_INSURANCE')),
 category text NOT NULL CHECK (category IN ('CLAIM_STATUS')),
 priority text NOT NULL CHECK (priority IN ('INFO','ACTION_REQUIRED')),
 template_key text NOT NULL CHECK (template_key ~ '^[A-Z][A-Z0-9_]{2,63}$'),
 template_version integer NOT NULL CHECK (template_version > 0),
 title_vi text NOT NULL CHECK (tpa.notification_text_safe(title_vi, 120)),
 body_vi text NOT NULL CHECK (tpa.notification_text_safe(body_vi, 280)),
 target_kind text NOT NULL CHECK (target_kind IN ('CLAIM')), target_id uuid NOT NULL,
 source_event_id uuid NOT NULL,
 source_event_type text NOT NULL CHECK (source_event_type IN ('claim.submitted','claim.state-changed')),
 source_aggregate_version integer NOT NULL CHECK (source_aggregate_version > 0),
 occurred_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 read_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 PRIMARY KEY (tenant_id,id),
 -- At-least-once dedup: one notification per recipient + source event + template (scope = this table).
 UNIQUE (tenant_id,recipient_principal_id,source_event_id,template_key),
 FOREIGN KEY (tenant_id,recipient_membership_id,recipient_principal_id) REFERENCES tpa.identity_memberships(tenant_id,id,principal_id),
 CHECK (expires_at > created_at AND expires_at <= created_at + interval '366 days'),
 CHECK (read_at IS NULL OR read_at >= created_at),
 CHECK ((read_at IS NULL) = (version = 1))
);
-- Keyset pagination and unread count stay index-only per recipient membership (no N+1, no tenant scan).
CREATE INDEX tenant_notifications_inbox ON tpa.tenant_notifications (tenant_id, recipient_membership_id, created_at DESC, id DESC);
CREATE INDEX tenant_notifications_unread ON tpa.tenant_notifications (tenant_id, recipient_membership_id, created_at DESC, id DESC) WHERE read_at IS NULL;
--> statement-breakpoint
CREATE TABLE tpa.personal_notifications (
 id uuid PRIMARY KEY,
 recipient_principal_id uuid NOT NULL REFERENCES tpa.identity_principals(id),
 -- Loyalty360 personal producer/consent is an unresolved design gap (#107/#110 G4/G9): no producer exists,
 -- and tpa_app has no INSERT grant. Only a future approved producer migration may add one.
 service text NOT NULL CHECK (service IN ('LOYALTY360')),
 category text NOT NULL CHECK (category IN ('SERVICE_NOTICE')),
 priority text NOT NULL CHECK (priority IN ('INFO','ACTION_REQUIRED')),
 template_key text NOT NULL CHECK (template_key ~ '^[A-Z][A-Z0-9_]{2,63}$'),
 template_version integer NOT NULL CHECK (template_version > 0),
 title_vi text NOT NULL CHECK (tpa.notification_text_safe(title_vi, 120)),
 body_vi text NOT NULL CHECK (tpa.notification_text_safe(body_vi, 280)),
 -- No personal deep-link target is contracted yet.
 target_kind text CHECK (target_kind IS NULL), target_id uuid CHECK (target_id IS NULL),
 source_event_id uuid NOT NULL,
 source_event_type text NOT NULL CHECK (source_event_type ~ '^[a-z][a-z0-9]*\.[a-z][a-z0-9-]*$'),
 source_aggregate_version integer NOT NULL CHECK (source_aggregate_version > 0),
 occurred_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 read_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 UNIQUE (recipient_principal_id,source_event_id,template_key),
 CHECK (expires_at > created_at AND expires_at <= created_at + interval '366 days'),
 CHECK (read_at IS NULL OR read_at >= created_at),
 CHECK ((read_at IS NULL) = (version = 1))
);
CREATE INDEX personal_notifications_inbox ON tpa.personal_notifications (recipient_principal_id, created_at DESC, id DESC);
CREATE INDEX personal_notifications_unread ON tpa.personal_notifications (recipient_principal_id, created_at DESC, id DESC) WHERE read_at IS NULL;
--> statement-breakpoint
-- Only read_at may change, once (NULL -> timestamp) with version 1 -> 2. Everything else is immutable; no DELETE grant.
CREATE FUNCTION tpa.notification_read_only_change() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Notifications are retained, not deleted' USING ERRCODE='42501'; END IF;
 IF TG_OP = 'INSERT' THEN
   IF NEW.read_at IS NOT NULL OR NEW.version <> 1 THEN RAISE EXCEPTION 'Notification starts unread' USING ERRCODE='42501'; END IF;
   RETURN NEW;
 END IF;
 IF (to_jsonb(NEW) - 'read_at' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at' - 'version') THEN
   RAISE EXCEPTION 'Notification content is immutable' USING ERRCODE='42501';
 END IF;
 IF OLD.read_at IS NOT NULL OR NEW.read_at IS NULL OR NEW.version <> OLD.version + 1 THEN
   RAISE EXCEPTION 'Notification read state is monotonic' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tenant_notifications_read_only BEFORE INSERT OR UPDATE ON tpa.tenant_notifications FOR EACH ROW EXECUTE FUNCTION tpa.notification_read_only_change();
CREATE TRIGGER personal_notifications_read_only BEFORE INSERT OR UPDATE ON tpa.personal_notifications FOR EACH ROW EXECUTE FUNCTION tpa.notification_read_only_change();
CREATE TRIGGER tenant_notifications_no_delete BEFORE DELETE ON tpa.tenant_notifications FOR EACH ROW EXECUTE FUNCTION tpa.notification_read_only_change();
CREATE TRIGGER personal_notifications_no_delete BEFORE DELETE ON tpa.personal_notifications FOR EACH ROW EXECUTE FUNCTION tpa.notification_read_only_change();
--> statement-breakpoint
ALTER TABLE tpa.tenant_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.tenant_notifications FORCE ROW LEVEL SECURITY;
-- Producer (inbox consumer) writes in the event's tenant transaction; no identity context is involved.
CREATE POLICY tenant_notifications_produce ON tpa.tenant_notifications FOR INSERT
 WITH CHECK (tenant_id=tpa.current_tenant_id());
-- Readers: same tenant AND the verified principal AND the recipient membership still ACTIVE (revocation hides rows).
CREATE POLICY tenant_notifications_recipient_read ON tpa.tenant_notifications FOR SELECT
 USING (tenant_id=tpa.current_tenant_id() AND recipient_principal_id=tpa.identity_principal_id()
   AND EXISTS (SELECT 1 FROM tpa.identity_memberships m WHERE m.tenant_id=tenant_notifications.tenant_id
     AND m.id=tenant_notifications.recipient_membership_id AND m.principal_id=tenant_notifications.recipient_principal_id AND m.active));
CREATE POLICY tenant_notifications_recipient_mark ON tpa.tenant_notifications FOR UPDATE
 USING (tenant_id=tpa.current_tenant_id() AND recipient_principal_id=tpa.identity_principal_id()
   AND EXISTS (SELECT 1 FROM tpa.identity_memberships m WHERE m.tenant_id=tenant_notifications.tenant_id
     AND m.id=tenant_notifications.recipient_membership_id AND m.principal_id=tenant_notifications.recipient_principal_id AND m.active))
 WITH CHECK (tenant_id=tpa.current_tenant_id() AND recipient_principal_id=tpa.identity_principal_id());
GRANT SELECT, INSERT ON tpa.tenant_notifications TO tpa_app;
GRANT UPDATE (read_at, version) ON tpa.tenant_notifications TO tpa_app;
--> statement-breakpoint
ALTER TABLE tpa.personal_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE tpa.personal_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_notifications_self ON tpa.personal_notifications
 USING (recipient_principal_id=tpa.identity_principal_id())
 WITH CHECK (recipient_principal_id=tpa.identity_principal_id());
GRANT SELECT ON tpa.personal_notifications TO tpa_app;
GRANT UPDATE (read_at, version) ON tpa.personal_notifications TO tpa_app;
