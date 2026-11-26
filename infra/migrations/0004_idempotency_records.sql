-- API-01 durable idempotency (#22). Namespace = verified tenant + actor + operation
-- + client key. Only a canonical request hash is stored, never the raw request.
-- Rows are never deleted by the application: an expired row keeps its namespace
-- and hash as a tombstone so a reused key can never silently repeat an effect.
CREATE TABLE tpa.idempotency_records (
  tenant_id uuid NOT NULL,
  actor_type varchar(10) NOT NULL CHECK (actor_type IN ('USER','SERVICE','SYSTEM')),
  actor_id uuid NOT NULL,
  operation varchar(80) NOT NULL CHECK (operation ~ '^[a-z][A-Za-z0-9]{0,79}$'),
  idempotency_key varchar(100) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{16,100}$'),
  request_hash_version text NOT NULL CHECK (request_hash_version = '1'),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state varchar(12) NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETED','EXPIRED')),
  owner_token uuid,
  lease_expires_at timestamptz,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  response_status smallint CHECK (response_status BETWEEN 200 AND 499),
  response_body jsonb CHECK (octet_length(response_body::text) <= 131072), -- TS caps canonical bytes at 60000
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_records_pkey PRIMARY KEY (tenant_id, actor_type, actor_id, operation, idempotency_key),
  CONSTRAINT idempotency_records_retention CHECK (
    expires_at >= created_at + interval '24 hours' AND expires_at <= created_at + interval '90 days'),
  CONSTRAINT idempotency_records_state_shape CHECK (
    (state = 'IN_PROGRESS' AND response_status IS NULL AND response_body IS NULL
      AND completed_at IS NULL AND lease_expires_at IS NOT NULL)
    OR (state = 'COMPLETED' AND response_status IS NOT NULL AND response_body IS NOT NULL
      AND completed_at IS NOT NULL AND owner_token IS NULL AND lease_expires_at IS NULL)
    OR (state = 'EXPIRED' AND response_status IS NULL AND response_body IS NULL
      AND owner_token IS NULL AND lease_expires_at IS NULL))
);
--> statement-breakpoint
CREATE INDEX idempotency_records_expiry ON tpa.idempotency_records (tenant_id, expires_at)
  WHERE state <> 'EXPIRED';
--> statement-breakpoint
ALTER TABLE tpa.idempotency_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tpa.idempotency_records FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tpa.idempotency_records
  USING (tenant_id = tpa.current_tenant_id()) WITH CHECK (tenant_id = tpa.current_tenant_id());
--> statement-breakpoint
-- No DELETE/TRUNCATE grant. Lifecycle transitions are additionally enforced for
-- every role (including the table owner) by the guard trigger below.
GRANT SELECT, INSERT, UPDATE ON tpa.idempotency_records TO tpa_app;
--> statement-breakpoint
CREATE FUNCTION tpa.guard_idempotency_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Idempotency records are retained as tombstones' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Server clock owns retention; callers cannot backdate or pre-complete.
    NEW.created_at := now();
    IF NEW.state <> 'IN_PROGRESS' OR NEW.attempt <> 1 OR NEW.owner_token IS NULL THEN
      RAISE EXCEPTION 'Idempotency records start as an owned attempt' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.operation IS DISTINCT FROM OLD.operation
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash_version IS DISTINCT FROM OLD.request_hash_version
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.attempt < OLD.attempt THEN
    RAISE EXCEPTION 'Idempotency namespace, hash and retention are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'EXPIRED'
    OR (OLD.state = 'COMPLETED' AND NEW.state <> 'EXPIRED')
    OR (NEW.state = 'EXPIRED' AND OLD.expires_at > now()) THEN
    RAISE EXCEPTION 'Invalid idempotency state transition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_idempotency_guard BEFORE INSERT OR UPDATE OR DELETE ON tpa.idempotency_records
FOR EACH ROW EXECUTE FUNCTION tpa.guard_idempotency_record();
