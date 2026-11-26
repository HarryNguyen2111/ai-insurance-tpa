import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWorkflowWorkerConfig } from '../src/config.ts';

test('worker configuration requires the unprivileged role and server-owned Temporal address', () => {
  const env = { WORKFLOW_DATABASE_URL: 'postgresql://tpa_app:synthetic@localhost/tpa', TEMPORAL_ADDRESS: 'localhost:7233' };
  assert.deepEqual(readWorkflowWorkerConfig(env), { databaseUrl: env.WORKFLOW_DATABASE_URL, temporalAddress: env.TEMPORAL_ADDRESS, namespace: 'default' });
  for (const invalid of [{}, { ...env, WORKFLOW_DATABASE_URL: 'postgresql://postgres:secret@localhost/tpa' },
    { ...env, TEMPORAL_ADDRESS: 'http://localhost:7233' }, { ...env, TEMPORAL_NAMESPACE: 'PII/invalid' }]) {
    assert.throws(() => readWorkflowWorkerConfig(invalid), e => e instanceof Error && !e.message.includes('secret') && !e.message.includes('PII'));
  }
});
