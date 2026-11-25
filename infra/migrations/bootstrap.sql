-- Administrator-only, dedicated synthetic/dev database bootstrap. Run with psql
-- -X --set ON_ERROR_STOP=1. Never run through the application connection.
BEGIN;
DO $$
BEGIN
  IF current_setting('server_version_num')::integer NOT BETWEEN 160000 AND 169999 THEN
    RAISE EXCEPTION 'PostgreSQL 16 required';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tpa_migrator') THEN
    CREATE ROLE tpa_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tpa_app') THEN
    CREATE ROLE tpa_app LOGIN;
  END IF;
  -- Fail closed on pre-existing elevated/membership roles rather than silently
  -- changing a shared cluster role. Use dedicated roles on a dedicated DB.
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('tpa_app', 'tpa_migrator')
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      WHERE r.rolname IN ('tpa_app', 'tpa_migrator')) THEN
    RAISE EXCEPTION 'TPA roles must be unprivileged and have no role memberships';
  END IF;
  IF EXISTS (SELECT FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
      WHERE d.datname = current_database() AND r.rolname IN ('tpa_app', 'tpa_migrator')) THEN
    RAISE EXCEPTION 'TPA roles must not own the database';
  END IF;
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC, tpa_app, tpa_migrator', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO tpa_app, tpa_migrator', current_database());
  EXECUTE format('GRANT CREATE ON DATABASE %I TO tpa_migrator', current_database());
END $$;
ALTER ROLE tpa_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE tpa_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, tpa_app, tpa_migrator;
-- pgvector's installation requires the administrator; migrator never has superuser.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
COMMIT;
-- Passwords are deliberately absent. Provision with psql \password interactively
-- or your secret manager. Re-running this file never resets passwords.
