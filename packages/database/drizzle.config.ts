import { defineConfig } from 'drizzle-kit';

// Generation is offline; only the migration runner consumes credentials.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: '../../infra/migrations',
  schemaFilter: ['tpa'],
  migrations: { schema: 'drizzle', table: '__drizzle_migrations' },
  strict: true,
});
