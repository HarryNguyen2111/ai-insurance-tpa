-- PAY-01 (#44): balanced immutable double-entry journal and protected float balances. Synthetic funds only.
-- Invariants (enforced here, not only in application code):
--  * every journal entry has >= 2 lines and SUM(debit) = SUM(credit) per currency, checked at COMMIT by a
--    DEFERRABLE INITIALLY DEFERRED constraint trigger: an unbalanced entry fails the whole transaction;
--  * entries/lines are append-only (no UPDATE/DELETE/TRUNCATE); lines can only be added by the transaction that
--    inserted their entry, so a POSTED entry can never change after commit. Corrections are a new REVERSAL entry
--    that must exactly mirror the original (one reversal per original, a reversal is not itself reversible);
--  * ledger_accounts.balance is a projection maintained ONLY by the journal-line trigger under the account row
--    lock (tpa_app has no grant to change it) and CHECK (balance >= 0): concurrent postings can never overdraw;
--  * posted journal_lines are the reconciliation source of truth (balance/totals/version recomputable from lines).
-- Money is NUMERIC(15,2); PostgreSQL does all arithmetic.
CREATE TABLE tpa.ledger_accounts (
  tenant_id uuid NOT NULL, id uuid NOT NULL,
  purpose varchar(32) NOT NULL CHECK (purpose IN ('INSURER_FLOAT','SETTLEMENT_BANK','PAYOUT_CLEARING')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  normal_side varchar(6) NOT NULL,
  balance numeric(15,2) NOT NULL DEFAULT 0,
  debit_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (debit_total >= 0),
  credit_total numeric(15,2) NOT NULL DEFAULT 0 CHECK (credit_total >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,id,currency), UNIQUE (tenant_id,purpose,currency),
  -- SETTLEMENT_BANK is an asset (debit-normal); insurer float and payout clearing are liabilities (credit-normal).
  CONSTRAINT ledger_accounts_normal_side CHECK (normal_side = CASE purpose WHEN 'SETTLEMENT_BANK' THEN 'DEBIT' ELSE 'CREDIT' END),
  CONSTRAINT ledger_accounts_no_overdraw CHECK (balance >= 0),
  CONSTRAINT ledger_accounts_balance_totals CHECK (balance = CASE normal_side
    WHEN 'DEBIT' THEN debit_total - credit_total ELSE credit_total - debit_total END)
);
--> statement-breakpoint
CREATE TABLE tpa.journal_entries (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL, id uuid NOT NULL,
  entry_type varchar(20) NOT NULL CHECK (entry_type IN ('FLOAT_TOPUP','PAYOUT_COMMIT','PAYOUT_SETTLE','REVERSAL')),
  status varchar(10) NOT NULL DEFAULT 'POSTED' CHECK (status = 'POSTED'),
  reverses_entry_id uuid,
  reason_code varchar(40) CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  claim_id uuid, payment_id uuid,
  idempotency_key varchar(100) NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{16,100}$'),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  posted_by_type varchar(10) NOT NULL CHECK (posted_by_type IN ('USER','SERVICE','SYSTEM')),
  posted_by_id uuid NOT NULL,
  posted_txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  posted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (seq), UNIQUE (tenant_id,idempotency_key), UNIQUE (tenant_id,reverses_entry_id),
  CONSTRAINT journal_entries_reversal_shape CHECK ((entry_type = 'REVERSAL') = (reverses_entry_id IS NOT NULL)
    AND (entry_type = 'REVERSAL') = (reason_code IS NOT NULL)),
  FOREIGN KEY (tenant_id,reverses_entry_id) REFERENCES tpa.journal_entries(tenant_id,id)
);
--> statement-breakpoint
CREATE INDEX journal_entries_claim ON tpa.journal_entries (tenant_id,claim_id) WHERE claim_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX journal_entries_payment ON tpa.journal_entries (tenant_id,payment_id) WHERE payment_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE tpa.journal_lines (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL, entry_id uuid NOT NULL,
  line_no smallint NOT NULL CHECK (line_no BETWEEN 1 AND 100),
  account_id uuid NOT NULL, currency char(3) NOT NULL,
  side varchar(6) NOT NULL CHECK (side IN ('DEBIT','CREDIT')),
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  -- Set by the trigger from the locked account row; caller values are overwritten.
  balance_after numeric(15,2) NOT NULL, account_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,entry_id,line_no), UNIQUE (seq), UNIQUE (tenant_id,account_id,account_version),
  FOREIGN KEY (tenant_id,entry_id) REFERENCES tpa.journal_entries(tenant_id,id),
  FOREIGN KEY (tenant_id,account_id,currency) REFERENCES tpa.ledger_accounts(tenant_id,id,currency)
);
--> statement-breakpoint
CREATE INDEX journal_lines_account ON tpa.journal_lines (tenant_id,account_id,account_version);
--> statement-breakpoint
CREATE FUNCTION tpa.guard_ledger_account() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Ledger accounts cannot be deleted' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.normal_side := CASE NEW.purpose WHEN 'SETTLEMENT_BANK' THEN 'DEBIT' ELSE 'CREDIT' END;
    NEW.balance := 0; NEW.debit_total := 0; NEW.credit_total := 0; NEW.version := 1;
    NEW.created_at := now(); NEW.updated_at := now(); RETURN NEW;
  END IF;
  -- Depth 1 = a direct UPDATE statement; only the journal-line trigger (depth >= 2) may move balances.
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Ledger balances change only through posted journal lines' USING ERRCODE='42501';
  END IF;
  IF (NEW.tenant_id,NEW.id,NEW.purpose,NEW.currency,NEW.normal_side,NEW.created_at)
      IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.purpose,OLD.currency,OLD.normal_side,OLD.created_at)
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Ledger account identity is immutable' USING ERRCODE='42501';
  END IF;
  NEW.updated_at := now(); RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION tpa.prevent_journal_modification() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$ BEGIN
  RAISE EXCEPTION 'Posted journal entries are immutable; post a reversal instead' USING ERRCODE='42501';
END $$;
--> statement-breakpoint
CREATE FUNCTION tpa.guard_journal_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE original_type text;
BEGIN
  NEW.status := 'POSTED'; NEW.posted_txid := pg_current_xact_id(); NEW.posted_at := now();
  IF NEW.reverses_entry_id IS NOT NULL THEN
    SELECT e.entry_type INTO original_type FROM tpa.journal_entries e
      WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.reverses_entry_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reversed journal entry not found' USING ERRCODE='23503'; END IF;
    IF original_type = 'REVERSAL' THEN
      RAISE EXCEPTION 'A reversal cannot be reversed' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- SECURITY DEFINER (owner tpa_migrator, still under FORCE RLS with the transaction tenant): the only path that
-- changes ledger_accounts balances. The UPDATE takes the account row lock and re-reads the latest committed row,
-- so concurrent postings serialize and CHECK (balance >= 0) rejects any overdraw.
CREATE FUNCTION tpa.apply_journal_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE entry_txid xid8; new_balance numeric(15,2); new_version integer;
BEGIN
  SELECT e.posted_txid INTO entry_txid FROM tpa.journal_entries e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Journal entry not found' USING ERRCODE='23503'; END IF;
  IF entry_txid <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'Posted journal entries are immutable; post a reversal instead' USING ERRCODE='42501';
  END IF;
  UPDATE tpa.ledger_accounts a SET
      debit_total = a.debit_total + CASE WHEN NEW.side = 'DEBIT' THEN NEW.amount ELSE 0 END,
      credit_total = a.credit_total + CASE WHEN NEW.side = 'CREDIT' THEN NEW.amount ELSE 0 END,
      balance = a.balance + CASE WHEN NEW.side = a.normal_side THEN NEW.amount ELSE -NEW.amount END,
      version = a.version + 1
    WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id AND a.currency = NEW.currency
    RETURNING a.balance, a.version INTO new_balance, new_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ledger account not found' USING ERRCODE='23503'; END IF;
  NEW.balance_after := new_balance; NEW.account_version := new_version; NEW.created_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Commit-time double-entry check (fires once per entry, after all of the transaction's lines exist).
-- SET CONSTRAINTS ... IMMEDIATE only makes it fail earlier (an entry without lines is unbalanced).
CREATE FUNCTION tpa.check_journal_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (SELECT count(*) FROM tpa.journal_lines l WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id) < 2 THEN
    RAISE EXCEPTION 'Journal entry needs at least two lines' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM tpa.journal_lines l WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id
      GROUP BY l.currency
      HAVING sum(l.amount) FILTER (WHERE l.side = 'DEBIT') IS DISTINCT FROM sum(l.amount) FILTER (WHERE l.side = 'CREDIT')) THEN
    RAISE EXCEPTION 'Journal entry is not balanced per currency' USING ERRCODE='23514';
  END IF;
  IF NEW.reverses_entry_id IS NOT NULL AND EXISTS (
      (SELECT l.account_id, l.currency, CASE l.side WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END, l.amount
         FROM tpa.journal_lines l WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.reverses_entry_id
       EXCEPT ALL
       SELECT l.account_id, l.currency, l.side, l.amount
         FROM tpa.journal_lines l WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id)
      UNION ALL
      (SELECT l.account_id, l.currency, l.side, l.amount
         FROM tpa.journal_lines l WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id
       EXCEPT ALL
       SELECT l.account_id, l.currency, CASE l.side WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END, l.amount
         FROM tpa.journal_lines l WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.reverses_entry_id)) THEN
    RAISE EXCEPTION 'A reversal must exactly mirror the reversed entry' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER ledger_account_guard BEFORE INSERT OR UPDATE OR DELETE ON tpa.ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION tpa.guard_ledger_account();
--> statement-breakpoint
CREATE TRIGGER ledger_account_no_truncate BEFORE TRUNCATE ON tpa.ledger_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION tpa.guard_ledger_account();
--> statement-breakpoint
CREATE TRIGGER journal_entry_guard BEFORE INSERT ON tpa.journal_entries
  FOR EACH ROW EXECUTE FUNCTION tpa.guard_journal_entry();
--> statement-breakpoint
CREATE TRIGGER journal_entry_immutable BEFORE UPDATE OR DELETE ON tpa.journal_entries
  FOR EACH ROW EXECUTE FUNCTION tpa.prevent_journal_modification();
--> statement-breakpoint
CREATE TRIGGER journal_entry_no_truncate BEFORE TRUNCATE ON tpa.journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION tpa.prevent_journal_modification();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entry_balanced AFTER INSERT ON tpa.journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tpa.check_journal_entry();
--> statement-breakpoint
CREATE TRIGGER journal_line_apply BEFORE INSERT ON tpa.journal_lines
  FOR EACH ROW EXECUTE FUNCTION tpa.apply_journal_line();
--> statement-breakpoint
CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE ON tpa.journal_lines
  FOR EACH ROW EXECUTE FUNCTION tpa.prevent_journal_modification();
--> statement-breakpoint
CREATE TRIGGER journal_line_no_truncate BEFORE TRUNCATE ON tpa.journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION tpa.prevent_journal_modification();
--> statement-breakpoint
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['ledger_accounts','journal_entries','journal_lines'] LOOP
    EXECUTE format('ALTER TABLE tpa.%I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE tpa.%I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON tpa.%I USING (tenant_id = tpa.current_tenant_id()) WITH CHECK (tenant_id = tpa.current_tenant_id())', tab);
    EXECUTE format('GRANT SELECT, INSERT ON tpa.%I TO tpa_app', tab);
  END LOOP;
END $$;
--> statement-breakpoint
-- Only so tpa_app can take `SELECT ... FOR UPDATE` account locks in a stable order. Any direct UPDATE is
-- rejected by guard_ledger_account (depth 1); balances move only through apply_journal_line.
GRANT UPDATE (version) ON tpa.ledger_accounts TO tpa_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.guard_ledger_account() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.prevent_journal_modification() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.guard_journal_entry() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.apply_journal_line() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.check_journal_entry() FROM PUBLIC;
