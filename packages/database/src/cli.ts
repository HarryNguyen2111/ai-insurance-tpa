import { migrationUrl } from './config.ts';
import { migrateDatabase } from './migrate.ts';

try {
  await migrateDatabase(migrationUrl());
  console.log('Database migrations complete');
} catch {
  // Driver errors can contain connection details or future business SQL values.
  console.error('Database migration failed; check role, bootstrap, connectivity and migration history');
  process.exitCode = 1;
}
