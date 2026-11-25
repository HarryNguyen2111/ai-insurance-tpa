-- Infrastructure only: deliberately no copied baseline or business tables.
CREATE SCHEMA tpa AUTHORIZATION tpa_migrator;
--> statement-breakpoint
REVOKE ALL ON SCHEMA tpa FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA tpa TO tpa_app;
