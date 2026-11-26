-- Reusable policy expression. Missing/empty context fails closed with 42501;
-- malformed UUID fails closed with 22P02. No SECURITY DEFINER or bypass role.
CREATE FUNCTION tpa.current_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE tenant text := pg_catalog.current_setting('app.current_tenant_id', true);
BEGIN
  IF tenant IS NULL OR tenant = '' THEN
    RAISE EXCEPTION 'Tenant transaction context required' USING ERRCODE = '42501';
  END IF;
  RETURN tenant::uuid;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tpa.current_tenant_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION tpa.current_tenant_id() TO tpa_app;
