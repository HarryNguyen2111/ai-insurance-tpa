// Spec #65 documentation consistency checks. These validate the PROPOSED intake
// form contract documents only; they do not exercise any runtime implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const specs = new URL('../../../docs/ai-specs/', import.meta.url);
const read = name => readFileSync(new URL(name, specs), 'utf8');
const schema = JSON.parse(read('11a-intake-form-config.schema.json'));
const example = JSON.parse(read('examples/intake-form-health-outpatient.example.json'));
const cases = JSON.parse(read('12-dynamic-intake-acceptance-cases.json'));
const design = read('11-dynamic-intake-design.md');

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const validate = ajv.compile(schema);
const ok = value => validate(value) === true;
const clone = () => structuredClone(example);

test('11a example config is valid and within the 64 KiB serialized limit', () => {
  assert.equal(ok(example), true, JSON.stringify(validate.errors));
  assert.ok(Buffer.byteLength(JSON.stringify(example), 'utf8') <= 65536);
});

test('11a rejects schema injection: HTML/script text, unknown keys, components, ops, regex and URLs', () => {
  const mutations = [
    c => { c.fields[0].label = '<script>alert(1)</script>'; },
    c => { c.title = 'Xin chào ${process.env}'; },
    c => { c.fields[0].onClick = 'x()'; },
    c => { c.fields[0].component = 'HTML'; },
    c => { c.fields[0].constraints = { pattern: '^(a+)+$' }; },
    c => { c.fields[0].help = 'xem https://evil.example'; c.fields[0].helpUrl = 'https://evil.example'; },
    c => { c.fields[10].visibleWhen = { field: 'visit_reason', op: 'EVAL', value: 'ACCIDENT' }; },
    c => { c.tenantId = '00000000-0000-4000-8000-000000000000'; },
    c => { c.fields[8].binding = { kind: 'EXTENSION', extensionKey: 'visit_reason', catalogVersion: 1 }; },
    c => { c.fields[1].binding = { kind: 'CANONICAL', path: 'bankAccount' }; },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const c = clone(); mutate(c);
    assert.equal(ok(c), false, `mutation ${i} must be rejected`);
  }
});

test('11a structural bounds: fields, steps, options and condition depth (boundary valid, +1 invalid)', () => {
  const leaf = { field: 'visit_reason', op: 'EQ', value: 'ACCIDENT' };
  const depth3 = { all: [{ any: [{ not: leaf }] }] };
  const depth4 = { all: [{ any: [{ not: { all: [leaf] } }] }] };
  let c = clone(); c.fields[10].visibleWhen = depth3; assert.equal(ok(c), true, JSON.stringify(validate.errors));
  c = clone(); c.fields[10].visibleWhen = depth4; assert.equal(ok(c), false);

  const field = i => ({ key: `f_${i}`, binding: { kind: 'EXTENSION', extensionKey: `x_f_${i}`, catalogVersion: 1 }, component: 'BOOLEAN', label: `F ${i}`, requiredAt: 'NEVER' });
  c = clone(); c.fields = Array.from({ length: 80 }, (_, i) => field(i)); assert.equal(ok(c), true);
  c.fields.push(field(80)); assert.equal(ok(c), false);

  c = clone(); c.steps = Array.from({ length: 10 }, (_, i) => ({ stepKey: `s_${i}`, title: `S ${i}`, fieldKeys: ['visit_date'] }));
  assert.equal(ok(c), true); c.steps.push({ stepKey: 's_x', title: 'X', fieldKeys: ['visit_date'] }); assert.equal(ok(c), false);

  c = clone(); c.fields[8].options = Array.from({ length: 51 }, (_, i) => ({ value: `O${i}`, label: `O ${i}` }));
  assert.equal(ok(c), false);
});

test('11a free text is only the encrypted canonical narrative; IS_SET leaves carry no value', () => {
  let c = clone();
  c.fields[8] = { ...c.fields[8], component: 'TEXTAREA' }; delete c.fields[8].options;
  assert.equal(ok(c), false);
  c = clone(); c.fields[11].visibleWhen.all[1].value = 'X'; assert.equal(ok(c), false);
  c = clone(); c.fields[1].binding = { kind: 'EXTENSION', extensionKey: 'x_docs', catalogVersion: 1 }; assert.equal(ok(c), false);
});

test('example satisfies 11 §6.3 reference rules: unique keys, closed step membership and acyclic conditions', () => {
  const keys = example.fields.map(f => f.key);
  assert.equal(new Set(keys).size, keys.length);
  const placed = example.steps.flatMap(s => s.fieldKeys);
  assert.deepEqual([...placed].sort(), [...keys].sort(), 'each field in exactly one step');
  const refs = cond => !cond ? [] : cond.field ? [cond.field] : (cond.all ?? cond.any ?? [cond.not]).flatMap(refs);
  const deps = Object.fromEntries(example.fields.map(f => [f.key, [...refs(f.visibleWhen), ...refs(f.requiredWhen)]]));
  for (const s of example.steps) for (const r of refs(s.visibleWhen)) assert.ok(keys.includes(r), r);
  for (const [k, ds] of Object.entries(deps)) for (const d of ds) assert.ok(keys.includes(d), `${k} -> ${d}`);
  const state = {};
  const visit = k => { assert.notEqual(state[k], 1, `cycle at ${k}`); if (state[k]) return; state[k] = 1; deps[k].forEach(visit); state[k] = 2; };
  keys.forEach(visit);
});

test('11 §5.1 documents every canonical path allowed by 11a', () => {
  for (const path of schema.$defs.canonicalPath.enum) assert.match(design, new RegExp('`' + path + '`'), path);
});

test('12 acceptance cases are spec-only, unique and cross-referenced with 11 in both directions', () => {
  assert.equal(cases.status, 'SPECIFICATION_ONLY_NOT_EXECUTED');
  const ids = cases.test_cases.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of cases.test_cases) {
    assert.match(c.id, /^DI\d{2}_[A-Z0-9_]+$/);
    for (const k of ['layer', 'given', 'expected']) assert.ok(c[k]?.length > 0, `${c.id}.${k}`);
    assert.ok(!('result' in c) && !/\bPASS(ED)?\b/.test(JSON.stringify(c)), `${c.id} must not claim execution`);
  }
  const shortIds = new Set(ids.map(id => id.slice(0, 4)));
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => `DI${String(a + i).padStart(2, '0')}`);
  const referenced = new Set([...design.matchAll(/DI(\d{2})(?:–DI(\d{2}))?/g)].flatMap(m => m[2] ? range(+m[1], +m[2]) : [`DI${m[1]}`]));
  for (const id of shortIds) assert.ok(referenced.has(id), `${id} not referenced in 11`);
  for (const id of referenced) assert.ok(shortIds.has(id), `${id} referenced in 11 but missing from 12`);
  const defined = new Set([...design.matchAll(/^\| (OD-\d{2}) \|/gm)].map(m => m[1]));
  for (const c of cases.test_cases) for (const b of c.blockedBy) {
    if (b.startsWith('OD-')) assert.ok(defined.has(b), `${c.id} blockedBy ${b} undefined`);
    else assert.match(b, /^#\d+$/);
  }
});
