import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { validate } from '../src/validate.cjs';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url)));
const spec = YAML.parse(readFileSync(new URL('../../../docs/ai-specs/02-openapi-contracts.yaml', import.meta.url), 'utf8'));
for (const fixture of fixtures) test(fixture.name, () => {
  const before = structuredClone(fixture.value);
  assert.equal(validate(fixture.schema, fixture.value), fixture.valid);
  assert.deepEqual(fixture.value, before, 'validation must not mutate/coerce/strip fields');
});
test('all scoped schemas have positive and negative fixtures', () => {
  for (const name of Object.keys(spec.components.schemas).filter(n => n !== 'ExplainableEOBResponse')) {
    assert.ok(fixtures.some(f => f.schema === name && f.valid), name);
    assert.ok(fixtures.some(f => f.schema === name && !f.valid) || ['PreflightStatus','ContentType','BenefitType','DocumentType','ClaimStatus','Hash'].includes(name), name);
  }
});
test('all scoped operations declare authentication, errors, and durable mutation keys', () => {
  for (const [path, methods] of Object.entries(spec.paths)) for (const [method, operation] of Object.entries(methods)) {
    if (!operation.operationId) continue; // Original API-C2 operations intentionally unchanged.
    for (const status of ['401','403','404','409','422','429','503']) assert.ok(operation.responses[status], `${path} ${status}`);
    if (method === 'post' && !path.startsWith('/internal/')) assert.ok(operation.parameters.some(p => p.$ref?.endsWith('/IdempotencyKey')), path);
    assert.deepEqual(operation.security ?? spec.security, path.startsWith('/internal/') ? [{internalHmac: []}] : path.includes('/auth/') ? [] : [{bearerAuth: []}]);
    assert.ok(operation.responses['200'] || operation.responses['201'] || operation.responses['202'], path);
  }
});
test('PT16 schema boundary requires all signature headers and a versioned minimal service payload', () => {
  const operation = spec.paths['/internal/v1/webhooks/ai-result'].post;
  assert.deepEqual(operation.parameters.map(p => p.name).sort(), ['X-Event-Id','X-Signature-HMAC','X-Signature-Timestamp']);
  for (const p of operation.parameters) assert.equal(p.required, true);
  assert.equal(validate('AiResult', {...fixtures.find(f=>f.schema==='AiResult'&&f.valid).value, rawXml:'unsafe'}),false);
});
test('PT22 schema boundary documents 409 and forbids missing mutation version/key', () => {
  const key = spec.components.parameters.IdempotencyKey;
  assert.equal(key.required,true);
  assert.equal(key.name,'Idempotency-Key');
  assert.ok(spec.paths['/v1/claims'].post.responses['409']);
  assert.equal(validate('ClaimSupplement',{documentIds:[]}),false);
});
test('preflight 200 completed and 202 pending are separate concrete schemas', () => {
  const responses = spec.paths['/v1/claims/preflight-check'].post.responses;
  assert.equal(responses['200'].content['application/json'].schema.$ref,'#/components/schemas/PreflightCompleted');
  assert.equal(responses['202'].content['application/json'].schema.$ref,'#/components/schemas/PreflightPending');
  assert.ok(responses['202'].headers.Location);
});
test('TC04 mapping preserves original expected warning shape, without running business rules', () => {
  const golden = JSON.parse(readFileSync(new URL('../../../docs/ai-specs/04-golden-test-cases.json',import.meta.url)));
  const original = golden.test_cases.find(c=>c.id==='TC04_PREFLIGHT_ND70_COMPANY_ADDRESS');
  const completed = structuredClone(fixtures.find(f=>f.schema==='PreflightCompleted'&&f.valid).value);
  completed.passed=original.expected.passed;
  completed.warnings=[{code:original.expected.warning_codes[0],severity:'BLOCKER',messageVi:'Cần xác minh theo điều khoản được phê duyệt',ruleVersion:'synthetic-v1'}];
  assert.equal(validate('PreflightCompleted',completed),true);
});

test('original API-C2 blocks remain byte-identical', async () => {
 const {createHash}=await import('node:crypto');
 const text=readFileSync(new URL('../../../docs/ai-specs/02-openapi-contracts.yaml',import.meta.url),'utf8');
 assert.ok(text.includes("  /v1/claims/{claimId}/eob:\n    get:\n      summary: Lay Bang Giai Trinh Quyen Loi (Explainable EOB) cho Zalo Mini App\n      parameters:\n        - in: path\n          name: claimId\n          required: true\n          schema: { type: string, format: uuid }\n      responses:\n        \"200\":\n          description: Bang giai tr\u00ecnh tung dong kem dieu khoan trich dan va audit hash\n          content:\n            application/json:\n              schema:\n                $ref: \"#/components/schemas/ExplainableEOBResponse\"\n\n  /v1/workbench/claims/{claimId}/lines/{lineId}:\n    patch:\n      summary: Bac si tham dinh dieu chinh/duyet/tu choi 1 dong chi phi (Contract-Locked)\n      parameters:\n        - in: path\n          name: claimId\n          required: true\n          schema: { type: string, format: uuid }\n        - in: path\n          name: lineId\n          required: true\n          schema: { type: string, format: uuid }\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              required: [decisionStatus, approvedAmount, contractClauseCited, explanationVi]\n              properties:\n                decisionStatus: { type: string, enum: [APPROVED, PARTIAL, REJECTED] }\n                approvedAmount: { type: string, example: \"0.00\" }\n                contractClauseCited: { type: string, example: \"Dieu 5.3 - Loai tru Thuc pham chuc nang\" }\n                explanationVi: { type: string }\n                updateMedicalCatalogAs: { type: string, enum: [NONE, DRUG, SUPPLEMENT_TPCN, COSMETIC] }\n      responses:\n        \"200\":\n          description: Da cap nhat dong chi phi va ghi noi chuoi Audit Hash\n\n"));
 assert.ok(text.includes("    ExplainableEOBResponse:\n      type: object\n      required: [claimCode, status, eobVersion, eobHash, summary, lineItems, auditProof]\n      properties:\n        eobVersion: { type: integer, minimum: 1 }\n        eobHash: { type: string, pattern: '^[a-f0-9]{64}$' }\n        contractVersionId: { type: string, format: uuid }\n\n        claimCode: { type: string }\n        status: { type: string }\n        summary:\n          type: object\n          properties:\n            totalRequested: { type: string }\n            totalApproved: { type: string }\n            totalRejected: { type: string }\n            remainingAnnualLimit: { type: string }\n        lineItems:\n          type: array\n          items:\n            type: object\n            properties:\n              lineId: { type: string }\n              itemName: { type: string }\n              requested: { type: string }\n              approved: { type: string }\n              rejected: { type: string }\n              status: { type: string }\n              clauseCited: { type: string }\n              explanationVi: { type: string }\n        auditProof:\n          type: object\n          properties:\n            hashChainTail: { type: string }\n            contractLocked: { type: boolean }\n"));
});
