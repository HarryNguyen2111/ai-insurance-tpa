-- EVT-02 (#24) consumer inbox. Kafka delivery is at-least-once (EVT-01); every
-- consumer records (tenant, consumer, eventId) in the SAME tenant transaction as
-- its effect and commits the Kafka offset only after that transaction commits.
-- No exactly-once claim: duplicates are detected and skipped, never re-applied.
CREATE TABLE tpa.consumer_inbox (
  tenant_id uuid NOT NULL,
  consumer_name varchar(64) NOT NULL CHECK (consumer_name ~ '^[a-z][a-z0-9-]{2,63}$'),
  event_id uuid NOT NULL,
  event_type varchar(64) NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30}){1,2}$'),
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version >= 1),
  outcome varchar(12) NOT NULL CHECK (outcome IN ('APPLIED', 'RECONCILED', 'STALE')),
  replayed_from uuid,
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consumer_inbox_pkey PRIMARY KEY (tenant_id, consumer_name, event_id)
);
--> statement-breakpoint
-- Highest aggregate version this consumer has applied: older events are stale
-- (never roll a projection back); a jump > +1 is a gap that must be reconciled.
CREATE TABLE tpa.consumer_aggregate_positions (
  tenant_id uuid NOT NULL,
  consumer_name varchar(64) NOT NULL CHECK (consumer_name ~ '^[a-z][a-z0-9-]{2,63}$'),
  aggregate_id uuid NOT NULL,
  last_version integer NOT NULL DEFAULT 0 CHECK (last_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consumer_aggregate_positions_pkey PRIMARY KEY (tenant_id, consumer_name, aggregate_id)
);
--> statement-breakpoint
-- Tenant-scoped parking lot (DLQ) for events that are valid contracts but could
-- not be applied. Stores only the registry-validated, PII-free envelope plus
-- reason/error CODES (never error messages or raw record bytes).
CREATE TABLE tpa.consumer_parked_events (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  consumer_name varchar(64) NOT NULL CHECK (consumer_name ~ '^[a-z][a-z0-9-]{2,63}$'),
  event_id uuid NOT NULL,
  event_type varchar(64) NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30}){1,2}$'),
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version >= 1),
  envelope jsonb NOT NULL CHECK (octet_length(envelope::text) <= 16384),
  reason_code varchar(24) NOT NULL
    CHECK (reason_code IN ('RETRY_EXHAUSTED', 'HANDLER_REJECTED', 'VERSION_GAP', 'BLOCKED_BY_PARKED')),
  attempts integer NOT NULL CHECK (attempts >= 0),
  error_name varchar(64) CHECK (error_name ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  source_topic varchar(249) CHECK (source_topic ~ '^[A-Za-z0-9._-]{1,249}$'),
  source_partition integer CHECK (source_partition >= 0),
  source_offset bigint CHECK (source_offset >= 0),
  status varchar(10) NOT NULL DEFAULT 'PARKED' CHECK (status IN ('PARKED', 'REPLAYED', 'DISCARDED')),
  replay_attempts integer NOT NULL DEFAULT 0 CHECK (replay_attempts >= 0),
  parked_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution varchar(12) CHECK (resolution IN ('APPLIED', 'RECONCILED', 'STALE', 'DISCARDED')),
  CONSTRAINT consumer_parked_events_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT consumer_parked_events_event_key UNIQUE (tenant_id, consumer_name, event_id),
  CONSTRAINT consumer_parked_events_envelope_matches CHECK (
    jsonb_typeof(envelope) = 'object'
    AND envelope->>'eventId' = event_id::text AND envelope->>'tenantId' = tenant_id::text
    AND envelope->>'eventType' = event_type AND envelope->>'aggregateId' = aggregate_id::text
    AND envelope->'aggregateVersion' = to_jsonb(aggregate_version)),
  CONSTRAINT consumer_parked_events_state_shape CHECK (
    (status = 'PARKED' AND resolved_at IS NULL AND resolved_by IS NULL AND resolution IS NULL)
    OR (status = 'REPLAYED' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL
      AND resolution IN ('APPLIED', 'RECONCILED', 'STALE'))
    OR (status = 'DISCARDED' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution = 'DISCARDED'))
);
--> statement-breakpoint
CREATE INDEX consumer_parked_events_open ON tpa.consumer_parked_events (tenant_id, consumer_name, aggregate_id, aggregate_version)
  WHERE status = 'PARKED';
--> statement-breakpoint
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['consumer_inbox', 'consumer_aggregate_positions', 'consumer_parked_events'] LOOP
    EXECUTE format('ALTER TABLE tpa.%I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE tpa.%I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON tpa.%I USING (tenant_id = tpa.current_tenant_id()) WITH CHECK (tenant_id = tpa.current_tenant_id())', tab);
  END LOOP;
END $$;
--> statement-breakpoint
-- Least privilege: inbox is append-only; positions only advance; parked rows only
-- resolve. No DELETE/TRUNCATE grants anywhere.
GRANT SELECT, INSERT ON tpa.consumer_inbox TO tpa_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON tpa.consumer_aggregate_positions TO tpa_app;
--> statement-breakpoint
GRANT UPDATE (last_version, updated_at) ON tpa.consumer_aggregate_positions TO tpa_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON tpa.consumer_parked_events TO tpa_app;
--> statement-breakpoint
GRANT UPDATE (status, replay_attempts, error_name, resolved_at, resolved_by, resolution) ON tpa.consumer_parked_events TO tpa_app;
--> statement-breakpoint
CREATE FUNCTION tpa.guard_consumer_inbox() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.processed_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Consumer inbox records are immutable' USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_consumer_inbox_guard BEFORE INSERT OR UPDATE OR DELETE ON tpa.consumer_inbox
FOR EACH ROW EXECUTE FUNCTION tpa.guard_consumer_inbox();
--> statement-breakpoint
CREATE TRIGGER trg_consumer_inbox_no_truncate BEFORE TRUNCATE ON tpa.consumer_inbox
FOR EACH STATEMENT EXECUTE FUNCTION tpa.guard_consumer_inbox();
--> statement-breakpoint
CREATE FUNCTION tpa.guard_consumer_position() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Consumer positions are retained' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.consumer_name IS DISTINCT FROM OLD.consumer_name
    OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id OR NEW.last_version < OLD.last_version THEN
    RAISE EXCEPTION 'Consumer positions only advance' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_consumer_position_guard BEFORE INSERT OR UPDATE OR DELETE ON tpa.consumer_aggregate_positions
FOR EACH ROW EXECUTE FUNCTION tpa.guard_consumer_position();
--> statement-breakpoint
CREATE TRIGGER trg_consumer_position_no_truncate BEFORE TRUNCATE ON tpa.consumer_aggregate_positions
FOR EACH STATEMENT EXECUTE FUNCTION tpa.guard_consumer_position();
--> statement-breakpoint
CREATE FUNCTION tpa.guard_consumer_parked_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Server clock; rows always start open.
    NEW.parked_at := pg_catalog.now();
    NEW.status := 'PARKED'; NEW.replay_attempts := 0;
    NEW.resolved_at := NULL; NEW.resolved_by := NULL; NEW.resolution := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Parked events are retained for audit' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'PARKED' THEN
    RAISE EXCEPTION 'Resolved parked events are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.consumer_name IS DISTINCT FROM OLD.consumer_name OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
    OR NEW.aggregate_version IS DISTINCT FROM OLD.aggregate_version OR NEW.envelope IS DISTINCT FROM OLD.envelope
    OR NEW.reason_code IS DISTINCT FROM OLD.reason_code OR NEW.attempts IS DISTINCT FROM OLD.attempts
    OR NEW.source_topic IS DISTINCT FROM OLD.source_topic OR NEW.source_partition IS DISTINCT FROM OLD.source_partition
    OR NEW.source_offset IS DISTINCT FROM OLD.source_offset OR NEW.parked_at IS DISTINCT FROM OLD.parked_at
    OR NEW.replay_attempts < OLD.replay_attempts THEN
    RAISE EXCEPTION 'Parked event facts are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> 'PARKED' THEN NEW.resolved_at := pg_catalog.now(); END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_consumer_parked_guard BEFORE INSERT OR UPDATE OR DELETE ON tpa.consumer_parked_events
FOR EACH ROW EXECUTE FUNCTION tpa.guard_consumer_parked_event();
--> statement-breakpoint
CREATE TRIGGER trg_consumer_parked_no_truncate BEFORE TRUNCATE ON tpa.consumer_parked_events
FOR EACH STATEMENT EXECUTE FUNCTION tpa.guard_consumer_parked_event();
--> statement-breakpoint
-- Poison records (unparseable / schema-invalid / misrouted) have no trustworthy
-- tenant, so they cannot be parked under RLS. Only Kafka coordinates, a sha256 of
-- the raw bytes and a reason code are kept: never content (it may hold PII).
-- No app table grant; writes go through the narrow function below.
CREATE TABLE tpa.consumer_quarantine (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  consumer_name varchar(64) NOT NULL CHECK (consumer_name ~ '^[a-z][a-z0-9-]{2,63}$'),
  source_topic varchar(249) NOT NULL CHECK (source_topic ~ '^[A-Za-z0-9._-]{1,249}$'),
  source_partition integer NOT NULL CHECK (source_partition >= 0),
  source_offset bigint NOT NULL CHECK (source_offset >= 0),
  record_sha256 char(64) NOT NULL CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
  reason_code varchar(24) NOT NULL CHECK (reason_code IN ('UNPARSEABLE', 'SCHEMA_INVALID', 'ROUTING_MISMATCH')),
  quarantined_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consumer_quarantine_source_key UNIQUE (consumer_name, source_topic, source_partition, source_offset)
);
--> statement-breakpoint
CREATE FUNCTION tpa.quarantine_consumer_record(p_consumer text, p_topic text, p_partition integer, p_offset bigint,
  p_sha256 text, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE inserted integer;
BEGIN
  INSERT INTO tpa.consumer_quarantine (consumer_name, source_topic, source_partition, source_offset, record_sha256, reason_code)
  VALUES (p_consumer, p_topic, p_partition, p_offset, p_sha256, p_reason)
  ON CONFLICT (consumer_name, source_topic, source_partition, source_offset) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted = 1;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.quarantine_consumer_record(text, text, integer, bigint, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tpa.quarantine_consumer_record(text, text, integer, bigint, text, text) TO tpa_app;
