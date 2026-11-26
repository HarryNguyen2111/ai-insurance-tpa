export interface RelayConfig {
  /** tpa_app connection; tenant context is always transaction-local (SET LOCAL). */
  databaseUrl: string;
  brokers: string[];
  clientId: string;
  /** Environment prefix, e.g. `tpa.dev` -> topics `tpa.dev.claim`, `tpa.dev.payment`. */
  topicPrefix: string;
  batchSize: number;
  maxTenantsPerCycle: number;
  pollIntervalMs: number;
  maxBackoffMs: number;
  sendTimeoutMs: number;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}`);
  return value;
}

/** Errors name the variable only; connection strings and credentials are never echoed. */
export function readRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const databaseUrl = env.EVENT_RELAY_DATABASE_URL;
  if (!databaseUrl) throw new Error('EVENT_RELAY_DATABASE_URL is required');
  let url: URL;
  try { url = new URL(databaseUrl); } catch { throw new Error('EVENT_RELAY_DATABASE_URL is invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'tpa_app') {
    throw new Error('EVENT_RELAY_DATABASE_URL must use PostgreSQL and the tpa_app role');
  }
  const brokers = (env.KAFKA_BROKERS ?? '').split(',').map(b => b.trim()).filter(Boolean);
  if (brokers.length === 0 || brokers.some(b => !/^[A-Za-z0-9.-]+:\d{1,5}$/.test(b))) {
    throw new Error('KAFKA_BROKERS must be a comma-separated host:port list');
  }
  const topicPrefix = env.EVENT_TOPIC_PREFIX ?? '';
  if (!/^[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30}){0,3}$/.test(topicPrefix)) {
    throw new Error('EVENT_TOPIC_PREFIX is required, e.g. tpa.dev');
  }
  const clientId = env.EVENT_RELAY_CLIENT_ID ?? 'tpa-event-relay';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(clientId)) throw new Error('EVENT_RELAY_CLIENT_ID is invalid');
  return {
    databaseUrl, brokers, clientId, topicPrefix,
    batchSize: integer(env, 'EVENT_RELAY_BATCH_SIZE', 100, 1, 500),
    maxTenantsPerCycle: integer(env, 'EVENT_RELAY_MAX_TENANTS', 100, 1, 1000),
    pollIntervalMs: integer(env, 'EVENT_RELAY_POLL_MS', 500, 10, 60_000),
    maxBackoffMs: integer(env, 'EVENT_RELAY_MAX_BACKOFF_MS', 30_000, 100, 600_000),
    sendTimeoutMs: integer(env, 'EVENT_RELAY_SEND_TIMEOUT_MS', 30_000, 1000, 120_000),
  };
}
