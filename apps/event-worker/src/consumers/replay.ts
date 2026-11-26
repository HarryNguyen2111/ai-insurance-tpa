import {
  discardParkedEvent, listParkedEvents, replayParkedEvents, ReplayDeniedError,
  type InboxHandler, type ReplayAuthorizer,
} from '@tpa/database/inbox';
import type { TenantDatabase } from '@tpa/database/tenant';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Interim operator authorization until AUTH-01 (#21) supplies verified OIDC
 * roles: an explicit allowlist of operator UUIDs (EVENT_REPLAY_OPERATORS).
 * Unset/empty/malformed -> deny everything (fail closed).
 */
export function allowlistAuthorizer(raw: string | undefined): ReplayAuthorizer {
  const ids = (raw ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const valid = ids.length > 0 && ids.every(id => UUID.test(id));
  const allowed = new Set(valid ? ids : []);
  return async request => allowed.has(request.actorId);
}

export class ReplayUsageError extends Error {
  constructor(message: string) { super(message); this.name = 'ReplayUsageError'; }
}
const USAGE = 'usage: <list|replay|discard> --tenant <uuid> --consumer <name> [--operator <uuid>] [--parked <uuid>[,<uuid>...]] [--limit <n>]';

function parseArgs(argv: readonly string[]): { command: string; flags: Map<string, string> } {
  const [command, ...rest] = argv;
  if (!command || !['list', 'replay', 'discard'].includes(command)) throw new ReplayUsageError(USAGE);
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (!['--tenant', '--consumer', '--operator', '--parked', '--limit'].includes(flag) || value === undefined || flags.has(flag)) {
      throw new ReplayUsageError(USAGE);
    }
    flags.set(flag, value);
  }
  return { command, flags };
}

export interface ReplayCommandDeps {
  db: TenantDatabase;
  handlers: readonly InboxHandler[];
  authorize: ReplayAuthorizer;
  /** Receives one JSON line per result: ids, codes and counts only. */
  out(line: string): void;
}

/**
 * Operator command for parked events (see docs/runbooks/event-inbox-replay.md).
 * Every replay/discard is authorized first and audited by the database layer.
 */
export async function runReplayCommand(argv: readonly string[], deps: ReplayCommandDeps): Promise<void> {
  const { command, flags } = parseArgs(argv);
  const tenant = flags.get('--tenant') ?? '';
  const consumer = flags.get('--consumer') ?? '';
  if (!UUID.test(tenant)) throw new ReplayUsageError('--tenant must be a lowercase UUID');
  const handler = deps.handlers.find(h => h.consumerName === consumer);
  if (!handler) throw new ReplayUsageError('--consumer is not a registered inbox consumer');
  if (command === 'list') {
    for (const parked of await listParkedEvents(deps.db, tenant, consumer)) deps.out(JSON.stringify(parked));
    return;
  }
  const operator = flags.get('--operator') ?? '';
  if (!UUID.test(operator)) throw new ReplayUsageError('--operator must be the operator UUID');
  const parkedIds = flags.get('--parked')?.split(',').map(s => s.trim());
  if (parkedIds && !parkedIds.every(id => UUID.test(id))) throw new ReplayUsageError('--parked must be UUIDs');
  if (command === 'replay') {
    const limit = flags.has('--limit') ? Number(flags.get('--limit')) : undefined;
    const summary = await replayParkedEvents(deps.db, handler, tenant, { actorId: operator, parkedIds, limit }, deps.authorize);
    deps.out(JSON.stringify({ command, consumer, ...summary }));
    return;
  }
  if (!parkedIds || parkedIds.length !== 1) throw new ReplayUsageError('discard requires exactly one --parked id');
  const discarded = await discardParkedEvent(deps.db, tenant, consumer, parkedIds[0], operator, deps.authorize);
  deps.out(JSON.stringify({ command, consumer, parkedId: parkedIds[0], discarded }));
}

export { ReplayDeniedError };
