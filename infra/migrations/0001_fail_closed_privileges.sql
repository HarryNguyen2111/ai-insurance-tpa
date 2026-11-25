-- New domain objects remain inaccessible until a reviewed migration explicitly
-- grants the required operations alongside RLS/composite constraints (#16).
ALTER DEFAULT PRIVILEGES FOR ROLE tpa_migrator IN SCHEMA tpa
  REVOKE ALL ON TABLES FROM PUBLIC, tpa_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE tpa_migrator IN SCHEMA tpa
  REVOKE ALL ON SEQUENCES FROM PUBLIC, tpa_app;
--> statement-breakpoint
-- Function EXECUTE defaults are global; a schema-specific REVOKE cannot remove
-- PostgreSQL's global PUBLIC default.
ALTER DEFAULT PRIVILEGES FOR ROLE tpa_migrator
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON SCHEMA drizzle FROM PUBLIC, tpa_app;
