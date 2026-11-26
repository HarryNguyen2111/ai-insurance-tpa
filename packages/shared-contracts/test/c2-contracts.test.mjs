import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { validate } from '../src/validate.cjs';
const read = name => readFileSync(new URL(name,import.meta.url),'utf8');
const spec = YAML.parse(read('../../../docs/ai-specs/02-openapi-contracts.yaml'));
const baseline = JSON.parse(read('./c1-baseline.json'));
const fixtures = JSON.parse(read('./c2-fixtures.json'));
const valid = name => structuredClone(fixtures.find(f=>f.schema===name&&f.valid).value);

test('API-C1 every original operation, header, security, error and schema remains semantically identical', () => {
  for (const [path, methods] of Object.entries(baseline.paths)) assert.deepEqual(spec.paths[path],methods,path);
  for (const [group, entries] of Object.entries(baseline.components)) for (const [name,value] of Object.entries(entries)) {
    assert.deepEqual(spec.components[group][name],value,`${group}.${name}`);
  }
  assert.deepEqual(spec.security,baseline.security);
  assert.deepEqual(spec['x-platform-requirements'],baseline['x-platform-requirements']);
});

test('C2 mutation keys, verified membership, no-store and concrete success/error schemas', () => {
  for (const [path, methods] of Object.entries(spec.paths)) for (const [method,op] of Object.entries(methods)) {
    if (baseline.paths[path]?.[method]) continue;
    assert.ok(op.operationId,path);
    assert.deepEqual(op.security??spec.security,path.startsWith('/internal/')?[{internalHmac:[]}]:[{bearerAuth:[]}]);
    if (!path.startsWith('/internal/')) {
      assert.ok(op.parameters.some(p=>p.$ref?.endsWith('/MembershipContext')),path);
      if(method!=='get')assert.ok(op.parameters.some(p=>p.$ref?.endsWith('/IdempotencyKey')),path);
    }
    for(const code of ['401','403','404','409','422','429','503'])assert.equal(op.responses[code].$ref,`#/components/responses/Error${code}`);
    for(const [code,r] of Object.entries(op.responses))if(code.startsWith('2')) {
      assert.ok(r.content['application/json'].schema.$ref,path);
      assert.deepEqual(r.headers['Cache-Control'].schema.enum,['no-store']);
    }
  }
});

test('PT11/PT22 schema boundary: publication version and hash must form a valid first/replacement pair', () => {
  const input=valid('PublishEobRequest');
  assert.equal(input.expectedEobVersion,0);
  assert.equal(validate('PublishEobRequest',input),true);
  assert.equal(validate('PublishEobRequest',{...input,expectedEobHash:'a'.repeat(64)}),false);
  assert.equal(validate('PublishEobRequest',{...input,expectedEobVersion:1}),false);
  assert.equal(validate('PublishEobRequest',{...input,expectedEobVersion:1,expectedEobHash:'a'.repeat(64)}),true);
  for(const name of ['OtpChallengeRequest','OtpVerifyRequest','PaymentIntentRequest','InsurerDecisionRequest']) {
    const v=valid(name);delete v.eob.eobHash;assert.equal(validate(name,v),false,name);
  }
});

test('PT09/PT13/PT18/PT24 schema boundaries exclude unsafe selectors and require receipt/provenance/secret fields', () => {
  assert.equal(validate('ClaimSearchQuery',{tenantId:'x'}),false);
  assert.equal(validate('ClaimSearchQuery',{query:{match_all:{}}}),false);
  assert.equal(validate('PaymentExportRequest',{...valid('PaymentExportRequest'),columns:['phone']}),false);
  assert.equal(validate('OriginalReceiptRequest',{trackingCode:'synthetic-tracking-only'}),false);
  const proposal=valid('CatalogProposalRequest');delete proposal.evidenceIds;assert.equal(validate('CatalogProposalRequest',proposal),false);
  const code=valid('OtpVerifyRequest');delete code.code;assert.equal(validate('OtpVerifyRequest',code),false);
});

test('PT12/PT16 callback boundary: HMAC/event/timestamp shape, minimal payload, no caller tenant or bank data', () => {
  const headers=spec.paths['/internal/v1/payments/callbacks'].post.parameters;
  assert.deepEqual(headers,spec.paths['/internal/v1/webhooks/ai-result'].post.parameters);
  for(const field of ['tenantId','rawXml','bankAccount','providerPayload'])assert.equal(validate('PaymentCallback',{...valid('PaymentCallback'),[field]:'unsafe'}),false);
  assert.equal(validate('PaymentIntent',{...valid('PaymentIntent'),status:'UNKNOWN',attemptId:'00000000-0000-4000-8000-000000000020'}),true);
  assert.match(spec.components.schemas.PaymentIntent.description,/UNKNOWN never blind retry/);
  assert.match(spec.components.schemas.PaymentIntent.description,/POSTED journals immutable/);
});

test('TC01/02/03/05 schema compatibility uses unchanged golden expected money/routing; TC06 only routing', () => {
  const golden=JSON.parse(read('../../../docs/ai-specs/04-golden-test-cases.json'));
  for(const tc of golden.test_cases.filter(c=>c.input.lines)) {
    const e=tc.expected;
    for(const key of ['total_requested','total_approved','total_rejected','remaining_annual_limit_after']) {
      if(key in e)assert.equal(validate('Money',e[key]),true,`${tc.id}.${key}`);
    }
    const run=valid('CalculationRun');run.triageLane=e.triage_lane;
    if(e.total_requested)run.summary.totalRequested=e.total_requested;
    if(e.total_approved)run.summary.totalApproved=e.total_approved;
    if(e.total_rejected)run.summary.totalRejected=e.total_rejected;
    if(e.remaining_annual_limit_after)run.summary.remainingAnnualLimit=e.remaining_annual_limit_after;
    assert.equal(validate('CalculationRun',run),true,tc.id);
    if(tc.id.startsWith('TC06'))assert.equal('total_approved' in e,false,'TC06 does not authorize inferred amounts');
  }
});

test('internal payment callback uses service identity rather than user membership', () => {
  const op=spec.paths['/internal/v1/payments/callbacks'].post;
  assert.match(op.description,/service identity and payment\/attempt permissions/);
  assert.doesNotMatch(op.description,/active membership/);
});

test('line decisions support pre-publication and require exact existing EOB hash thereafter', () => {
  const input=valid('LineDecisionRequest');
  assert.equal(validate('LineDecisionRequest',input),true);
  const missing=structuredClone(input);delete missing.expectedEobHash;
  assert.equal(validate('LineDecisionRequest',missing),false);
  assert.equal(validate('LineDecisionRequest',{...missing,expectedEobVersion:0}),true);
  assert.equal(validate('LineDecisionRequest',{...input,expectedEobVersion:0}),false);
});


test('PT12 contract continuity: authorized UNKNOWN payment exposes the exact attempt needed for reconciliation without callback', () => {
  const payment=structuredClone(fixtures.find(f=>f.schema==='PaymentIntent'&&f.valid&&f.value.status==='UNKNOWN').value);
  assert.equal(validate('PaymentIntent',payment),true);
  const get=spec.paths['/v1/payments/{paymentId}'].get;
  assert.equal(get.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/PaymentIntent');
  const create=spec.paths['/v1/payments'].post;
  assert.equal(create.responses['201'].content['application/json'].schema.$ref,'#/components/schemas/PaymentIntent');
  const evidence=valid('ReconciliationRequest');
  const request={...evidence,paymentId:payment.paymentId,attemptId:payment.attemptId,expectedAggregateVersion:payment.aggregateVersion,eob:payment.eob};
  assert.equal(request.attemptId,payment.attemptId);
  assert.equal(validate('ReconciliationRequest',request),true);
  assert.equal(spec.paths['/v1/payment-reconciliations'].post.requestBody.content['application/json'].schema.$ref,'#/components/schemas/ReconciliationRequest');
  const missing={...payment};delete missing.attemptId;
  assert.equal(validate('PaymentIntent',missing),false,'UNKNOWN read cannot omit reconciliation reference');
  const unusable={...request};delete unusable.attemptId;
  assert.equal(validate('ReconciliationRequest',unusable),false);
  assert.equal(validate('ReconciliationRequest',{...request,attemptId:'invalid'}),false);
  // Relationship, tenant/object authorization and stale-attempt checks are server obligations, not UUID-shape validation.
});
