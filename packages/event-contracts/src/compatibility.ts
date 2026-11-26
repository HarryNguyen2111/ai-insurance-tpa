/**
 * Conservative JSON Schema (draft-04 subset) compatibility checker for the event
 * registry. `incompatibilities(writer, reader)` answers: "is EVERY document valid
 * under `writer` also valid under `reader`?". It never proves compatibility for a
 * keyword it does not understand: an unsupported keyword that differs between the
 * two schemas is reported as an incompatibility (fail closed).
 *
 * Modes follow Schema Registry terminology:
 * - BACKWARD: the new schema (reader) can read data written with the old one.
 * - FORWARD:  the old schema (reader) can read data written with the new one.
 * - FULL:     both. `*_TRANSITIVE` checks every earlier version, not just the last.
 */
export type CompatibilityMode =
  | 'BACKWARD' | 'BACKWARD_TRANSITIVE' | 'FORWARD' | 'FORWARD_TRANSITIVE' | 'FULL' | 'FULL_TRANSITIVE';
export const COMPATIBILITY_MODES: readonly CompatibilityMode[] = Object.freeze([
  'BACKWARD', 'BACKWARD_TRANSITIVE', 'FORWARD', 'FORWARD_TRANSITIVE', 'FULL', 'FULL_TRANSITIVE']);

type Schema = Record<string, unknown>;
const ANNOTATIONS = new Set(['description', 'title', '$schema', '$id', 'examples', 'default']);
const SUPPORTED = new Set(['type', 'enum', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum',
  'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems']);

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isSchema(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function types(schema: Schema): Set<string> | undefined {
  if (schema.type === undefined) return undefined;
  return new Set(Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string]);
}

export function incompatibilities(writer: unknown, reader: unknown, path = '$'): string[] {
  if (reader === true || (isSchema(reader) && Object.keys(reader).every(k => ANNOTATIONS.has(k)))) return [];
  if (writer === false) return [];
  if (!isSchema(writer) || !isSchema(reader)) return [`${path}: unsupported schema form`];
  const problems: string[] = [];
  for (const key of Object.keys(reader)) {
    if (ANNOTATIONS.has(key) || SUPPORTED.has(key)) continue;
    if (!equal(writer[key], reader[key])) problems.push(`${path}: unsupported keyword '${key}' differs`);
  }
  const wt = types(writer), rt = types(reader);
  if (rt) {
    if (!wt) problems.push(`${path}: reader constrains type, writer does not`);
    else for (const t of wt) {
      if (!rt.has(t) && !(t === 'integer' && rt.has('number'))) problems.push(`${path}: type '${t}' not accepted by reader`);
    }
  }
  if (reader.enum !== undefined) {
    const allowed = reader.enum as unknown[];
    if (!Array.isArray(writer.enum)) problems.push(`${path}: reader enum, writer unconstrained`);
    else for (const v of writer.enum) if (!allowed.some(a => equal(a, v))) problems.push(`${path}: enum value ${JSON.stringify(v)} removed`);
  }
  for (const key of ['format', 'pattern'] as const) {
    if (reader[key] !== undefined && reader[key] !== writer[key]) problems.push(`${path}: ${key} changed or added`);
  }
  for (const key of ['minLength', 'minimum', 'minItems'] as const) {
    if (reader[key] !== undefined && !(typeof writer[key] === 'number' && (writer[key] as number) >= (reader[key] as number))) {
      problems.push(`${path}: ${key} tightened or added`);
    }
  }
  for (const key of ['maxLength', 'maximum', 'maxItems'] as const) {
    if (reader[key] !== undefined && !(typeof writer[key] === 'number' && (writer[key] as number) <= (reader[key] as number))) {
      problems.push(`${path}: ${key} tightened or added`);
    }
  }
  const writerRequired = new Set((writer.required as string[] | undefined) ?? []);
  for (const name of (reader.required as string[] | undefined) ?? []) {
    if (!writerRequired.has(name)) problems.push(`${path}: property '${name}' newly required`);
  }
  const wp = (writer.properties ?? {}) as Record<string, unknown>;
  const rp = (reader.properties ?? {}) as Record<string, unknown>;
  const writerClosed = writer.additionalProperties === false;
  for (const [name, sub] of Object.entries(wp)) {
    if (name in rp) problems.push(...incompatibilities(sub, rp[name], `${path}.${name}`));
    else if (reader.additionalProperties === false) problems.push(`${path}: property '${name}' removed from closed object`);
    else if (isSchema(reader.additionalProperties)) problems.push(...incompatibilities(sub, reader.additionalProperties, `${path}.${name}`));
  }
  for (const [name, sub] of Object.entries(rp)) {
    if (name in wp || writerClosed) continue;
    // Writer is open: an arbitrary value for `name` may already exist in old data.
    problems.push(...incompatibilities(isSchema(writer.additionalProperties) ? writer.additionalProperties : true, sub, `${path}.${name}`));
  }
  if (reader.additionalProperties === false && !writerClosed) problems.push(`${path}: object closed by reader`);
  else if (isSchema(reader.additionalProperties) && !writerClosed) {
    problems.push(...incompatibilities(isSchema(writer.additionalProperties) ? writer.additionalProperties : true,
      reader.additionalProperties, `${path}.*`));
  }
  if (reader.items !== undefined) problems.push(...incompatibilities(writer.items ?? true, reader.items, `${path}[]`));
  return problems;
}

/**
 * `schemaVersion` is the envelope routing field: each version pins its own value,
 * so it is excluded from the structural comparison (both sides become `string`).
 */
export function withoutVersionPin(schema: Schema): Schema {
  const copy = structuredClone(schema);
  const props = copy.properties as Record<string, unknown> | undefined;
  if (props && 'schemaVersion' in props) props.schemaVersion = { type: 'string' };
  return copy;
}

/** Check `candidate` against `previous` (oldest first) under `mode`. */
export function checkCompatibility(mode: CompatibilityMode, previous: Schema[], candidate: Schema): string[] {
  if (!COMPATIBILITY_MODES.includes(mode)) return [`unknown compatibility mode ${String(mode)}`];
  if (previous.length === 0) return [];
  const against = mode.endsWith('_TRANSITIVE') ? previous : [previous[previous.length - 1]];
  const next = withoutVersionPin(candidate);
  const problems: string[] = [];
  for (const old of against.map(withoutVersionPin)) {
    if (mode.startsWith('BACKWARD') || mode.startsWith('FULL')) problems.push(...incompatibilities(old, next).map(p => `BACKWARD ${p}`));
    if (mode.startsWith('FORWARD') || mode.startsWith('FULL')) problems.push(...incompatibilities(next, old).map(p => `FORWARD ${p}`));
  }
  return problems;
}
