-- EVT-01 (#23) transactional outbox. Rows are written in the same tenant
-- transaction as business state + audit, and relayed to Kafka at-least-once:
-- published_at is set only after broker acknowledgement, so a crash between
-- publish and mark re-publishes the same eventId (consumers dedup, #24).
-- The envelope is the validated, minimal, non-PII registry contract.
CREATE TABLE tpa.outbox_events (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type varchar(64) NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30}){1,2}$'),
  schema_version varchar(16) NOT NULL
    CHECK (schema_version ~ '^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'),
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version >= 1),
  topic varchar(64) NOT NULL CHECK (topic ~ '^[a-z][a-z0-9-]{0,63}$'),
  -- Kafka record key: ordering per tenant aggregate.
  partition_key text GENERATED ALWAYS AS (tenant_id::text || ':' || aggregate_id::text) STORED,
  envelope jsonb NOT NULL CHECK (octet_length(envelope::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT outbox_events_pkey PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT outbox_events_seq_key UNIQUE (seq),
  CONSTRAINT outbox_events_aggregate_event UNIQUE (tenant_id, aggregate_id, aggregate_version, event_type),
  CONSTRAINT outbox_events_envelope_matches CHECK (
    jsonb_typeof(envelope) = 'object'
    AND envelope->>'eventId' = event_id::text
    AND envelope->>'tenantId' = tenant_id::text
    AND envelope->>'eventType' = event_type
    AND envelope->>'schemaVersion' = schema_version
    AND envelope->>'aggregateId' = aggregate_id::text
    AND envelope->'aggregateVersion' = to_jsonb(aggregate_version)
    AND jsonb_typeof(envelope->'payload') = 'object')
);
--> statement-breakpoint
CREATE INDEX outbox_events_pending ON tpa.outbox_events (tenant_id, seq) WHERE published_at IS NULL;
--> statement-breakpoint
ALTER TABLE tpa.outbox_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tpa.outbox_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tpa.outbox_events
  USING (tenant_id = tpa.current_tenant_id()) WITH CHECK (tenant_id = tpa.current_tenant_id());
--> statement-breakpoint
-- No DELETE/TRUNCATE. The app may only stamp published_at (column grant).
GRANT SELECT, INSERT ON tpa.outbox_events TO tpa_app;
--> statement-breakpoint
GRANT UPDATE (published_at) ON tpa.outbox_events TO tpa_app;
--> statement-breakpoint
CREATE FUNCTION tpa.guard_outbox_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Outbox events cannot be truncated' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Server clock owns lifecycle timestamps; rows always start unpublished.
    NEW.created_at := pg_catalog.now();
    NEW.published_at := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NULL THEN
      RAISE EXCEPTION 'Unpublished outbox events cannot be deleted' USING ERRCODE = '42501';
    END IF;
    RETURN OLD; -- Retention purge of published rows needs a separately reviewed operator job.
  END IF;
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'Published outbox events are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.published_at IS NULL
    OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.event_type IS DISTINCT FROM OLD.event_type
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
    OR NEW.aggregate_version IS DISTINCT FROM OLD.aggregate_version OR NEW.topic IS DISTINCT FROM OLD.topic
    OR NEW.envelope IS DISTINCT FROM OLD.envelope OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Outbox events only transition to published' USING ERRCODE = '42501';
  END IF;
  NEW.published_at := pg_catalog.now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON tpa.outbox_events
FOR EACH ROW EXECUTE FUNCTION tpa.guard_outbox_event();
--> statement-breakpoint
CREATE TRIGGER trg_outbox_no_truncate BEFORE TRUNCATE ON tpa.outbox_events
FOR EACH STATEMENT EXECUTE FUNCTION tpa.guard_outbox_event();
--> statement-breakpoint
-- Relay discovery without any non-tenant RLS policy: each tenant that ever
-- emitted an event is registered here (tenant UUID + time only, no event data).
-- No tpa_app grant; the relay pages through it via the function below and then
-- reads/marks that tenant's rows inside withTenantTransaction (SET LOCAL + RLS).
CREATE TABLE tpa.outbox_relay_tenants (
  tenant_id uuid PRIMARY KEY,
  registered_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE FUNCTION tpa.register_outbox_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  -- NEW.tenant_id already passed the outbox WITH CHECK (= transaction tenant).
  INSERT INTO tpa.outbox_relay_tenants (tenant_id) VALUES (NEW.tenant_id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_outbox_register_tenant AFTER INSERT ON tpa.outbox_events
FOR EACH ROW EXECUTE FUNCTION tpa.register_outbox_tenant();
--> statement-breakpoint
-- Keyset page of registered tenant UUIDs (never envelopes or pending counts).
CREATE FUNCTION tpa.outbox_relay_tenant_ids(p_after uuid, p_limit integer) RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT t.tenant_id FROM tpa.outbox_relay_tenants t
  WHERE p_after IS NULL OR t.tenant_id > p_after
  ORDER BY t.tenant_id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.register_outbox_tenant() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.outbox_relay_tenant_ids(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tpa.outbox_relay_tenant_ids(uuid, integer) TO tpa_app;
