import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { checkCompatibility, incompatibilities, readSchema, REGISTRY_ROOT, schemaHash, verifyRegistry, type JsonSchema } from '../src/index.ts';

const openapi = JSON.parse(await readFile(new URL('../../shared-contracts/src/schemas.json', import.meta.url), 'utf8'));
const base = readSchema('claim.state-changed', '1.0.0');
const nextVersion = (mutate: (payload: JsonSchema) => void): JsonSchema => {
  const schema = structuredClone(base);
  (schema.properties as Record<string, JsonSchema>).schemaVersion = { type: 'string', enum: ['1.1.0'] };
  mutate((schema.properties as Record<string, JsonSchema>).payload);
  return schema;
};

test('compatible evolutions pass BACKWARD_TRANSITIVE', () => {
  const addOptional = nextVersion(p => { (p.properties as Record<string, JsonSchema>).reasonCode = { type: 'string', enum: ['SLA'] }; });
  assert.deepEqual(checkCompatibility('BACKWARD_TRANSITIVE', [base], addOptional), []);
  const widenEnum = nextVersion(p => {
    const to = (p.properties as Record<string, JsonSchema>).toStatus;
    to.enum = [...(to.enum as string[]), 'ARCHIVED'];
  });
  assert.deepEqual(checkCompatibility('BACKWARD_TRANSITIVE', [base], widenEnum), []);
  assert.deepEqual(checkCompatibility('FULL_TRANSITIVE', [base], structuredClone(base)), [], 'identical schema is fully compatible');
});

test('breaking evolutions are rejected with explicit reasons', () => {
  const cases: [string, JsonSchema, RegExp][] = [
    ['new required field', nextVersion(p => {
      (p.properties as Record<string, JsonSchema>).reasonCode = { type: 'string', enum: ['SLA'] };
      (p.required as string[]).push('reasonCode');
    }), /newly required/],
    ['removed field from closed object', nextVersion(p => { delete (p.properties as Record<string, JsonSchema>).fromStatus; p.required = ['toStatus']; }), /removed from closed object/],
    ['narrowed enum', nextVersion(p => { (p.properties as Record<string, JsonSchema>).toStatus.enum = ['PAID']; }), /enum value/],
    ['changed type', nextVersion(p => { (p.properties as Record<string, JsonSchema>).toStatus = { type: 'integer' }; }), /type 'string' not accepted/],
    ['added pattern', nextVersion(p => { (p.properties as Record<string, JsonSchema>).toStatus.pattern = '^P'; }), /pattern changed/],
    ['unknown keyword', nextVersion(p => { p.minProperties = 2; }), /unsupported keyword 'minProperties'/],
  ];
  for (const [name, candidate, reason] of cases) {
    const problems = checkCompatibility('BACKWARD_TRANSITIVE', [base], candidate);
    assert.ok(problems.some(p => reason.test(p)), `${name}: ${problems.join('; ')}`);
  }
  // Adding an optional property to a closed object is backward- but not forward-compatible.
  const addOptional = nextVersion(p => { (p.properties as Record<string, JsonSchema>).reasonCode = { type: 'string', enum: ['SLA'] }; });
  assert.ok(checkCompatibility('FORWARD', [base], addOptional).some(p => /removed from closed object/.test(p)));
  assert.ok(checkCompatibility('FULL', [base], addOptional).length > 0);
  // Transitive checks every earlier version, non-transitive only the latest.
  const v11 = nextVersion(p => { (p.properties as Record<string, JsonSchema>).toStatus.enum = ['PAID', 'REJECTED']; });
  const v12 = structuredClone(v11);
  assert.deepEqual(checkCompatibility('BACKWARD', [base, v11], v12), []);
  assert.ok(checkCompatibility('BACKWARD_TRANSITIVE', [base, v11], v12).length > 0);
  assert.deepEqual(incompatibilities({ type: 'integer' }, { type: 'number' }), [], 'integer data is valid number data');
  assert.ok(checkCompatibility('NOPE' as never, [base], base).length > 0, 'unknown mode fails closed');
});

test('registry CI check: committed registry passes; tampering, drift and free text fail', async () => {
  assert.deepEqual(verifyRegistry(undefined, openapi), []);
  const dir = await mkdtemp(join(tmpdir(), 'evt-registry-'));
  try {
    const root = pathToFileURL(dir + '/');
    await cp(REGISTRY_ROOT, root, { recursive: true });
    const file = new URL('schemas/claim.state-changed/1.0.0.json', root);
    const manifestFile = new URL('registry.json', root);
    const original = await readFile(file, 'utf8');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));

    // 1. Editing a published version is detected by its hash lock.
    const edited = JSON.parse(original); edited.description = 'edited';
    await writeFile(file, JSON.stringify(edited));
    assert.ok(verifyRegistry(root, openapi).some(i => /published schema changed/.test(i.problem)));
    await writeFile(file, original);

    // 2. A new incompatible version is rejected even with a correct hash.
    const breaking = nextVersion(p => { (p.required as string[]).push('reasonCode'); (p.properties as Record<string, JsonSchema>).reasonCode = { type: 'string', enum: ['X'] }; });
    await writeFile(new URL('schemas/claim.state-changed/1.1.0.json', root), JSON.stringify(breaking));
    manifest.subjects['claim.state-changed'].versions['1.1.0'] = schemaHash(breaking);
    await writeFile(manifestFile, JSON.stringify(manifest));
    assert.ok(verifyRegistry(root, openapi).some(i => i.version === '1.1.0' && /newly required/.test(i.problem)));

    // 3. Free-text strings are rejected (PT17 static guard).
    const freeText = nextVersion(p => { (p.properties as Record<string, JsonSchema>).note = { type: 'string' }; });
    await writeFile(new URL('schemas/claim.state-changed/1.1.0.json', root), JSON.stringify(freeText));
    manifest.subjects['claim.state-changed'].versions['1.1.0'] = schemaHash(freeText);
    await writeFile(manifestFile, JSON.stringify(manifest));
    assert.ok(verifyRegistry(root, openapi).some(i => /free-text string at \$\.payload\.note/.test(i.problem)));

    // 4. Drift from the OpenAPI component is detected.
    const drift = structuredClone(openapi);
    drift.EobPublishedEvent.properties.payload.properties.calculationRunId.format = 'date-time';
    assert.ok(verifyRegistry(undefined, drift).some(i => i.eventType === 'eob.published' && /differs from OpenAPI/.test(i.problem)));
    const extra = { ...openapi, ClaimClosedEvent: {} };
    assert.ok(verifyRegistry(undefined, extra).some(i => /ClaimClosedEvent missing/.test(i.problem)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
