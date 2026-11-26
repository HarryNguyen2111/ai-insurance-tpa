import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { checkCompatibility, type CompatibilityMode } from './compatibility.ts';

export { checkCompatibility, incompatibilities, withoutVersionPin, COMPATIBILITY_MODES, type CompatibilityMode } from './compatibility.ts';

// ajv ships CommonJS; mirror @tpa/shared-contracts' validator configuration exactly.
const require = createRequire(import.meta.url);
type AjvClass = typeof import('ajv-draft-04').default;
type ValidateFn = ((value: unknown) => boolean) & { errors?: { instancePath: string; keyword: string }[] | null };
const Ajv = require('ajv-draft-04').default as AjvClass;
const addFormats = require('ajv-formats').default as (ajv: InstanceType<AjvClass>) => unknown;

export type JsonSchema = Record<string, unknown>;
export interface RegistrySubject {
  /** Logical domain topic; the relay prefixes environment, e.g. `tpa.dev.claim`. */
  topic: string;
  compatibility: CompatibilityMode;
  /** OpenAPI component that must stay byte-for-byte equivalent, or null if registry-only. */
  openapiComponent: string | null;
  /** semver -> sha256 of the canonical schema JSON. Published versions are immutable. */
  versions: Record<string, string>;
}
export interface RegistryManifest { registryVersion: 1; subjects: Record<string, RegistrySubject> }

export const REGISTRY_ROOT = new URL('../registry/', import.meta.url);
export const SEMVER = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;
export const EVENT_TYPE = /^[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30}){1,2}$/;
export const TOPIC_SEGMENT = /^[a-z][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function readManifest(root: URL = REGISTRY_ROOT): RegistryManifest {
  return JSON.parse(readFileSync(new URL('registry.json', root), 'utf8')) as RegistryManifest;
}
export function readSchema(eventType: string, version: string, root: URL = REGISTRY_ROOT): JsonSchema {
  if (!EVENT_TYPE.test(eventType) || !SEMVER.test(version)) throw new EventContractError('Invalid registry coordinates');
  return JSON.parse(readFileSync(new URL(`schemas/${eventType}/${version}.json`, root), 'utf8')) as JsonSchema;
}
/** Order-independent canonical JSON (sorted keys, no whitespace). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
export function schemaHash(schema: JsonSchema): string {
  return createHash('sha256').update(canonicalJson(schema), 'utf8').digest('hex');
}
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Fixed messages only: never echo event values (they may be misused to carry PII). */
export class EventContractError extends Error {
  readonly paths: readonly string[];
  constructor(message: string, paths: readonly string[] = []) {
    super(message);
    this.paths = paths;
    this.name = 'EventContractError';
  }
}

interface LoadedSubject extends RegistrySubject { latest: string; validators: Map<string, ValidateFn> }
function load(): Map<string, LoadedSubject> {
  const ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
  addFormats(ajv);
  const manifest = readManifest();
  const subjects = new Map<string, LoadedSubject>();
  for (const [eventType, subject] of Object.entries(manifest.subjects)) {
    const versions = Object.keys(subject.versions).sort(compareSemver);
    const validators = new Map<string, ValidateFn>();
    for (const version of versions) validators.set(version, ajv.compile(readSchema(eventType, version)) as ValidateFn);
    subjects.set(eventType, Object.freeze({ ...subject, latest: versions[versions.length - 1], validators }));
  }
  return subjects;
}
const registry = load();

export function eventTypes(): string[] { return [...registry.keys()].sort(); }
export function latestSchemaVersion(eventType: string): string {
  const subject = registry.get(eventType);
  if (!subject) throw new EventContractError('Unknown event type');
  return subject.latest;
}
export function domainTopic(eventType: string): string {
  const subject = registry.get(eventType);
  if (!subject) throw new EventContractError('Unknown event type');
  return subject.topic;
}
/** Kafka record key: ordering is per tenant aggregate, never per claim topic. */
export function partitionKey(tenantId: string, aggregateId: string): string {
  if (!UUID.test(tenantId) || !UUID.test(aggregateId)) throw new EventContractError('Partition key requires lowercase UUIDs');
  return `${tenantId}:${aggregateId}`;
}
/** Environment/domain topic, e.g. topicName('tpa.dev', 'claim') === 'tpa.dev.claim'. */
export function topicName(prefix: string, domain: string): string {
  if (!/^[a-z][a-z0-9-]{0,30}(\.[a-z][a-z0-9-]{0,30}){0,3}$/.test(prefix) || !TOPIC_SEGMENT.test(domain)) {
    throw new EventContractError('Invalid topic prefix or domain');
  }
  return `${prefix}.${domain}`;
}

export interface EventEnvelope {
  eventId: string; eventType: string; schemaVersion: string; tenantId: string;
  aggregateId: string; aggregateVersion: number; occurredAt: string;
  correlationId: string; causationId: string; payload: Record<string, unknown>;
}
export interface DomainEventDraft {
  eventType: string;
  /** Defaults to the latest registered version. */
  schemaVersion?: string;
  eventId?: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt?: Date;
  correlationId: string;
  causationId: string;
  /** Minimal non-PII facts only; consumers reload authorized state from the core. */
  payload: Record<string, unknown>;
}
export interface BuiltEvent { envelope: Readonly<EventEnvelope>; topic: string; partitionKey: string }

/** Validate an envelope against its exact registered schema version and the PII guard. */
export function validateEventEnvelope(envelope: unknown): asserts envelope is EventEnvelope {
  if (!envelope || typeof envelope !== 'object') throw new EventContractError('Event envelope must be an object');
  const { eventType, schemaVersion } = envelope as Partial<EventEnvelope>;
  const subject = typeof eventType === 'string' ? registry.get(eventType) : undefined;
  if (!subject) throw new EventContractError('Unknown event type');
  const validate = typeof schemaVersion === 'string' ? subject.validators.get(schemaVersion) : undefined;
  if (!validate) throw new EventContractError('Unregistered schema version');
  if (!validate(envelope)) {
    // instancePath/keyword are schema-derived; params (e.g. extra property names) are never surfaced.
    throw new EventContractError('Event envelope violates its registered schema',
      (validate.errors ?? []).map(e => `${e.instancePath || '/'} ${e.keyword}`));
  }
  assertNoRawPii(envelope);
}

/**
 * Build a validated envelope. `tenantId` MUST be the verified tenant of the
 * surrounding withTenantTransaction (never request input). UUIDs are lowercased
 * so the database's `uuid::text` consistency checks hold.
 */
export function buildEventEnvelope(tenantId: string, draft: DomainEventDraft): BuiltEvent {
  if (!draft || typeof draft !== 'object') throw new EventContractError('Event draft required');
  const lower = (value: unknown) => typeof value === 'string' ? value.toLowerCase() : value;
  const occurred = draft.occurredAt ?? new Date();
  if (!(occurred instanceof Date) || Number.isNaN(occurred.getTime())) throw new EventContractError('Invalid occurredAt');
  const envelope = {
    eventId: lower(draft.eventId ?? randomUUID()),
    eventType: draft.eventType,
    schemaVersion: draft.schemaVersion ?? (registry.has(draft.eventType) ? latestSchemaVersion(draft.eventType) : undefined),
    tenantId: lower(tenantId),
    aggregateId: lower(draft.aggregateId),
    aggregateVersion: draft.aggregateVersion,
    occurredAt: occurred.toISOString(),
    correlationId: lower(draft.correlationId),
    causationId: lower(draft.causationId),
    payload: draft.payload,
  };
  validateEventEnvelope(envelope);
  const frozen = deepFreeze(structuredClone(envelope)) as Readonly<EventEnvelope>;
  return { envelope: frozen, topic: domainTopic(frozen.eventType), partitionKey: partitionKey(frozen.tenantId, frozen.aggregateId) };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) deepFreeze(v); Object.freeze(value); }
  return value;
}

// Every string in an event must be one of these structured, non-personal forms.
const STRUCTURED_STRINGS: readonly RegExp[] = [
  UUID,
  /^[a-f0-9]{64}$/, // sha256 commitment
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/, // date-time
  SEMVER,
  /^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/, // Money: NUMERIC(15,2) as string
  /^[A-Z][A-Z0-9_]{0,63}$/, // enum code
  EVENT_TYPE,
];
const PII_KEYS = /(cccd|phone|bank|account|name|email|address|dob|birth|otp|passport|nationalid|iban|card)/i;

/**
 * Defence in depth behind the closed schemas (PT17): reject keys that name PII
 * and any string leaf that is not a structured code/identifier, so free text,
 * phone/CCCD/bank digits or e-mail addresses cannot reach Kafka.
 */
export function assertNoRawPii(value: unknown, path = ''): void {
  if (typeof value === 'string') {
    if (!STRUCTURED_STRINGS.some(re => re.test(value))) throw new EventContractError('Event contains an unstructured string', [path || '/']);
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => assertNoRawPii(v, `${path}/${i}`)); return; }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (PII_KEYS.test(key)) throw new EventContractError('Event contains a personal-data key', [path || '/']);
      assertNoRawPii(v, `${path}/${key}`);
    }
    return;
  }
  if (value !== null && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new EventContractError('Event contains an unsupported value', [path || '/']);
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new EventContractError('Event numbers must be safe integers; money is a decimal string', [path || '/']);
  }
}

/** Registry-wide verification used by the CI check script and tests. */
export interface RegistryIssue { eventType: string; version?: string; problem: string }
export function verifyRegistry(root: URL = REGISTRY_ROOT, openapiSchemas?: Record<string, unknown>): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const manifest = readManifest(root);
  if (manifest.registryVersion !== 1) issues.push({ eventType: '*', problem: 'registryVersion must be 1' });
  for (const [eventType, subject] of Object.entries(manifest.subjects)) {
    const add = (problem: string, version?: string) => issues.push({ eventType, version, problem });
    if (!EVENT_TYPE.test(eventType)) { add('invalid event type name'); continue; }
    if (!TOPIC_SEGMENT.test(subject.topic) || subject.topic !== eventType.split('.')[0]) add('topic must be the event type domain prefix');
    const versions = Object.keys(subject.versions);
    if (versions.length === 0) add('no versions');
    const sorted = [...versions].sort(compareSemver);
    const schemas: { version: string; schema: JsonSchema }[] = [];
    for (const version of sorted) {
      if (!SEMVER.test(version)) { add('invalid semver', version); continue; }
      let schema: JsonSchema;
      try { schema = readSchema(eventType, version, root); } catch { add('schema file missing or unreadable', version); continue; }
      if (schemaHash(schema) !== subject.versions[version]) add('published schema changed; add a new version instead of editing', version);
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      if (!equalJson(props.eventType?.enum, [eventType])) add('eventType enum must pin the subject', version);
      if (!equalJson(props.schemaVersion?.enum, [version])) add('schemaVersion enum must pin the version', version);
      for (const field of ENVELOPE_FIELDS) if (!(schema.required as string[] | undefined)?.includes(field)) add(`envelope field ${field} must be required`, version);
      if (schema.additionalProperties !== false) add('envelope must be closed (additionalProperties false)', version);
      for (const leak of unconstrainedStrings(schema)) add(`free-text string at ${leak}; use enum/format/pattern`, version);
      for (const open of openObjects(schema)) add(`open object at ${open}; set additionalProperties false`, version);
      const sameMajor = schemas.filter(s => s.version.split('.')[0] === version.split('.')[0]).map(s => s.schema);
      for (const problem of checkCompatibility(subject.compatibility, sameMajor, schema)) add(problem, version);
      schemas.push({ version, schema });
    }
    if (subject.openapiComponent !== null) {
      const latest = schemas.at(-1);
      if (!openapiSchemas) add('OpenAPI schemas not supplied for parity check');
      else if (!latest || !equalJson(openapiSchemas[subject.openapiComponent], latest.schema)) {
        add(`latest version differs from OpenAPI component ${subject.openapiComponent}`);
      }
    }
  }
  if (openapiSchemas) {
    const mapped = new Set(Object.values(manifest.subjects).map(s => s.openapiComponent));
    for (const name of Object.keys(openapiSchemas)) {
      if (/Event$/.test(name) && !mapped.has(name)) issues.push({ eventType: '*', problem: `OpenAPI event ${name} missing from registry` });
    }
  }
  return issues;
}
export const ENVELOPE_FIELDS = Object.freeze(['eventId', 'eventType', 'schemaVersion', 'tenantId', 'aggregateId',
  'aggregateVersion', 'occurredAt', 'correlationId', 'causationId', 'payload']);
function equalJson(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function walk(schema: unknown, path: string, visit: (s: JsonSchema, p: string) => void): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const s = schema as JsonSchema;
  visit(s, path);
  for (const [name, sub] of Object.entries((s.properties ?? {}) as Record<string, unknown>)) walk(sub, `${path}.${name}`, visit);
  if (s.items) walk(s.items, `${path}[]`, visit);
}
export function unconstrainedStrings(schema: JsonSchema): string[] {
  const found: string[] = [];
  walk(schema, '$', (s, p) => {
    const isString = s.type === 'string' || (Array.isArray(s.type) && s.type.includes('string'));
    if (isString && s.enum === undefined && s.format === undefined && s.pattern === undefined) found.push(p);
  });
  return found;
}
function openObjects(schema: JsonSchema): string[] {
  const found: string[] = [];
  walk(schema, '$', (s, p) => { if (s.type === 'object' && s.additionalProperties !== false) found.push(p); });
  return found;
}
