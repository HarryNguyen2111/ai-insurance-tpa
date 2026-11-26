-- BEN-01: approved technical snapshots, no seeded policy/legal defaults or PII.
CREATE TABLE tpa.policy_versions (
  tenant_id uuid NOT NULL, id uuid NOT NULL, policy_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  effective_from date NOT NULL, effective_to date NOT NULL CHECK (effective_to >= effective_from),
  content_hash varchar(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  approval_reference uuid NOT NULL, definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,policy_id,version_no)
);
--> statement-breakpoint
CREATE TABLE tpa.contract_clauses (
  tenant_id uuid NOT NULL, id uuid NOT NULL, policy_version_id uuid NOT NULL,
  source_version jsonb NOT NULL CHECK (jsonb_typeof(source_version)='object'),
  contract_clause_cited text NOT NULL CHECK (length(btrim(contract_clause_cited)) BETWEEN 1 AND 4000),
  explanation_vi text NOT NULL CHECK (length(btrim(explanation_vi)) BETWEEN 1 AND 4000),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,policy_version_id,id),
  FOREIGN KEY (tenant_id,policy_version_id) REFERENCES tpa.policy_versions(tenant_id,id)
);
--> statement-breakpoint
CREATE TABLE tpa.endorsements (
  tenant_id uuid NOT NULL, id uuid NOT NULL, policy_version_id uuid NOT NULL, clause_id uuid NOT NULL,
  priority integer NOT NULL CHECK (priority >= 0),
  effective_from date NOT NULL, effective_to date NOT NULL CHECK (effective_to >= effective_from),
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms)='object'),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,policy_version_id,priority),
  FOREIGN KEY (tenant_id,policy_version_id,clause_id) REFERENCES tpa.contract_clauses(tenant_id,policy_version_id,id)
);
--> statement-breakpoint
CREATE TABLE tpa.benefit_rule_versions (
  tenant_id uuid NOT NULL, id uuid NOT NULL, plan_id uuid NOT NULL, policy_version_id uuid NOT NULL, clause_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0), benefit_type varchar(40) NOT NULL
    CHECK (benefit_type IN ('OUTPATIENT','INPATIENT','DENTAL','MATERNITY','ACCIDENT','HOSPITAL_INCOME')),
  effective_from date NOT NULL, effective_to date NOT NULL CHECK (effective_to >= effective_from),
  annual_limit numeric(15,2) NOT NULL CHECK (annual_limit >= 0), per_visit_limit numeric(15,2) CHECK (per_visit_limit >= 0),
  deductible_per_claim numeric(15,2) NOT NULL CHECK (deductible_per_claim >= 0),
  copay_insurer_pct numeric(5,2) NOT NULL CHECK (copay_insurer_pct BETWEEN 0 AND 100),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
  content_hash varchar(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'), approval_reference uuid NOT NULL,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,plan_id,benefit_type,version_no), UNIQUE (tenant_id,id,policy_version_id,plan_id),
  FOREIGN KEY (tenant_id,policy_version_id,clause_id) REFERENCES tpa.contract_clauses(tenant_id,policy_version_id,id)
);
--> statement-breakpoint
CREATE TABLE tpa.member_coverages (
  tenant_id uuid NOT NULL, id uuid NOT NULL, member_id uuid NOT NULL, plan_id uuid NOT NULL,
  policy_version_id uuid NOT NULL, rule_version_id uuid NOT NULL, version_no integer NOT NULL CHECK (version_no > 0),
  effective_from date NOT NULL, effective_to date NOT NULL CHECK (effective_to >= effective_from),
  premium_paid boolean NOT NULL, guardian_member_id uuid,
  content_hash varchar(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'), approval_reference uuid NOT NULL,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,member_id,plan_id,version_no),
  UNIQUE (tenant_id,id,rule_version_id,policy_version_id),
  FOREIGN KEY (tenant_id,rule_version_id,policy_version_id,plan_id)
    REFERENCES tpa.benefit_rule_versions(tenant_id,id,policy_version_id,plan_id)
);
--> statement-breakpoint
CREATE TABLE tpa.policy_version_usages (
  tenant_id uuid NOT NULL, id uuid NOT NULL, claim_id uuid NOT NULL,
  coverage_version_id uuid NOT NULL, rule_version_id uuid NOT NULL, policy_version_id uuid NOT NULL,
  visit_date date NOT NULL, selection_context jsonb NOT NULL CHECK (jsonb_typeof(selection_context)='object'), snapshot_hash varchar(64) NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,claim_id),
  FOREIGN KEY (tenant_id,coverage_version_id,rule_version_id,policy_version_id)
    REFERENCES tpa.member_coverages(tenant_id,id,rule_version_id,policy_version_id)
);
--> statement-breakpoint
CREATE FUNCTION tpa.guard_policy_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE parent tpa.policy_versions; parent_rule tpa.benefit_rule_versions;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Policy snapshots are immutable' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME = 'policy_versions' THEN
    NEW.created_xid := pg_current_xact_id(); NEW.created_at := now(); RETURN NEW;
  END IF;
  SELECT * INTO parent FROM tpa.policy_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.policy_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Policy reference is inaccessible' USING ERRCODE='23503'; END IF;
  IF TG_TABLE_NAME IN ('contract_clauses','endorsements') AND parent.created_xid <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'Policy children must be committed with snapshot' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME IN ('endorsements','benefit_rule_versions','member_coverages') THEN
    IF NEW.effective_from < parent.effective_from OR NEW.effective_to > parent.effective_to THEN
      RAISE EXCEPTION 'Effective interval outside policy' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'member_coverages' THEN
    SELECT * INTO parent_rule FROM tpa.benefit_rule_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.rule_version_id;
    IF NEW.effective_from < parent_rule.effective_from OR NEW.effective_to > parent_rule.effective_to THEN
      RAISE EXCEPTION 'Effective interval outside rule' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['policy_versions','contract_clauses','endorsements','benefit_rule_versions','member_coverages','policy_version_usages'] LOOP
    EXECUTE format('ALTER TABLE tpa.%I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE tpa.%I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON tpa.%I USING (tenant_id = tpa.current_tenant_id()) WITH CHECK (tenant_id = tpa.current_tenant_id())', tab);
    EXECUTE format('GRANT SELECT, INSERT ON tpa.%I TO tpa_app', tab);
    EXECUTE format('CREATE TRIGGER snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON tpa.%I FOR EACH ROW EXECUTE FUNCTION tpa.guard_policy_snapshot()', tab);
    EXECUTE format('CREATE TRIGGER snapshot_no_truncate BEFORE TRUNCATE ON tpa.%I FOR EACH STATEMENT EXECUTE FUNCTION tpa.guard_policy_snapshot()', tab);
  END LOOP;
END $$;
