// Operator entry point: node src/consumers/replay-main.ts <list|replay|discard> ...
// Requires EVENT_REPLAY_DATABASE_URL (tpa_app) and, for replay/discard,
// EVENT_REPLAY_OPERATORS (allowlist; unset = deny). Output: JSON lines with ids/codes only.
import { createTenantDatabase } from '@tpa/database/tenant';
import { allowlistAuthorizer, runReplayCommand, ReplayDeniedError, ReplayUsageError } from './replay.ts';
import { consumerHandlers } from './registry.ts';
import { connectTemporalEngine } from '@tpa/workflow/engine';
import { createWorkflowHandler } from './workflow.ts';

const url = process.env.EVENT_REPLAY_DATABASE_URL;
let parsed: URL | undefined;
try { parsed = url ? new URL(url) : undefined; } catch { parsed = undefined; }
if (!parsed || parsed.username !== 'tpa_app') {
  console.error(JSON.stringify({ level: 'error', message: 'EVENT_REPLAY_DATABASE_URL must use the tpa_app role' }));
  process.exit(2);
}
const db = createTenantDatabase({ connectionString: url, max: 2, connectionTimeoutMillis: 10_000 });
let temporal: Awaited<ReturnType<typeof connectTemporalEngine>> | undefined;
try {
  if (process.argv[process.argv.indexOf('--consumer') + 1] === 'claim-workflow' && process.argv[2] === 'replay') {
    temporal = await connectTemporalEngine({ address: process.env.TEMPORAL_ADDRESS ?? '', namespace: process.env.TEMPORAL_NAMESPACE });
  }
  await runReplayCommand(process.argv.slice(2), {
    db, handlers: [...consumerHandlers, createWorkflowHandler(temporal?.engine ?? { async submitClaimCommand() { throw new Error('Temporal unavailable'); } })], authorize: allowlistAuthorizer(process.env.EVENT_REPLAY_OPERATORS),
    out: line => console.log(line),
  });
} catch (error) {
  const known = error instanceof ReplayUsageError || error instanceof ReplayDeniedError;
  console.error(JSON.stringify({ level: 'error', message: known ? (error as Error).message : 'replay command failed',
    errorName: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = known ? 2 : 1;
} finally {
  await Promise.allSettled([db.close(), temporal?.close()]);
}
