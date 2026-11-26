// WSC1: workspace (organisation) admin contract. Schema/contract evidence only; no endpoint,
// DB, identity or authorization is implemented or executed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { validate } from '../src/validate.cjs';
import * as prototype from '../../../apps/workbench/src/lib/workspace-profile.ts';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const spec = YAML.parse(read('../../../docs/ai-specs/02-openapi-contracts.yaml'));
const doc = read('../../../docs/ai-specs/13-workspace-onboarding-and-branding-proposal.md');
const S = spec.components.schemas;
const fixtures = JSON.parse(read('./workspace-fixtures.json'));
const valid = name => structuredClone(fixtures.find(f => f.schema === name && f.valid).value);

const EXPECTED_OPS = {
  'POST /v1/admin/workspaces': 'createWorkspace',
  'GET /v1/admin/workspaces/{workspaceId}': 'getWorkspace',
  'PUT /v1/admin/workspaces/{workspaceId}/profile': 'updateWorkspaceProfile',
  'PUT /v1/admin/workspaces/{workspaceId}/theme': 'updateWorkspaceTheme',
  'PUT /v1/admin/workspaces/{workspaceId}/logo': 'setWorkspaceLogo',
  'POST /v1/admin/workspaces/{workspaceId}/logo-assets': 'createWorkspaceLogoUpload',
  'GET /v1/admin/workspaces/{workspaceId}/logo-assets/{assetId}': 'getWorkspaceLogoAsset',
  'POST /v1/admin/workspaces/{workspaceId}/logo-assets/{assetId}/complete': 'completeWorkspaceLogoUpload',
};

test('exactly the eight WSC1 operations exist, all authenticated; no public workspace endpoint yet', () => {
  const found = {};
  for (const [path, methods] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(methods)) {
    if (path.includes('/workspaces')) found[`${m.toUpperCase()} ${path}`] = op.operationId;
  }
  assert.deepEqual(found, EXPECTED_OPS);
  assert.equal(Object.keys(spec.paths).some(p => p.startsWith('/v1/public/')), false);
  for (const key of Object.keys(EXPECTED_OPS)) {
    const [m, path] = key.split(' ');
    const op = spec.paths[path][m.toLowerCase()];
    assert.deepEqual(op.security ?? spec.security, [{ bearerAuth: [] }], key);
    if (path.includes('{workspaceId}')) assert.ok(op.parameters.some(p => p.$ref === '#/components/parameters/WorkspaceId'), key);
    if (m !== 'GET') assert.match(op.description, /verified MFA/, `${key} requires MFA`);
  }
});

test('decided OD-05: only TPA operations create workspaces and name the first administrator', () => {
  const op = spec.paths['/v1/admin/workspaces'].post;
  assert.match(op.description, /Decided OD-05: only a TPA operations principal/);
  assert.match(op.description, /never inferred from a tenant membership or request field/);
  assert.ok(S.WorkspaceCreateRequest.required.includes('initialAdminPrincipalId'));
  const body = valid('WorkspaceCreateRequest');
  delete body.initialAdminPrincipalId;
  assert.equal(validate('WorkspaceCreateRequest', body), false);
});

test('decided OD-02: slug is assigned at creation only and cannot be changed through profile updates', () => {
  const slugCarriers = Object.entries(S).filter(([n, s]) => n.endsWith('Request') && s.properties?.slug).map(([n]) => n);
  assert.deepEqual(slugCarriers, ['WorkspaceCreateRequest']);
  assert.equal(validate('WorkspaceProfileUpdateRequest', { ...valid('WorkspaceProfileUpdateRequest'), slug: 'slug-moi' }), false);
  assert.match(spec.paths['/v1/admin/workspaces/{workspaceId}/profile'].put.description, /slug is not editable here/);
});

test('decided OD-WS1: low contrast is accepted and only reported as a warning', () => {
  for (const color of ['#f5f5f5', '#ffffff', '#a3a3a3', '#000000']) {
    assert.equal(validate('WorkspaceTheme', { ...valid('WorkspaceTheme'), primaryColor: color }), true, color);
  }
  assert.deepEqual(S.WorkspaceWarning.properties.code.enum, ['LOW_SURFACE_CONTRAST']);
  assert.equal(validate('WorkspaceResult', valid('WorkspaceResult')), true);
  // Shared C1 error codes are untouched: no contrast/slug-specific error codes were introduced.
  assert.deepEqual(S.Error422.properties.code.enum, ['VALIDATION_FAILED', 'DOMAIN_VIOLATION']);
  assert.deepEqual(S.Error409.properties.code.enum, ['IDEMPOTENCY_CONFLICT', 'STALE_VERSION', 'OPERATION_IN_PROGRESS']);
});

test('no workspace request or response exposes or accepts a tenant identifier', () => {
  const walk = (node, path, seen = new Set()) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return [];
    seen.add(node);
    const hits = node.properties && Object.keys(node.properties).some(k => /tenant/i.test(k)) ? [path] : [];
    return hits.concat(...Object.entries(node).map(([k, v]) => walk(v, `${path}.${k}`, seen)));
  };
  const names = Object.keys(S).filter(n => n.startsWith('Workspace') || n === 'Workspace');
  for (const name of names.filter(n => n !== 'WorkspaceChangedEvent')) assert.deepEqual(walk(S[name], name), [], name);
  assert.equal(validate('WorkspaceCreateRequest', { ...valid('WorkspaceCreateRequest'), tenantId: '00000000-0000-4000-8000-000000000099' }), false);
  // The internal outbox envelope carries the trusted tenant like other events, but no names/colours/URLs.
  assert.deepEqual(Object.keys(S.WorkspaceChangedEvent.properties.payload.properties), ['changeKind']);
  assert.deepEqual(spec['x-domain-events'].WorkspaceChangedEvent, { $ref: '#/components/schemas/WorkspaceChangedEvent' });
});

test('logo path is presigned-only, raster-only and needs explicit activation of a READY asset', () => {
  assert.deepEqual(S.WorkspaceLogoMime.enum, ['image/png', 'image/jpeg', 'image/webp']);
  assert.equal(S.WorkspaceLogoUploadRequest.properties.sizeBytes.maximum, 2 * 1024 * 1024);
  const op = spec.paths['/v1/admin/workspaces/{workspaceId}/logo-assets'].post;
  assert.equal(op.requestBody.content['multipart/form-data'], undefined, 'core-api never receives file bytes');
  assert.ok(spec.paths['/v1/admin/workspaces/{workspaceId}/logo-assets/{assetId}/complete'].post.responses['202'].headers.Location);
  assert.equal(validate('WorkspaceLogoAsset', { ...valid('WorkspaceLogoAssetPending'), state: 'READY' }), false);
  assert.equal(validate('WorkspaceLogoSetRequest', { expectedVersion: 1, logoAssetId: '00000000-0000-4000-8000-000000000020', clear: true }), false);
});

test('spec 13 documents the same reserved slugs, org types, theme values and limits as the contract', () => {
  const line = doc.split('\n').find(l => l.startsWith('Slug dành riêng:'));
  const reserved = line.slice(line.indexOf('`') + 1, line.lastIndexOf('`')).split(',').map(s => s.trim());
  assert.deepEqual([...S.WorkspaceSlug.not.enum].sort(), reserved.sort());
  for (const t of S.WorkspaceOrgType.enum) assert.ok(doc.includes(`\`${t}\``), t);
  for (const r of S.WorkspaceTheme.properties.radius.enum) assert.ok(doc.includes(`\`${r}\``), r);
  const lim = s => `${s.minLength}–${s.maxLength}`;
  assert.ok(doc.includes(`${lim(S.WorkspaceDisplayName)} ký tự`));
  assert.ok(doc.includes(`${lim(S.WorkspaceShortName)}, `));
  assert.ok(doc.includes(`${lim(S.WorkspaceSlug)}, `));
  assert.ok(doc.includes(`≤ ${S.WorkspaceDescription.maxLength}`));
  assert.ok(doc.includes('2 MiB thô'));
  for (const id of ['OD-05', 'OD-02', 'OD-WS1']) assert.match(doc, new RegExp(`\\| ${id} \\|[^\\n]*\\*\\*ĐÃ CHỐT`), id);
});

test('FE prototype validators and the contract accept and reject the same normalized inputs', () => {
  const base = { displayName: 'Bảo hiểm Mẫu', shortName: 'BHM', slug: 'bao-hiem-mau', orgType: 'INSURER', description: '' };
  const contractOk = p => validate('WorkspaceCreateRequest', {
    displayName: p.displayName, shortName: p.shortName, slug: p.slug, orgType: p.orgType,
    ...(p.description ? { description: p.description } : {}), initialAdminPrincipalId: '00000000-0000-4000-8000-000000000030',
  });
  const cases = [
    ...['bao-hiem-mau', 'abc', 'a1-b2', 'x'.repeat(32), 'ab', 'x'.repeat(33), '1abc', 'abc-', 'a--b', 'ab_c', ...prototype.RESERVED_SLUGS].map(slug => ({ ...base, slug })),
    ...['Bảo hiểm Mẫu', 'AB', 'x'.repeat(120), 'A', 'x'.repeat(121), 'Tên <b>', 'Tên {x}', 'Tên `x`'].map(displayName => ({ ...base, displayName })),
    ...['BHM', 'AB', 'A1-B', 'ABCDEFGHIJKL', 'A', 'ABCDEFGHIJKLM', 'A B', '-AB'].map(shortName => ({ ...base, shortName })),
    ...['Mô tả ngắn', 'Dòng 1\nDòng 2', 'x'.repeat(300), 'x'.repeat(301), 'có <thẻ>'].map(description => ({ ...base, description })),
    ...['INSURER', 'TPA_OPERATOR', 'CORPORATE_CLIENT', 'OTHER'].map(orgType => ({ ...base, orgType })),
  ];
  for (const c of cases) {
    const feOk = Object.keys(prototype.validateProfile(c)).length === 0;
    assert.equal(contractOk(c), feOk, JSON.stringify(c).slice(0, 120));
  }
  for (const color of ['#0f766e', '#ffffff', '#000000', '#abc', 'red', '#0f766e;x', '#12345g']) {
    const theme = { primaryColor: color, radius: 'MD', mode: 'LIGHT', sidebarStyle: 'LIGHT' };
    assert.equal(validate('WorkspaceTheme', theme), Object.keys(prototype.validateTheme(theme).errors).length === 0, color);
  }
  for (const preset of prototype.THEME_PRESETS) assert.equal(validate('WorkspaceTheme', { ...prototype.DEFAULT_THEME, primaryColor: preset.color }), true);
});
