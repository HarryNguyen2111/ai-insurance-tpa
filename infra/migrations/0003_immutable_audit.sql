-- Canonical v1 supports only string leaves and ASCII metadata keys.
CREATE FUNCTION tpa.audit_canonical(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE result text;
BEGIN
  IF jsonb_typeof(value) = 'string' THEN RETURN value::text; END IF;
  IF jsonb_typeof(value) <> 'object' THEN RAISE EXCEPTION 'Invalid audit value'; END IF;
  SELECT '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || tpa.audit_canonical(val), ',' ORDER BY key COLLATE "C"), '') || '}'
    INTO result FROM jsonb_each(value) AS fields(key,val);
  RETURN result;
END $$;
--> statement-breakpoint
CREATE TABLE tpa.audit_chain_heads (
  tenant_id uuid NOT NULL, entity_type varchar(50) NOT NULL, entity_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  curr_hash varchar(64) NOT NULL CHECK (curr_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, entity_type, entity_id)
);
--> statement-breakpoint
CREATE TABLE tpa.audit_logs (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL, entity_type varchar(50) NOT NULL, entity_id uuid NOT NULL,
  actor_type varchar(30) NOT NULL CHECK (actor_type IN ('SYSTEM','USER','SERVICE')),
  actor_id varchar(100) NOT NULL, action varchar(50) NOT NULL,
  payload_diff jsonb NOT NULL,
  prev_hash varchar(64) NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  curr_hash varchar(64) NOT NULL CHECK (curr_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  sequence bigint NOT NULL CHECK (sequence > 0),
  version text NOT NULL CHECK (version = '1'), occurred_at text NOT NULL,
  UNIQUE (tenant_id, entity_type, entity_id, sequence),
  UNIQUE (tenant_id, entity_type, entity_id, sequence, curr_hash),
  FOREIGN KEY (tenant_id, entity_type, entity_id) REFERENCES tpa.audit_chain_heads
);
--> statement-breakpoint
-- Local anchor inventory only; no claim of independent external custody.
CREATE TABLE tpa.audit_anchors (
  tenant_id uuid NOT NULL, entity_type varchar(50) NOT NULL, entity_id uuid NOT NULL,
  sequence bigint NOT NULL, curr_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entity_type, entity_id, sequence),
  FOREIGN KEY (tenant_id, entity_type, entity_id, sequence, curr_hash)
    REFERENCES tpa.audit_logs(tenant_id, entity_type, entity_id, sequence, curr_hash),
  CHECK (curr_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['audit_logs','audit_chain_heads','audit_anchors'] LOOP
    EXECUTE format('ALTER TABLE tpa.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE tpa.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON tpa.%I USING (tenant_id=tpa.current_tenant_id()) WITH CHECK (tenant_id=tpa.current_tenant_id())',tab);
    EXECUTE format('GRANT SELECT ON tpa.%I TO tpa_app',tab);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION tpa.prevent_audit_modification() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$ BEGIN
  RAISE EXCEPTION 'Audit records are immutable' USING ERRCODE='42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON tpa.audit_logs
FOR EACH ROW EXECUTE FUNCTION tpa.prevent_audit_modification();
--> statement-breakpoint
CREATE TRIGGER trg_anchor_immutable BEFORE UPDATE OR DELETE ON tpa.audit_anchors
FOR EACH ROW EXECUTE FUNCTION tpa.prevent_audit_modification();
--> statement-breakpoint
CREATE FUNCTION tpa.append_audit(p_entity_type text, p_entity_id uuid, p_actor_type text,
  p_actor_id uuid, p_action text, p_payload jsonb)
RETURNS TABLE(tenant_id uuid, entity_type text, entity_id uuid, actor_type text, actor_id text,
  action text, payload_diff jsonb, sequence text, version text, occurred_at text, prev_hash text, curr_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE tenant uuid := tpa.current_tenant_id(); head tpa.audit_chain_heads%ROWTYPE;
  stamp text; body jsonb; digest text; next_sequence bigint;
BEGIN
  IF p_entity_type IS NULL OR p_entity_type !~ '^[A-Z][A-Z_]{0,49}$' OR
    p_action IS NULL OR p_action !~ '^[A-Z][A-Z_]{0,49}$' OR p_entity_id IS NULL OR p_actor_id IS NULL OR
    p_actor_type IS NULL OR p_actor_type NOT IN ('SYSTEM','USER','SERVICE') OR
    p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Invalid minimal audit metadata' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT FROM jsonb_each(p_payload) f WHERE f.key NOT IN ('before_hash','after_hash')
    OR jsonb_typeof(f.value) <> 'string' OR (f.value #>> '{}') !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'Invalid minimal audit payload' USING ERRCODE='22023';
  END IF;
  INSERT INTO tpa.audit_chain_heads AS h VALUES(tenant,p_entity_type,p_entity_id,0,repeat('0',64))
    ON CONFLICT ON CONSTRAINT audit_chain_heads_pkey DO NOTHING;
  SELECT h.* INTO STRICT head FROM tpa.audit_chain_heads h
    WHERE h.tenant_id=tenant AND h.entity_type=p_entity_type AND h.entity_id=p_entity_id FOR UPDATE;
  next_sequence := head.sequence + 1;
  stamp := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  body := jsonb_build_object('tenant_id',tenant::text,'entity_type',p_entity_type,'entity_id',p_entity_id::text,
    'actor_type',p_actor_type,'actor_id',p_actor_id::text,'action',p_action,'payload_diff',p_payload,
    'sequence',next_sequence::text,'version','1','occurred_at',stamp,'prev_hash',head.curr_hash);
  digest := encode(public.digest(convert_to(tpa.audit_canonical(body),'UTF8'),'sha256'),'hex');
  INSERT INTO tpa.audit_logs(tenant_id,entity_type,entity_id,actor_type,actor_id,action,payload_diff,
    prev_hash,curr_hash,created_at,sequence,version,occurred_at)
    VALUES(tenant,p_entity_type,p_entity_id,p_actor_type,p_actor_id::text,p_action,p_payload,
      head.curr_hash,digest,stamp::timestamptz,next_sequence,'1',stamp);
  UPDATE tpa.audit_chain_heads h SET sequence=next_sequence,curr_hash=digest
    WHERE h.tenant_id=tenant AND h.entity_type=p_entity_type AND h.entity_id=p_entity_id;
  RETURN QUERY SELECT tenant,p_entity_type,p_entity_id,p_actor_type,p_actor_id::text,p_action,p_payload,
    next_sequence::text,'1'::text,stamp,head.curr_hash::text,digest;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.append_audit(text,uuid,text,uuid,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tpa.append_audit(text,uuid,text,uuid,text,jsonb) TO tpa_app;
