-- BEN-03 (#34): atomic benefit limit accounts, reservations and immutable usage movements.
-- Invariant: used_amount + reserved_amount <= limit_amount per contract-year/limit-group account.
-- Money is NUMERIC(15,2); all arithmetic happens here, never in JS floats. Synthetic data only.
CREATE TABLE tpa.benefit_accounts (
  tenant_id uuid NOT NULL, id uuid NOT NULL,
  member_id uuid NOT NULL, plan_id uuid NOT NULL,
  benefit_type varchar(40) NOT NULL
    CHECK (benefit_type IN ('OUTPATIENT','INPATIENT','DENTAL','MATERNITY','ACCIDENT','HOSPITAL_INCOME')),
  limit_group varchar(40) NOT NULL CHECK (limit_group IN ('ANNUAL')),
  period_start date NOT NULL, period_end date NOT NULL,
  coverage_id uuid NOT NULL, rule_version_id uuid NOT NULL, policy_version_id uuid NOT NULL, clause_id uuid NOT NULL,
  limit_amount numeric(15,2) NOT NULL CHECK (limit_amount >= 0),
  used_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (used_amount >= 0),
  reserved_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,member_id,plan_id,benefit_type,limit_group,period_start),
  CONSTRAINT benefit_accounts_no_overspend CHECK (used_amount + reserved_amount <= limit_amount),
  CONSTRAINT benefit_accounts_contract_year CHECK (period_end >= period_start AND period_end < period_start + interval '1 year'),
  FOREIGN KEY (tenant_id,coverage_id,rule_version_id,policy_version_id)
    REFERENCES tpa.member_coverages(tenant_id,id,rule_version_id,policy_version_id),
  FOREIGN KEY (tenant_id,policy_version_id,clause_id) REFERENCES tpa.contract_clauses(tenant_id,policy_version_id,id)
);
--> statement-breakpoint
CREATE TABLE tpa.benefit_reservations (
  tenant_id uuid NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL, claim_id uuid NOT NULL,
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  consumed_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK (consumed_amount >= 0 AND consumed_amount <= amount),
  status varchar(16) NOT NULL CHECK (status IN ('HELD','CONSUMED','RELEASED','EXPIRED')),
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,id,account_id),
  CHECK ((status = 'CONSUMED') = (consumed_amount > 0)),
  FOREIGN KEY (tenant_id,account_id) REFERENCES tpa.benefit_accounts(tenant_id,id)
);
--> statement-breakpoint
-- One live hold per claim/account; a retry must reuse its operation key.
CREATE UNIQUE INDEX benefit_reservations_one_held ON tpa.benefit_reservations (tenant_id,claim_id,account_id) WHERE status = 'HELD';
--> statement-breakpoint
CREATE INDEX benefit_reservations_due ON tpa.benefit_reservations (tenant_id,expires_at) WHERE status = 'HELD';
--> statement-breakpoint
CREATE INDEX benefit_reservations_account_held ON tpa.benefit_reservations (tenant_id,account_id) WHERE status = 'HELD';
--> statement-breakpoint
CREATE TABLE tpa.benefit_movements (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL, reservation_id uuid NOT NULL,
  operation_key varchar(100),
  movement_type varchar(16) NOT NULL CHECK (movement_type IN ('RESERVE','CONSUME','RELEASE','EXPIRE')),
  reserved_delta numeric(15,2) NOT NULL, used_delta numeric(15,2) NOT NULL,
  reserved_after numeric(15,2) NOT NULL, used_after numeric(15,2) NOT NULL,
  account_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (seq), UNIQUE (tenant_id,account_id,account_version),
  CHECK (CASE movement_type
    WHEN 'RESERVE' THEN reserved_delta > 0 AND used_delta = 0
    WHEN 'CONSUME' THEN reserved_delta < 0 AND used_delta > 0 AND used_delta <= -reserved_delta
    ELSE reserved_delta < 0 AND used_delta = 0 END),
  FOREIGN KEY (tenant_id,reservation_id,account_id) REFERENCES tpa.benefit_reservations(tenant_id,id,account_id)
);
--> statement-breakpoint
CREATE INDEX benefit_movements_account ON tpa.benefit_movements (tenant_id,account_id,seq);
--> statement-breakpoint
-- Semantic idempotency for acquire/consume/release: same key + same request hash replays result.
CREATE TABLE tpa.benefit_operations (
  tenant_id uuid NOT NULL, operation_key varchar(100) NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9._:-]{16,100}$'),
  operation_type varchar(16) NOT NULL CHECK (operation_type IN ('ACQUIRE','CONSUME','RELEASE')),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,operation_key)
);
--> statement-breakpoint
CREATE FUNCTION tpa.guard_benefit_ledger() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE acct tpa.benefit_accounts;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Benefit ledger rows cannot be deleted' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME = 'benefit_movements' THEN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Benefit movements are immutable' USING ERRCODE='42501'; END IF;
    NEW.created_at := now();
    -- Cross-check the journal against the already-updated, locked account row.
    SELECT * INTO acct FROM tpa.benefit_accounts WHERE tenant_id=NEW.tenant_id AND id=NEW.account_id;
    IF NOT FOUND OR acct.reserved_amount <> NEW.reserved_after OR acct.used_amount <> NEW.used_after
      OR acct.version <> NEW.account_version THEN
      RAISE EXCEPTION 'Benefit movement does not match account state' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'benefit_accounts' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.used_amount := 0; NEW.reserved_amount := 0; NEW.version := 1;
      NEW.created_at := now(); NEW.updated_at := now(); RETURN NEW;
    END IF;
    IF (NEW.tenant_id,NEW.id,NEW.member_id,NEW.plan_id,NEW.benefit_type,NEW.limit_group,NEW.period_start,NEW.period_end,
        NEW.coverage_id,NEW.rule_version_id,NEW.policy_version_id,NEW.clause_id,NEW.limit_amount,NEW.created_at)
      IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.member_id,OLD.plan_id,OLD.benefit_type,OLD.limit_group,OLD.period_start,OLD.period_end,
        OLD.coverage_id,OLD.rule_version_id,OLD.policy_version_id,OLD.clause_id,OLD.limit_amount,OLD.created_at)
      OR NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Benefit account limit/identity is immutable' USING ERRCODE='42501';
    END IF;
    NEW.updated_at := now(); RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'benefit_reservations' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'HELD' OR NEW.consumed_amount <> 0 OR NEW.version <> 1 THEN
        RAISE EXCEPTION 'Reservations start HELD' USING ERRCODE='23514';
      END IF;
      NEW.created_at := now(); NEW.updated_at := now(); RETURN NEW;
    END IF;
    IF OLD.status <> 'HELD' OR NEW.status = 'HELD' OR NEW.version <> OLD.version + 1
      OR (NEW.tenant_id,NEW.id,NEW.account_id,NEW.claim_id,NEW.amount,NEW.expires_at,NEW.created_at)
        IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.account_id,OLD.claim_id,OLD.amount,OLD.expires_at,OLD.created_at)
      OR (NEW.status = 'EXPIRED' AND NEW.expires_at > now()) THEN
      RAISE EXCEPTION 'Invalid reservation transition' USING ERRCODE='23514';
    END IF;
    NEW.updated_at := now(); RETURN NEW;
  END IF;
  -- benefit_operations: result is written once, in the inserting transaction.
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); RETURN NEW; END IF;
  IF OLD.result IS NOT NULL OR NEW.result IS NULL
    OR (NEW.tenant_id,NEW.operation_key,NEW.operation_type,NEW.request_hash,NEW.created_at)
      IS DISTINCT FROM (OLD.tenant_id,OLD.operation_key,OLD.operation_type,OLD.request_hash,OLD.created_at) THEN
    RAISE EXCEPTION 'Benefit operation results are immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['benefit_accounts','benefit_reservations','benefit_movements','benefit_operations'] LOOP
    EXECUTE format('ALTER TABLE tpa.%I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE tpa.%I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON tpa.%I USING (tenant_id = tpa.current_tenant_id()) WITH CHECK (tenant_id = tpa.current_tenant_id())', tab);
    EXECUTE format('GRANT SELECT, INSERT ON tpa.%I TO tpa_app', tab);
    EXECUTE format('CREATE TRIGGER benefit_ledger_guard BEFORE INSERT OR UPDATE OR DELETE ON tpa.%I FOR EACH ROW EXECUTE FUNCTION tpa.guard_benefit_ledger()', tab);
    EXECUTE format('CREATE TRIGGER benefit_ledger_no_truncate BEFORE TRUNCATE ON tpa.%I FOR EACH STATEMENT EXECUTE FUNCTION tpa.guard_benefit_ledger()', tab);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT UPDATE (used_amount, reserved_amount, version) ON tpa.benefit_accounts TO tpa_app;
--> statement-breakpoint
GRANT UPDATE (status, consumed_amount, version) ON tpa.benefit_reservations TO tpa_app;
--> statement-breakpoint
GRANT UPDATE (result) ON tpa.benefit_operations TO tpa_app;
