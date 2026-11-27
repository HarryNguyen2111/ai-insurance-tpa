import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { freePort, startWeb, stop, type Owned } from './processes';
import { canonicalJson, newDocument, type EditorDocument, type WorkflowContent } from '../src/lib/workflow-definition';
import { toBpmnXml } from '../src/lib/workflow-bpmn';
import { DRAFT_KEY, draftKey } from '../src/lib/workflow-draft';

// Real browser builder (#102, React Flow), browser-local synthetic data only. No mocked workflow APIs or publish claims.
// Server save/validate/publish/409/maker-checker run against the real API in workflow-server.integration.spec.ts.
let web: Owned | undefined, webUrl: string;
test.beforeAll(async () => {
  const port = await freePort();
  web = await startWeb(port, 'http://127.0.0.1:1');
  webUrl = `http://127.0.0.1:${port}`;
});
test.afterAll(async () => { await stop(web); });

const example = async (): Promise<WorkflowContent> => JSON.parse(await readFile(new URL('../../../docs/ai-specs/examples/visual-workflow-intake-review.example.json', import.meta.url), 'utf8'));
const designer = (page: Page) => page.getByRole('region', { name: 'Trình thiết kế quy trình', exact: true });
const flowNode = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Thuộc tính' });
const heading = (page: Page) => inspector(page).getByRole('heading', { level: 2 });

async function openEditor(page: Page) {
  await page.goto(`${webUrl}/quy-trinh`);
  await page.getByRole('button', { name: 'Mở trình vẽ', exact: true }).click();
  await expect(flowNode(page, 'start')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bắt đầu', exact: true })).toBeEnabled();
}
async function openAdvanced(page: Page) {
  if (!await page.getByRole('button', { name: 'Xem JSON chuẩn' }).isVisible()) await page.getByRole('tab', { name: 'Nâng cao · JSON/BPMN' }).click();
}
async function documentFromPreview(page: Page): Promise<EditorDocument> {
  const preview = page.getByTestId('canonical-preview');
  if (!await preview.isVisible()) { await openAdvanced(page); await page.getByRole('button', { name: 'Xem JSON chuẩn' }).click(); }
  return JSON.parse((await preview.textContent())!);
}
async function importFile(page: Page, name: string, body: string, mimeType = 'application/json') {
  await openAdvanced(page);
  await page.getByLabel('Nhập JSON / BPMN').setInputFiles({ name, mimeType, buffer: Buffer.from(body) });
}
async function importJson(page: Page, doc: EditorDocument) {
  await importFile(page, 'synthetic.json', canonicalJson(doc));
  await expect(page.getByRole('status').filter({ hasText: 'Đã nhập' })).toBeVisible();
  await expect(flowNode(page, doc.content.nodes[0].nodeId)).toBeVisible();
}
const select = (page: Page, list: 'Bước' | 'Nhánh', id: string) => page.getByRole('list', { name: list, exact: true }).getByRole('button', { name: new RegExp(`· ${id}$`) }).click();
/** Waits until React Flow's viewport transform stops animating (fit/centre use short transitions). */
async function settled(page: Page) {
  const transform = () => page.locator('.react-flow__viewport').evaluate(e => getComputedStyle(e).transform);
  let last = '';
  await expect.poll(async () => { const now = await transform(); const same = now === last; last = now; return same; }, { intervals: [120] }).toBe(true);
}
const validate = (page: Page) => page.getByRole('button', { name: /^Kiểm tra/ }).click();
const results = (page: Page) => page.getByRole('region', { name: 'Kết quả kiểm tra', exact: true });

test('lazy-loads React Flow only on opening; reports measured script bytes; empty state offers templates; no token UI', async ({ page }, testInfo) => {
  await page.goto(`${webUrl}/quy-trinh`);
  await expect(page.getByRole('heading', { name: 'Bắt đầu thiết kế quy trình' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Mẫu quy trình' }).getByRole('button')).toHaveCount(3);
  await expect(page.locator('.react-flow')).toHaveCount(0);
  await expect(page.getByLabel('Access token')).toHaveCount(0);
  await expect(page.locator('summary').filter({ hasText: 'Máy chủ quy trình' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Kết nối máy chủ', exact: true })).toHaveCount(0);
  const before = await page.evaluate(() => performance.getEntriesByType('resource').filter(e => e.name.endsWith('.js')).map(e => e.name));
  await page.getByRole('button', { name: 'Mở trình vẽ', exact: true }).click();
  await expect(flowNode(page, 'start')).toBeVisible();
  await expect(page.locator('.react-flow__attribution')).toBeVisible(); // upstream attribution kept (no Pro hideAttribution)
  await expect(page.locator('.react-flow__minimap')).toBeVisible();
  const deferred = await page.evaluate(prior => performance.getEntriesByType('resource').filter(e => e.name.endsWith('.js') && !prior.includes(e.name)).map(e => ({ name: new URL(e.name).pathname, bytes: (e as PerformanceResourceTiming).encodedBodySize })), before);
  expect(deferred.length).toBeGreaterThan(0);
  expect(deferred.reduce((sum, item) => sum + item.bytes, 0)).toBeGreaterThan(0);
  await testInfo.attach('designer-deferred-scripts.json', { body: JSON.stringify(deferred, null, 2), contentType: 'application/json' });
});

test('keyboard add, form configuration, field-focused errors, keyboard move/connect/delete; no JSON in the default path', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Người xử lý', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Người xử lý');
  await expect(page.getByRole('list', { name: 'Bước', exact: true }).getByRole('button', { name: /human_task_1$/ })).toHaveAttribute('aria-pressed', 'true');
  await validate(page);
  await expect(results(page)).toBeFocused();
  await expect(results(page)).not.toContainText('hợp lệ');
  // Clicking an issue selects the node and focuses the exact field.
  await results(page).getByRole('button').filter({ hasText: 'sla.dueSeconds' }).click();
  await expect(inspector(page).getByLabel('SLA xử lý', { exact: true })).toBeFocused();
  await page.keyboard.type('2');
  await inspector(page).getByLabel('Chuyển duyệt thủ công').check();
  await inspector(page).getByLabel('Ảnh hóa đơn').check();
  await inspector(page).getByLabel('OCR', { exact: false }).first().check();
  let doc = await documentFromPreview(page);
  expect(doc.content.nodes.find(n => n.nodeId === 'human_task_1')).toMatchObject({ sla: { dueSeconds: 7200, escalateTo: 'CASE_OWNER' }, allowedActionIds: ['ESCALATE_TO_MANUAL_REVIEW'],
    allowedEvidence: { documentTypes: ['INVOICE_PHOTO'], sources: ['OCR'] }, accountableOwner: 'CASE_OWNER' });
  // Native React Flow keyboard move: geometry only, canonical content unchanged.
  const beforeMove = doc;
  await flowNode(page, 'human_task_1').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await documentFromPreview(page)).layout.nodes.human_task_1.x).toBeGreaterThan(beforeMove.layout.nodes.human_task_1.x);
  expect((await documentFromPreview(page)).content).toEqual(beforeMove.content);
  // Keyboard alternative for connect/delete via the outline list + inspector.
  await select(page, 'Nhánh', 'start_end');
  await inspector(page).getByRole('button', { name: 'Xóa nhánh', exact: true }).click();
  await select(page, 'Bước', 'start');
  await inspector(page).getByLabel('Nối tới bước').selectOption('human_task_1');
  await inspector(page).getByRole('button', { name: 'Thêm nhánh', exact: true }).click();
  await select(page, 'Bước', 'human_task_1');
  await inspector(page).getByLabel('Nối tới bước').selectOption('end');
  await inspector(page).getByRole('button', { name: 'Thêm nhánh', exact: true }).click();
  await expect(heading(page)).toHaveText('Nhánh Chuyển duyệt thủ công');
  await validate(page);
  await expect(results(page)).toContainText('Cấu trúc và đồ thị cục bộ hợp lệ');
  await expect(results(page)).toContainText('Không đủ điều kiện xuất bản');
  doc = await documentFromPreview(page);
  expect(doc.content.edges.map(e => [e.source, e.target, e.guard])).toEqual([['start', 'human_task_1', { kind: 'NEXT' }], ['human_task_1', 'end', { kind: 'ACTION', actionId: 'ESCALATE_TO_MANUAL_REVIEW' }]]);
  // Normal editing never exposed a JSON textarea.
  await expect(page.locator('textarea')).toHaveCount(0);
});

test('all seven supported node types can be added; pointer drag moves a card without changing content', async ({ page }) => {
  await openEditor(page);
  for (const label of ['Bắt đầu', 'Kết thúc', 'Người xử lý', 'AI đề xuất', 'Điều kiện', 'Chờ bổ sung', 'Hẹn giờ']) await page.getByRole('button', { name: label, exact: true }).click();
  const before = await documentFromPreview(page);
  expect(new Set(before.content.nodes.map(n => n.type)).size).toBe(7);
  const card = flowNode(page, 'timer_1');
  await page.getByRole('button', { name: 'Căn giữa bước trên sơ đồ' }).click();
  await expect(card).toBeInViewport();
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 12); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 52, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await documentFromPreview(page)).layout.nodes.timer_1.x).not.toBe(before.layout.nodes.timer_1.x);
  expect((await documentFromPreview(page)).content).toEqual(before.content);
});

test('palette drag/drop creates a bounded node; dragging between handles connects with a typed guard', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openEditor(page);
  await page.getByRole('button', { name: 'Hẹn giờ', exact: true }).dragTo(page.getByTestId('workflow-canvas'), { targetPosition: { x: 260, y: 120 } });
  await expect(heading(page)).toHaveText('Hẹn giờ');
  await expect(flowNode(page, 'timer_1')).toBeVisible();
  await page.getByRole('button', { name: 'Vừa khung nhìn' }).click();
  await expect(flowNode(page, 'start')).toBeInViewport();
  await settled(page);
  await flowNode(page, 'start').locator('.react-flow__handle.source').dragTo(flowNode(page, 'timer_1').locator('.react-flow__handle.target'));
  await expect.poll(async () => (await documentFromPreview(page)).content.edges.find(e => e.source === 'start' && e.target === 'timer_1')?.guard).toEqual({ kind: 'NEXT' });
  // Invalid connection (into START) is refused by the same rules as the server.
  await flowNode(page, 'timer_1').locator('.react-flow__handle.source').dragTo(flowNode(page, 'start'));
  expect((await documentFromPreview(page)).content.edges.some(e => e.target === 'start')).toBe(false);
});

test('canonical → BPMN → canonical round-trip is exact; layout survives save/reload', async ({ page }) => {
  await openEditor(page);
  const doc: EditorDocument = { content: await example(), layout: { nodes: {}, edges: {} } };
  await importJson(page, doc);
  const y0 = (await documentFromPreview(page)).layout.nodes.confirm_extraction.y;
  await flowNode(page, 'confirm_extraction').focus(); await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Xác nhận dữ liệu trích xuất'); // keyboard selection drives the inspector
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await documentFromPreview(page)).layout.nodes.confirm_extraction.y).toBeGreaterThan(y0);
  const before = await documentFromPreview(page);
  expect(before.content).toEqual(doc.content);
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Xuất BPMN', exact: true }).click();
  const download = await pending, xml = await readFile((await download.path())!, 'utf8');
  await importFile(page, 'roundtrip.bpmn', xml, 'application/xml');
  await expect(page.getByRole('status').filter({ hasText: 'Đã nhập' })).toBeVisible();
  expect(await documentFromPreview(page)).toEqual(before);
  await page.getByRole('button', { name: 'Lưu cục bộ', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu' })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Mở trình vẽ', exact: true }).click();
  await expect(flowNode(page, 'confirm_extraction')).toBeVisible();
  expect(await documentFromPreview(page)).toEqual(before);
});

test('hostile or unsupported XML/JSON is rejected with a clear error before replacing the draft or calling out', async ({ page }) => {
  await openEditor(page);
  const baseline = await documentFromPreview(page), xml = toBpmnXml(newDocument());
  const outbound: string[] = [];
  page.on('request', req => { if (!req.url().startsWith(webUrl) && !req.url().startsWith('data:')) outbound.push(req.url()); });
  const bad: [string, string][] = [
    ['<!DOCTYPE x [<!ENTITY p SYSTEM "https://invalid.example/secret">]><x>&p;</x>', 'UNSAFE_XML'],
    [xml.replaceAll('bpmn:startEvent', 'bpmn:parallelGateway'), 'PARALLEL_NOT_SUPPORTED'],
    [xml.replaceAll('bpmn:startEvent', 'bpmn:scriptTask'), 'UNSUPPORTED_BPMN_ELEMENT'],
    [xml.replace('<bpmn:startEvent', '<bpmn:startEvent onclick="alert(1)"'), 'UNSUPPORTED_BPMN_ELEMENT'],
    [xml.replace('</bpmn:process>', '<bpmn:conditionExpression>execute()</bpmn:conditionExpression></bpmn:process>'), 'UNSUPPORTED_BPMN_ELEMENT'],
    [xml.replace('sourceRef="n_start"', 'sourceRef="https://invalid.example/process"'), ''],
    [xml.replace('urn:tpa:workflow:1', 'https://invalid.example/namespace'), ''],
    [xml.replace('isExecutable="false"', 'isExecutable="true"'), 'UNSUPPORTED_BPMN_ELEMENT'],
    [xml.replace('</bpmn:process>', '<bpmn:userTask id="hidden"/></bpmn:process>'), ''],
    [xml.replace('bpmnElement="n_start"', 'bpmnElement="n_orphan"'), ''],
    ['<broken', ''], ['ă'.repeat(131073), 'LIMIT_EXCEEDED'],
  ];
  for (const [input, code] of bad) {
    await importFile(page, 'hostile.bpmn', input, 'application/xml');
    await expect(designer(page).getByRole('alert')).toContainText(`Không nhập tệp: ${code}`);
    expect(await documentFromPreview(page)).toEqual(baseline);
  }
  const tampered = structuredClone(baseline); tampered.content.nodes[0].label = '<img src=x onerror=alert(1)>';
  await importFile(page, 'tampered.json', JSON.stringify(tampered));
  await expect(designer(page).getByRole('alert')).toContainText('SCHEMA_INVALID');
  expect(await documentFromPreview(page)).toEqual(baseline);
  expect(outbound).toEqual([]);
});

test('stale browser-local revision preserves unsaved edits and offers an export', async ({ page, context }) => {
  await openEditor(page); await page.getByRole('button', { name: 'Lưu cục bộ', exact: true }).click();
  const second = await context.newPage(); await openEditor(second);
  await second.getByLabel('Tên workflow', { exact: true }).fill('Bản đã lưu ở tab hai');
  await second.getByRole('button', { name: 'Lưu cục bộ', exact: true }).click();
  await page.getByLabel('Tên workflow', { exact: true }).fill('Chỉnh sửa chưa lưu ở tab một');
  await page.getByRole('button', { name: 'Lưu cục bộ', exact: true }).click();
  await expect(designer(page).getByRole('alert')).toContainText('tab khác');
  await expect(page.getByLabel('Tên workflow', { exact: true })).toHaveValue('Chỉnh sửa chưa lưu ở tab một');
  await openAdvanced(page);
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Xuất JSON', exact: true }).click();
  const exported = JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
  expect(exported.content.title).toBe('Chỉnh sửa chưa lưu ở tab một');
  await second.close();
});

test('read-only mode disables every mutation path (palette, inspector, canvas keys, undo) and never calls a workflow API', async ({ page }) => {
  const workflowRequests: string[] = [];
  page.on('request', req => { if (req.url().includes('/v1/workflow') || req.url().includes('/api/workflow')) workflowRequests.push(req.url()); });
  await openEditor(page); const before = await documentFromPreview(page);
  await page.getByRole('button', { name: 'Thêm thao tác' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Chỉ xem cục bộ' }).click();
  await expect(page.getByRole('button', { name: 'Lưu cục bộ', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Người xử lý', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Xuất bản (cần máy chủ)', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Tên workflow', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Hoàn tác' })).toBeDisabled();
  await select(page, 'Bước', 'start');
  await expect(inspector(page).getByLabel('Tên bước')).toBeDisabled();
  await expect(inspector(page).getByRole('button', { name: 'Thêm nhánh' })).toBeDisabled();
  await flowNode(page, 'start').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Delete'); await page.keyboard.press('ArrowRight');
  expect(await documentFromPreview(page)).toEqual(before);
  expect(workflowRequests).toEqual([]);
});

test('tampered stored draft is not rendered and cannot be overwritten by a save', async ({ page }) => {
  await page.goto(`${webUrl}/quy-trinh`);
  const key = draftKey(`${DRAFT_KEY}.sandbox`);
  await page.evaluate(k => localStorage.setItem(k, '{broken'), key);
  await page.reload();
  await expect(designer(page).getByRole('alert')).toContainText('Không thể đọc bản nháp');
  await page.getByRole('button', { name: 'Mở trình vẽ', exact: true }).click();
  await expect(flowNode(page, 'start')).toBeVisible();
  await page.getByRole('button', { name: 'Lưu cục bộ', exact: true }).click();
  await expect(designer(page).getByRole('alert')).toContainText('Không lưu được');
  expect(await page.evaluate(k => localStorage.getItem(k), key)).toBe('{broken');
});

test('typed inspector configures candidates, owner, SLA, action and evidence; retained in preview and reload', async ({ page }) => {
  await openEditor(page);
  await importJson(page, { content: await example(), layout: { nodes: {}, edges: {} } });
  await select(page, 'Bước', 'confirm_extraction'); // outline selection also centres the card on the canvas
  await flowNode(page, 'confirm_extraction').click(); // direct click on the centred card selects the same node
  const panel = inspector(page);
  await expect(heading(page)).toHaveText('Xác nhận dữ liệu trích xuất');
  await expect(panel.getByLabel('Người chịu trách nhiệm (Accountable)')).toHaveValue('CASE_OWNER');
  await panel.getByLabel('Đơn vị · SLA xử lý').selectOption({ label: 'giờ' });
  await panel.getByLabel('SLA xử lý', { exact: true }).fill('2');
  await panel.getByLabel('Chuyển cấp khi quá SLA').selectOption({ label: 'Người phụ trách hồ sơ' });
  await panel.getByLabel('Yêu cầu bổ sung', { exact: false }).first().uncheck();
  await panel.getByLabel('Kết quả xét nghiệm').check();
  const candidates = panel.getByRole('group', { name: 'Quy tắc phân công reviewer_queue' });
  await candidates.getByLabel('Người duyệt phía DNBH').check();
  await candidates.getByLabel('Số việc đang mở tối đa mỗi người').fill('7');
  const updated = await documentFromPreview(page);
  const human = updated.content.nodes.find(n => n.nodeId === 'confirm_extraction');
  expect(human).toMatchObject({ accountableOwner: 'CASE_OWNER', sla: { dueSeconds: 7200, escalateTo: 'CASE_OWNER', reminderOffsetsSeconds: [43200] } });
  expect(human && 'allowedActionIds' in human && human.allowedActionIds).toEqual(['CONFIRM_EXTRACTION', 'ESCALATE_TO_MANUAL_REVIEW']);
  expect(human && 'allowedEvidence' in human && human.allowedEvidence.documentTypes).toContain('LAB_RESULT');
  expect(updated.content.assignmentPolicy.rules[0]).toMatchObject({ candidateRoles: ['CLAIM_REVIEWER', 'INSURER_REVIEWER'], maxActiveTasksPerAssignee: 7 });
  // Removing an allowed action leaves its route: the drawer explains it on the edge instead of silently dropping it.
  await validate(page);
  await expect(results(page)).toContainText('ACTION_NOT_ALLOWED_FOR_NODE');
  await page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await expect(page.getByTestId('workflow-summary')).toContainText('7200s');
  await expect(page.getByTestId('workflow-summary')).toContainText('INSURER_REVIEWER');
  await expect(page.getByRole('note').filter({ hasText: 'Xem trước cấu trúc' })).toContainText('không chạy Temporal');
  await page.getByRole('button', { name: 'Lưu cục bộ', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: 'Mở trình vẽ', exact: true }).click();
  await expect(flowNode(page, 'confirm_extraction')).toBeVisible();
  expect(await documentFromPreview(page)).toEqual(updated);
});

test('template + condition builder: placeholders listed per field, conditions edited with typed controls only', async ({ page }, testInfo) => {
  await page.goto(`${webUrl}/quy-trinh`);
  await page.getByRole('button', { name: /Dùng mẫu: Tiếp nhận/ }).click();
  await expect(flowNode(page, 'ai_extract')).toBeVisible();
  await expect(flowNode(page, 'ai_extract')).toContainText('Tác nhân AI: chưa cấu hình');
  await validate(page);
  await expect(results(page)).toContainText('11 lỗi cục bộ');
  await results(page).getByRole('button').filter({ hasText: 'modelRef' }).click();
  await expect(heading(page)).toHaveText('AI trích xuất chứng từ');
  await expect(inspector(page).locator('[data-field="modelRef"]')).toBeFocused();
  await select(page, 'Nhánh', 'e_retry_ai');
  const builder = inspector(page).getByRole('group', { name: 'Điều kiện rẽ nhánh' });
  await expect(builder.getByLabel('Phép so sánh')).not.toContainText('thuộc'); // IN is not offered for counters
  await builder.getByLabel('Cách kết hợp').selectOption({ label: 'Tất cả đều đúng (VÀ)' });
  await builder.getByRole('button', { name: 'Thêm điều kiện' }).click();
  const second = builder.getByRole('group', { name: 'Điều kiện 2' });
  await second.getByLabel('Biến').selectOption({ label: 'Loại quyền lợi của hồ sơ' });
  await second.getByLabel('Phép so sánh').selectOption({ label: 'thuộc' });
  await second.getByLabel('Nha khoa').check();
  const first = builder.getByRole('group', { name: 'Điều kiện 1' });
  await first.getByLabel(/Giá trị/).fill('2');
  const doc = await documentFromPreview(page);
  expect(doc.content.edges.find(e => e.edgeId === 'e_retry_ai')!.guard).toEqual({ kind: 'CONDITION', priority: 1, condition: { all: [
    { variable: 'SUPPLEMENT_ROUND', op: 'LTE', value: 2 }, { variable: 'CLAIM_BENEFIT_TYPE', op: 'IN', value: ['OUTPATIENT', 'DENTAL'] },
  ] } });
  await expect(page.locator('.react-flow__edge[data-id="e_retry_ai"]')).toContainText('Lượt bổ sung hiện tại ≤ 2 VÀ');
  await page.screenshot({ path: testInfo.outputPath('builder-condition-inspector.png') });
  // Invalid value is flagged on the field, not silently coerced.
  await first.getByLabel(/Giá trị/).fill('');
  await expect(first).toContainText('Nhập số nguyên 0–1000.');
  await expect(page.locator('textarea')).toHaveCount(0);
});

test('undo/redo (buttons and Ctrl+Z) and safe delete with restore', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Điều kiện', exact: true }).click();
  await expect(flowNode(page, 'condition_1')).toBeVisible();
  await page.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect(flowNode(page, 'condition_1')).toHaveCount(0);
  await page.getByRole('button', { name: 'Làm lại' }).click();
  await expect(flowNode(page, 'condition_1')).toBeVisible();
  await select(page, 'Bước', 'end');
  await flowNode(page, 'end').focus();
  await page.keyboard.press('Delete');
  await expect(flowNode(page, 'end')).toHaveCount(0);
  expect((await documentFromPreview(page)).content.edges).toEqual([]); // its route went with it
  await page.locator('.react-flow__pane').click();
  await page.keyboard.press('Control+z');
  await expect(flowNode(page, 'end')).toBeVisible();
  expect((await documentFromPreview(page)).content.edges.map(e => e.edgeId)).toEqual(['start_end']);
});

test('palette search is grouped and limited to supported steps', async ({ page }) => {
  await openEditor(page);
  const rail = page.getByRole('complementary', { name: 'Thư viện bước và danh sách sơ đồ' });
  await rail.getByPlaceholder('Tìm loại bước…').fill('gio');
  await expect(rail.getByRole('group', { name: 'Điều hướng và chờ' }).getByRole('button')).toHaveText([/Hẹn giờ/]);
  await rail.getByPlaceholder('Tìm loại bước…').fill('http');
  await expect(rail.getByRole('status')).toContainText('Không có loại bước phù hợp');
  await rail.getByPlaceholder('Tìm bước hoặc nhánh…').fill('ket thuc');
  await expect(page.getByRole('list', { name: 'Bước', exact: true }).getByRole('button')).toHaveText([/Kết thúc/]);
});

for (const [name, width, height] of [['desktop', 1440, 900], ['laptop', 1280, 720]] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`visual: ${name} ${theme} — panels fit, nothing clipped, no blanket success`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.goto(`${webUrl}/quy-trinh`);
      await page.getByRole('button', { name: /Dùng mẫu: Tiếp nhận/ }).click();
      await expect(flowNode(page, 'confirm_extraction')).toBeVisible();
      // Dark mode is a workspace theme setting applied by the shell; emulate it after hydration.
      if (theme === 'dark') await page.evaluate(() => document.documentElement.classList.add('dark'));
      await flowNode(page, 'confirm_extraction').click();
      for (const region of [page.getByRole('complementary', { name: 'Thuộc tính' }), page.getByTestId('workflow-canvas'), page.getByRole('complementary', { name: 'Thư viện bước và danh sách sơ đồ' })]) {
        const box = (await region.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        expect(box.height).toBeGreaterThan(300);
      }
      expect((await page.getByTestId('workflow-canvas').boundingBox())!.width).toBeGreaterThan(400);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(page.getByText('hợp lệ', { exact: false }).filter({ hasText: /^Cấu trúc/ })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`builder-${name}-${theme}.png`) });
      await validate(page);
      await expect(results(page)).toContainText('lỗi cục bộ');
      // The page itself does not scroll: toolbar, canvas and drawer stay inside the viewport.
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight + 1)).toBe(true);
      expect((await page.getByTestId('workflow-canvas').boundingBox())!.height).toBeGreaterThan(200);
      await page.screenshot({ path: testInfo.outputPath(`builder-${name}-${theme}-validation.png`) });
    });
  }
}

test('performance evidence: contract-maximum graph (50 steps, 49 routes) renders fully and stays interactive', async ({ page }, testInfo) => {
  // Declared representative size = the contract maximum for nodes (50). Timings are recorded, not asserted against an SLA.
  const content = structuredClone(newDocument().content);
  content.nodes = [{ nodeId: 'start', type: 'START', label: 'Bắt đầu' },
    ...Array.from({ length: 48 }, (_, i) => ({ nodeId: `wait_${i + 1}`, type: 'TIMER' as const, label: `Chờ ${i + 1}`, delaySeconds: 60 })),
    { nodeId: 'end', type: 'END', label: 'Kết thúc', outcome: 'ROUTED_TO_MANUAL_REVIEW' }];
  const ids = content.nodes.map(n => n.nodeId);
  content.edges = ids.slice(1).map((id, i) => ({ edgeId: `r_${i + 1}`, source: ids[i], target: id, guard: { kind: 'NEXT' as const } }));
  await openEditor(page);
  const t0 = Date.now();
  await importJson(page, { content, layout: { nodes: {}, edges: {} } });
  await expect(page.locator('.react-flow__node')).toHaveCount(50);
  await expect(page.locator('.react-flow__edge')).toHaveCount(49);
  const renderMs = Date.now() - t0;
  await select(page, 'Bước', 'wait_25');
  const t1 = Date.now();
  await inspector(page).getByLabel('Tên bước').fill('Chờ giữa quy trình');
  await expect(flowNode(page, 'wait_25')).toContainText('Chờ giữa quy trình');
  const editMs = Date.now() - t1;
  await validate(page);
  await expect(results(page)).toContainText('Cấu trúc và đồ thị cục bộ hợp lệ');
  await testInfo.attach('large-graph-timings.json', { contentType: 'application/json', body: JSON.stringify({ nodes: 50, edges: 49, importToRenderedMs: renderMs, inspectorEditToCardMs: editMs, note: 'headless Chromium on the developer host; informational only' }, null, 2) });
});
