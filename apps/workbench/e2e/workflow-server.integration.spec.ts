import { expect, test, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { freePort, startWeb, startWorkflowHarness, stop, type Harness, type Owned } from './processes';
import { canonicalJson, type EditorDocument, type WorkflowContent } from '../src/lib/workflow-definition';

// VWF-02 (#79) INTEGRATED acceptance: production Next build + same-origin bridge + REAL compiled core-api
// identity (#21) and workflow-definition (#80) controllers + real PostgreSQL with migrations and FORCE RLS.
// Nothing here is mocked. Synthetic tenants/principals/data only. In CI the database is PG16 via Docker;
// a local run may use a pre-migrated non-PG16 database (HARNESS_EXTERNAL_*) and is feedback only.
const external = !!process.env.HARNESS_EXTERNAL_ADMIN_URL;
function dockerAvailable() { try { execFileSync('docker', ['version'], { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; } }
const runnable = external || dockerAvailable();
if (process.env.CI && !runnable) throw new Error('CI requires Docker for the integrated workflow publish test');
test.skip(!runnable, 'Docker unavailable and no external DB: integrated publish test NOT run');
test.describe.configure({ mode: 'serial' });

const example: WorkflowContent = JSON.parse(await readFile(new URL('../../../docs/ai-specs/examples/visual-workflow-intake-review.example.json', import.meta.url), 'utf8'));
const KEY = example.workflowKey;
const container = `tpa-vwf02-${randomBytes(6).toString('hex')}`;
let harness: Harness | undefined, web: Owned | undefined, webUrl = '', definitionId = '';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  harness = await startWorkflowHarness({ HARNESS_CONTAINER: container });
  if (process.env.CI) expect(harness.pgVersion).toMatch(/^16\./);
  const port = await freePort();
  web = await startWeb(port, harness.apiUrl, true);
  webUrl = `http://127.0.0.1:${port}`;
});
test.afterAll(async () => {
  await stop(web); await stop(harness);
  if (!external) { try { execFileSync('docker', ['rm', '-f', '-v', container], { stdio: 'ignore', timeout: 30000 }); } catch { /* already removed */ } }
});

async function mint(name: string): Promise<{ token: string; membershipId: string }> {
  return (await fetch(`${harness!.controlUrl}/token/${name}`)).json();
}
async function state() { return (await fetch(`${harness!.controlUrl}/state/${definitionId}`)).json(); }
const designer = (page: Page) => page.getByRole('region', { name: 'Trình thiết kế quy trình', exact: true });
const status = (page: Page) => page.getByTestId('workflow-status');

async function connect(page: Page, name: string) {
  await page.goto(`${webUrl}/quy-trinh`);
  await page.locator('summary').filter({ hasText: 'Máy chủ quy trình' }).click();
  const { token, membershipId } = await mint(name);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Kết nối máy chủ', exact: true }).click();
  await page.getByLabel('Tư cách thành viên').selectOption(membershipId);
  await page.getByRole('button', { name: 'Chọn tư cách', exact: true }).click();
  await expect(page.locator('summary').filter({ hasText: 'Máy chủ quy trình' })).toContainText('đã kết nối');
  // The bearer is memory-only: nothing is written to web storage or cookies.
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie)).not.toContain(token.slice(-20));
}
async function openServer(page: Page, versionNo = 1) {
  await page.getByRole('button', { name: `Phiên bản của ${KEY}`, exact: true }).click();
  await page.getByRole('button', { name: `Mở ${KEY} v${versionNo}`, exact: true }).click();
  await expect(status(page)).toContainText(`Máy chủ · v${versionNo}`);
  await expect(page.locator('[data-element-id="n_start"]').first()).toBeVisible();
}
async function previewDoc(page: Page): Promise<EditorDocument> {
  const preview = page.getByTestId('canonical-preview');
  if (!await preview.isVisible()) await page.getByRole('button', { name: 'Xem JSON chuẩn' }).click();
  return JSON.parse((await preview.textContent())!);
}
async function importJson(page: Page, doc: unknown, name = 'synthetic.json') {
  await page.getByLabel('Nhập JSON / BPMN').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(typeof doc === 'string' ? doc : canonicalJson(doc)) });
}
/** A forged request straight to the bridge with the person's own valid credentials, bypassing the UI. */
async function forged(page: Page, name: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const { token, membershipId } = await mint(name);
  return page.evaluate(async ({ token, membershipId, method, path, body, extra }) => {
    const auth = { authorization: `Bearer ${token}` };
    const ctx = await (await fetch('/api/workflow/v1/me/membership', { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ membershipId }) })).json();
    const headers: Record<string, string> = { ...auth, 'x-membership-context': ctx.contextToken, ...extra };
    if (method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`/api/workflow/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, { token, membershipId, method, path, body, extra });
}
const versionPath = () => `admin/workflow-definitions/${definitionId}/versions/1`;

test('designer: server draft save/reload, backend validation errors with focus, hostile input, forged publish denied', async ({ page }) => {
  const dialogs: string[] = []; page.on('dialog', d => { dialogs.push(d.message()); void d.dismiss(); });
  await connect(page, 'designer');
  await expect(page.getByRole('status').filter({ hasText: 'Chưa có quy trình nào' })).toBeVisible();
  await page.getByRole('button', { name: 'Mở trình vẽ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bắt đầu', exact: true })).toBeEnabled();
  await importJson(page, { content: example, layout: { nodes: {}, edges: {} } });
  await expect(page.getByRole('status').filter({ hasText: 'Đã nhập' })).toBeVisible();
  await page.getByRole('button', { name: 'Tạo bản nháp trên máy chủ', exact: true }).click();
  await expect(status(page)).toHaveText('Máy chủ · v1 · Bản nháp · revision 1');
  definitionId = (await forged(page, 'designer', 'GET', 'admin/workflow-definitions')).body.items[0].definitionId;
  expect(definitionId).toMatch(/^[0-9a-f-]{36}$/);
  // A designer never sees publish (server hint publishableByCurrentActor=false).
  await expect(page.getByRole('button', { name: 'Xuất bản', exact: true })).toHaveCount(0);

  // Invalid edit: drop the escalate route. Server validation needs a saved revision first.
  await page.getByLabel('Chọn phần tử').selectOption('e_e_escalate');
  await page.getByRole('button', { name: 'Xóa phần tử', exact: true }).click();
  await expect(status(page)).toContainText('chưa lưu');
  await expect(page.getByRole('button', { name: 'Kiểm tra trên máy chủ', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Lưu lên máy chủ', exact: true }).click();
  await expect(status(page)).toHaveText('Máy chủ · v1 · Bản nháp · revision 2');
  await page.getByRole('button', { name: 'Kiểm tra trên máy chủ', exact: true }).click();
  const report = page.getByRole('region', { name: 'Kết quả kiểm tra máy chủ' });
  await expect(report).toBeFocused();
  await expect(report).toContainText('MISSING_ACTION_ROUTE');
  await expect(report).toContainText('Không thể xuất bản');
  await report.getByRole('button').filter({ hasText: 'MISSING_ACTION_ROUTE' }).first().click();
  await expect(page.getByLabel('Chọn phần tử')).toHaveValue('n_confirm_extraction');

  // Malicious fixtures are rejected locally before any server write; labels stay escaped text.
  const before = await previewDoc(page);
  const hostile = structuredClone(before); hostile.content.nodes[1].label = '<img src=x onerror=alert(1)>';
  await importJson(page, hostile, 'tampered.json');
  await expect(designer(page).getByRole('alert')).toContainText('SCHEMA_INVALID');
  await importJson(page, '<!DOCTYPE x [<!ENTITY p SYSTEM "file:///etc/passwd">]><x>&p;</x>', 'xxe.bpmn');
  await expect(designer(page).getByRole('alert')).toContainText('Không nhập tệp');
  expect(await previewDoc(page)).toEqual(before);
  expect(dialogs).toEqual([]);

  // Forged requests with the designer's own valid credentials are refused by the server or the bridge.
  const hash = (await forged(page, 'designer', 'GET', versionPath())).body.contentHash;
  expect(await forged(page, 'designer', 'POST', `${versionPath()}/publish`, { expectedRevision: 2, contentHash: hash })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
  expect(await forged(page, 'designer', 'PUT', versionPath(), { expectedRevision: 2, content: { ...example, tenantId: definitionId } })).toMatchObject({ status: 422, body: { code: 'VALIDATION_FAILED' } });
  expect(await forged(page, 'designer', 'GET', 'admin/workflow-definitions', undefined, { 'x-tenant-id': definitionId })).toMatchObject({ status: 403 });
  expect((await forged(page, 'designer', 'POST', `${versionPath()}/revoke`, { contentHash: hash, reasonCode: 'DEFECT' })).status).toBe(404);

  // Restore a valid definition, move a step, save; reload keeps semantics (server) and geometry (local cache by hash).
  await importJson(page, { content: example, layout: { nodes: {}, edges: {} } });
  await expect(page.getByRole('button', { name: 'Bắt đầu', exact: true })).toBeEnabled();
  await page.getByLabel('Chọn phần tử').selectOption('n_confirm_extraction');
  await page.getByRole('button', { name: 'Phải', exact: true }).click();
  await page.getByRole('button', { name: 'Lưu lên máy chủ', exact: true }).click();
  await expect(status(page)).toHaveText('Máy chủ · v1 · Bản nháp · revision 3');
  await page.getByRole('button', { name: 'Kiểm tra trên máy chủ', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Kết quả kiểm tra máy chủ' })).toContainText('Máy chủ: hợp lệ (revision 3)');
  const saved = await previewDoc(page);
  expect(saved.content).toEqual(example);
  await page.reload();
  await connect(page, 'designer');
  await openServer(page);
  await expect(status(page)).toHaveText('Máy chủ · v1 · Bản nháp · revision 3');
  expect(await previewDoc(page)).toEqual(saved);
});

test('stale version: a concurrent save yields 409 without losing edits; re-base is an explicit choice', async ({ page, browser }) => {
  await connect(page, 'designer'); await openServer(page);
  const other = await (browser as Browser).newContext(); const second = await other.newPage();
  await connect(second, 'designer2'); await openServer(second);
  await second.getByLabel('Tên workflow', { exact: true }).fill('Bản lưu của người soạn thứ hai');
  await second.getByRole('button', { name: 'Lưu lên máy chủ', exact: true }).click();
  await expect(status(second)).toHaveText('Máy chủ · v1 · Bản nháp · revision 4');

  await page.getByLabel('Tên workflow', { exact: true }).fill('Chỉnh sửa chưa lưu của người soạn một');
  await page.getByRole('button', { name: 'Lưu lên máy chủ', exact: true }).click();
  const conflict = page.getByRole('region', { name: 'Xung đột phiên bản' });
  await expect(conflict).toBeFocused();
  await expect(conflict).toBeFocused();
  await expect(conflict).toContainText('409 STALE_VERSION');
  await expect(page.getByLabel('Tên workflow', { exact: true })).toHaveValue('Chỉnh sửa chưa lưu của người soạn một');
  await expect(status(page)).toHaveText('Máy chủ · v1 · Bản nháp · revision 3 · chưa lưu');
  await expect(page.getByRole('button', { name: 'Lưu lên máy chủ', exact: true })).toBeDisabled();
  await conflict.getByRole('button', { name: 'Giữ chỉnh sửa của tôi và lưu lên revision mới nhất' }).click();
  await expect(status(page)).toHaveText('Máy chủ · v1 · Bản nháp · revision 5');
  await expect(page.getByLabel('Tên workflow', { exact: true })).toHaveValue('Chỉnh sửa chưa lưu của người soạn một');
  await expect(conflict).toHaveCount(0);
  await other.close();
});

test('maker-checker and observer: publish hidden in the UI and refused by the server for forged requests', async ({ page, browser }) => {
  await connect(page, 'editorPublisher'); await openServer(page);
  await expect(page.getByRole('button', { name: 'Xuất bản', exact: true })).toBeVisible(); // not an editor yet
  await page.getByLabel('Tên workflow', { exact: true }).fill(example.title);
  await page.getByRole('button', { name: 'Lưu lên máy chủ', exact: true }).click();
  await expect(status(page)).toHaveText('Máy chủ · v1 · Bản nháp · revision 6');
  await expect(page.getByRole('button', { name: 'Xuất bản', exact: true })).toHaveCount(0); // now an editor
  const hash = (await forged(page, 'editorPublisher', 'GET', versionPath())).body.contentHash;
  expect(await forged(page, 'editorPublisher', 'POST', `${versionPath()}/publish`, { expectedRevision: 6, contentHash: hash })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });

  const ctx = await (browser as Browser).newContext(); const observer = await ctx.newPage();
  await connect(observer, 'observer'); await openServer(observer);
  await expect(observer.getByRole('button', { name: 'Xuất bản', exact: true })).toHaveCount(0);
  await observer.getByRole('button', { name: 'Lưu lên máy chủ', exact: true }).click();
  await expect(designer(observer).getByRole('alert')).toContainText('FORBIDDEN');
  expect(await forged(observer, 'observer', 'POST', `${versionPath()}/publish`, { expectedRevision: 6, contentHash: hash })).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
  expect((await state()).versions[0]).toMatchObject({ status: 'DRAFT', revision: 6, has_publisher: false });
  await ctx.close();
});

test('authorized publisher previews, validates and publishes; the published version is immutable', async ({ page }, testInfo) => {
  await connect(page, 'publisher'); await openServer(page);
  await expect(page.getByRole('button', { name: 'Xuất bản', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await expect(page.getByTestId('workflow-summary')).toContainText('confirm_extraction');
  await expect(page.getByTestId('workflow-summary')).toContainText('CLAIM_REVIEWER');
  await page.getByRole('button', { name: 'Kiểm tra trên máy chủ', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Kết quả kiểm tra máy chủ' })).toContainText('Máy chủ: hợp lệ (revision 6)');
  const hash = (await forged(page, 'publisher', 'GET', versionPath())).body.contentHash;
  await page.getByRole('button', { name: 'Xuất bản', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Xác nhận xuất bản ${KEY} v1` });
  await expect(dialog).toContainText(hash);
  await dialog.getByRole('button', { name: 'Xác nhận xuất bản', exact: true }).click();
  await expect(status(page)).toHaveText('Máy chủ · v1 · Đã xuất bản · revision 6');
  await expect(page.getByTestId('immutable-notice')).toContainText('bất biến');
  await expect(page.getByRole('button', { name: 'Người xử lý', exact: true })).toBeDisabled();
  await expect(page.getByTestId('workflow-properties')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Lưu lên máy chủ', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tạo bản nháp mới từ phiên bản này', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('published-immutable-view.png'), fullPage: true });

  const db = await state();
  expect(db.versions).toEqual([expect.objectContaining({ version_no: 1, status: 'PUBLISHED', revision: 6, content_hash: hash, has_publisher: true })]);
  expect(db.audit).toEqual(expect.arrayContaining([{ action: 'WORKFLOW_DEFINITION_PUBLISHED', n: 1 }, { action: 'WORKFLOW_DRAFT_CREATED', n: 1 }]));
  expect(db.outbox).toEqual([{ event_type: 'workflow.definition-published', n: 1 }]);
  expect(db.bindings.map((b: { benefit_type: string }) => b.benefit_type)).toEqual(['DENTAL', 'OUTPATIENT']);
  expect(db.tenantOfDefinition).toBe(true);
  // Immutable on the server too: a forged edit of the published version is a 409.
  expect(await forged(page, 'designer', 'PUT', versionPath(), { expectedRevision: 6, content: example })).toMatchObject({ status: 409, body: { code: 'STALE_VERSION' } });
  // Reload shows the same immutable version.
  await page.reload(); await connect(page, 'publisher'); await openServer(page);
  await expect(status(page)).toHaveText('Máy chủ · v1 · Đã xuất bản · revision 6');
  expect((await previewDoc(page)).content).toEqual((await forged(page, 'publisher', 'GET', versionPath())).body.content);
  await testInfo.attach('integrated-publish-evidence.json', { contentType: 'application/json', body: JSON.stringify({
    database: harness!.external ? `EXTERNAL (local feedback, not PG16 evidence) ${harness!.pgVersion}` : `Docker PostgreSQL ${harness!.pgVersion}`,
    coreApi: 'compiled dist identity + workflow-definition controllers, synthetic OIDC issuer', db,
  }, null, 2) });
});

test('other tenant cannot see or address the published definition (404, empty list)', async ({ page }) => {
  await connect(page, 'designerB');
  await expect(page.getByRole('status').filter({ hasText: 'Chưa có quy trình nào' })).toBeVisible();
  expect(await forged(page, 'designerB', 'GET', versionPath())).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
  expect((await state()).otherTenantRows).toBe(0);
});
