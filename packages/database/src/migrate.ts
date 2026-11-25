import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';

// Works from both src/ and tsc's dist/src/ inside the monorepo checkout.
let packageRoot = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(packageRoot, 'package.json'))) {
  const parent = dirname(packageRoot);
  if (parent === packageRoot) throw new Error('Database package root missing');
  packageRoot = parent;
}
const defaultFolder = resolve(packageRoot, '../../infra/migrations');

export async function migrateDatabase(connectionString: string, migrationsFolder = defaultFolder): Promise<void> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const { rows: [role] } = await client.query(`SELECT current_user AS name,
      r.rolsuper, r.rolbypassrls, current_setting('server_version_num')::int AS version
      FROM pg_roles r WHERE rolname = current_user`);
    if (role.name !== 'tpa_migrator' || role.rolsuper || role.rolbypassrls || role.version < 160000 || role.version >= 170000) {
      throw new Error('Migrations require PostgreSQL 16 and the unprivileged tpa_migrator role');
    }
    // One dedicated connection: session lock is released by connection close on
    // every failure, including disconnect. Not an application/PgBouncer path.
    await client.query('SELECT pg_advisory_lock(151501, 1)');
    const { rows: extensions } = await client.query(`SELECT extname FROM pg_extension
      WHERE extname IN ('vector', 'pg_trgm', 'pgcrypto')`);
    if (extensions.length !== 3) throw new Error('Run administrator bootstrap before migrating');
    const files = readMigrationFiles({ migrationsFolder });
    if (files.some((file, index) => index > 0 && file.folderMillis <= files[index - 1].folderMillis)) {
      throw new Error('Migration timestamps must be strictly increasing');
    }
    const { rows: [history] } = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS table_name");
    if (history.table_name) {
      const { rows } = await client.query('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id');
      for (const [index, row] of rows.entries()) {
        if (!files[index] || row.hash !== files[index].hash || row.created_at !== String(files[index].folderMillis)) {
          throw new Error('Migration history differs from committed files; append migrations, never edit applied SQL');
        }
      }
    }
    await migrate(drizzle(client), { migrationsFolder, migrationsSchema: 'drizzle', migrationsTable: '__drizzle_migrations' });
  } finally {
    await client.end();
  }
}
