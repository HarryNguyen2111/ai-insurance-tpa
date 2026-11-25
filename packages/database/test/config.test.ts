import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrationUrl } from '../src/config.ts';

test('migration credentials are explicit and separate from app/admin', () => {
  assert.throws(() => migrationUrl({ DATABASE_URL: 'postgresql://tpa_app@localhost/tpa' }));
  for (const value of ['invalid', 'https://tpa_migrator@localhost/tpa', 'postgresql://postgres@localhost/tpa', 'postgresql://tpa_app@localhost/tpa']) {
    assert.throws(() => migrationUrl({ MIGRATION_DATABASE_URL: value }));
  }
  const value = 'postgresql://tpa_migrator@localhost/tpa';
  assert.equal(migrationUrl({ MIGRATION_DATABASE_URL: value }), value);
});
