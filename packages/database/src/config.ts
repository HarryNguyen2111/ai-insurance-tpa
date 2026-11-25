export function migrationUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.MIGRATION_DATABASE_URL;
  if (!value) throw new Error('MIGRATION_DATABASE_URL is required');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid migration database URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'tpa_migrator') {
    throw new Error('Migration URL must use PostgreSQL and tpa_migrator');
  }
  return value;
}
