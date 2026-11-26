import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { freePort, startWeb, stop, type Owned } from './processes';
import { canonicalJson, newDocument, type EditorDocument, type WorkflowContent } from '../src/lib/workflow-definition';
import { toBpmnXml } from '../src/lib/workflow-bpmn';
import { DRAFT_KEY, draftKey } from '../src/lib/workflow-draft';

// Real browser editor, browser-local synthetic data only. No mocked workflow APIs or publish claims.
let web: Owned | undefined, webUrl: string;
test.beforeAll(async () => {
  const port = await freePort();
  web = await startWeb(port, 'http://127.0.0.1:1');
  webUrl = `http://127.0.0.1:${port}`;
});
test.afterAll(async () => { await stop(web); });

async function openEditor(page: Page) {
  await page.goto(`${webUrl}/quy-trinh`);
  await page.getByRole('button', { name: 'Mở trình vẽ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bắt đầu', exact: true })).toBeEnabled();
  await expect(page.locator('.bjs-powered-by')).toBeVisible();
  await expect(page.getByTestId('bpmn-license')).toContainText('Copyright (c) 2014-present Camunda Services GmbH');
}
async function documentFromPreview(page: Page): Promise<EditorDocument> {
  const preview = page.getByTestId('canonical-preview');
  if (!await preview.isVisible()) await page.getByRole('button', { name: 'Xem JSON chuẩn' }).click();
  return JSON.parse((await preview.textContent())!);
}
async function importJson(page: Page, doc: EditorDocument) {
  await page.getByLabel('Nhập JSON / BPMN').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(canonicalJson(doc)) });
  await expect(page.getByRole('status').filter({ hasText: 'Đã nhập' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bắt đầu', exact: true })).toBeEnabled();
}

test('lazy-loads upstream editor only on opening; reports measured script bytes and retains branding', async ({ page }, testInfo) => {
  await page.goto(`${webUrl}/quy-trinh`);
  await expect(page.getByRole('heading', { name: 'Thiết kế quy trình' })).toBeVisible();
  await expect(page.locator('.bjs-container')).toHaveCount(0);
  const before = await page.evaluate(() => performance.getEntriesByType('resource').filter(e => e.name.endsWith('.js')).map(e => e.name));
  await page.getByRole('button', { name: 'Mở trình vẽ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bắt đầu', exact: true })).toBeEnabled();
  await expect(page.locator('.bjs-powered-by')).toBeVisible();
  const deferred = await page.evaluate(prior => performance.getEntriesByType('resource').filter(e => e.name.endsWith('.js') && !prior.includes(e.name)).map(e => ({ name: new URL(e.name).pathname, bytes: (e as PerformanceResourceTiming).encodedBodySize })), before);
  expect(deferred.length).toBeGreaterThan(0);
  expect(deferred.reduce((sum, item) => sum + item.bytes, 0)).toBeGreaterThan(0);
  await testInfo.attach('designer-deferred-scripts.json', { body: JSON.stringify(deferred, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('designer.png'), fullPage: true });
});

test('keyboard add/configure/connect/move/delete and error focus use the constrained upstream modeler', async ({ page }) => {
  await openEditor(page);
  const button = page.getByRole('button', { name: 'Người xử lý', exact: true });
  await button.focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('Chọn phần tử')).toHaveValue('n_human_task_1');
  await page.getByRole('button', { name: 'Kiểm tra cục bộ', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Kết quả kiểm tra' })).toContainText('SCHEMA_INVALID');
  await expect(page.getByRole('region', { name: 'Kết quả kiểm tra' })).toBeFocused();
  const properties = page.getByTestId('workflow-properties');
  const n = JSON.parse(await properties.inputValue());
  await properties.fill('7');
  await page.getByRole('button', { name: 'Áp dụng thuộc tính', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Trình thiết kế quy trình', exact: true }).getByRole('alert')).toContainText('SCHEMA_INVALID');
  n.sla.dueSeconds = 3600; n.allowedActionIds = ['ESCALATE_TO_MANUAL_REVIEW'];
  n.allowedEvidence = { documentTypes: ['INVOICE_PHOTO'], sources: ['OCR'] };
  delete n.accountableOwner;
  await properties.fill(JSON.stringify(n));
  await page.getByRole('button', { name: 'Áp dụng thuộc tính', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Trình thiết kế quy trình', exact: true }).getByRole('alert')).toContainText('SCHEMA_INVALID');
  n.accountableOwner = 'CASE_OWNER';
  await properties.fill(JSON.stringify(n));
  await page.getByRole('button', { name: 'Áp dụng thuộc tính', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bắt đầu', exact: true })).toBeEnabled();
  const beforeMove = await documentFromPreview(page);
  await page.getByRole('button', { name: 'Phải', exact: true }).click();
  const afterMove = await documentFromPreview(page);
  expect(afterMove.layout.nodes.human_task_1.x).toBe(beforeMove.layout.nodes.human_task_1.x + 20);
  expect(afterMove.content).toEqual(beforeMove.content);
  await page.getByLabel('Chọn phần tử').selectOption('e_start_end');
  await page.getByRole('button', { name: 'Xóa phần tử', exact: true }).click();
  await page.getByLabel('Từ bước').selectOption('start'); await page.getByLabel('Đến bước').selectOption('human_task_1');
  await page.getByRole('button', { name: 'Kết nối', exact: true }).click();
  await page.getByLabel('Từ bước').selectOption('human_task_1'); await page.getByLabel('Đến bước').selectOption('end');
  await page.getByRole('button', { name: 'Kết nối', exact: true }).click();
  await page.getByRole('button', { name: 'Kiểm tra cục bộ', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Kết quả kiểm tra' })).toContainText('Cấu trúc và đồ thị cục bộ hợp lệ');
  await expect(page.getByRole('region', { name: 'Kết quả kiểm tra' })).toContainText('Không đủ điều kiện xuất bản');
});

test('all seven allowed node types can be added; pointer drag moves upstream shapes', async ({ page }) => {
  await openEditor(page);
  for (const label of ['Bắt đầu', 'Kết thúc', 'Người xử lý', 'AI đề xuất', 'Điều kiện', 'Chờ bổ sung', 'Hẹn giờ']) {
    await page.getByRole('button', { name: label, exact: true }).click();
  }
  const before = await documentFromPreview(page);
  expect(new Set(before.content.nodes.map(n => n.type)).size).toBe(7);
  const shape = page.locator('[data-element-id="n_timer_1"] .djs-visual').first();
  await shape.scrollIntoViewIfNeeded();
  await expect(shape).toBeInViewport();
  const box = await shape.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 15, box!.y + 15); await page.mouse.down();
  await page.mouse.move(box!.x + 50, box!.y + 45, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await documentFromPreview(page)).layout.nodes.timer_1.x).not.toBe(before.layout.nodes.timer_1.x);
  const after = await documentFromPreview(page);
  expect(after.layout.nodes.timer_1).not.toEqual(before.layout.nodes.timer_1);
  expect(after.content).toEqual(before.content);
});

test('native toolbox drag/drop creates a bounded node through upstream modeling', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Hẹn giờ', exact: true }).dragTo(page.getByTestId('workflow-canvas'), { targetPosition: { x: 180, y: 100 } });
  await expect(page.getByLabel('Chọn phần tử')).toHaveValue('n_timer_1');
  expect((await documentFromPreview(page)).content.nodes.some(n => n.nodeId === 'timer_1' && n.type === 'TIMER')).toBe(true);
});

test('canonical properties and layout round-trip through export/import and save/reload', async ({ page }) => {
  await openEditor(page);
  const content: WorkflowContent = JSON.parse(await readFile(new URL('../../../docs/ai-specs/examples/visual-workflow-intake-review.example.json', import.meta.url), 'utf8'));
  const doc: EditorDocument = { content, layout: { nodes: {}, edges: {} } };
  doc.layout.labels = { n_start: { x: 75, y: 235, width: 90, height: 28 } };
  await importJson(page, doc);
  await page.getByLabel('Chọn phần tử').selectOption('n_confirm_extraction');
  await page.getByRole('button', { name: 'Phải', exact: true }).click();
  const before = await documentFromPreview(page);
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Xuất BPMN', exact: true }).click();
  const download = await pending, xml = await readFile((await download.path())!, 'utf8');
  await page.getByLabel('Nhập JSON / BPMN').setInputFiles({ name: 'roundtrip.bpmn', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await expect(page.getByRole('status').filter({ hasText: 'Đã nhập' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bắt đầu', exact: true })).toBeEnabled();
  expect(await documentFromPreview(page)).toEqual(before);
  await page.getByRole('button', { name: 'Lưu cục bộ', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu' })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Mở trình vẽ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bắt đầu', exact: true })).toBeEnabled();
  expect(await documentFromPreview(page)).toEqual(before);
});

test('hostile XML/JSON is rejected before replacing the current draft or making external requests', async ({ page }) => {
  await openEditor(page);
  const baseline = await documentFromPreview(page), xml = toBpmnXml(newDocument());
  const outbound: string[] = [];
  page.on('request', req => { if (!req.url().startsWith(webUrl) && !req.url().startsWith('data:')) outbound.push(req.url()); });
  const bad = [
    '<!DOCTYPE x [<!ENTITY p SYSTEM "https://invalid.example/secret">]><x>&p;</x>',
    xml.replaceAll('bpmn:startEvent', 'bpmn:parallelGateway'),
    xml.replaceAll('bpmn:startEvent', 'bpmn:scriptTask'),
    xml.replace('<bpmn:startEvent', '<bpmn:startEvent onclick="alert(1)"'),
    xml.replace('</bpmn:process>', '<bpmn:conditionExpression>execute()</bpmn:conditionExpression></bpmn:process>'),
    xml.replace('sourceRef="n_start"', 'sourceRef="https://invalid.example/process"'),
    xml.replace('urn:tpa:workflow:1', 'https://invalid.example/namespace'),
    xml.replace('isExecutable="false"', 'isExecutable="true"'),
    xml.replace('</bpmn:process>', '<bpmn:userTask id="hidden"/></bpmn:process>'),
    xml.replace('bpmnElement="n_start"', 'bpmnElement="n_orphan"'),
    '<broken', 'ă'.repeat(131073),
  ];
  for (const input of bad) {
    await page.getByLabel('Nhập JSON / BPMN').setInputFiles({ name: 'hostile.bpmn', mimeType: 'application/xml', buffer: Buffer.from(input) });
    await expect(page.getByRole('region', { name: 'Trình thiết kế quy trình', exact: true }).getByRole('alert')).toContainText('Không nhập tệp');
    expect(await documentFromPreview(page)).toEqual(baseline);
  }
  const tampered = structuredClone(baseline); tampered.content.nodes[0].label = '<img src=x onerror=alert(1)>';
  await page.getByLabel('Nhập JSON / BPMN').setInputFiles({ name: 'tampered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(tampered)) });
  await expect(page.getByRole('region', { name: 'Trình thiết kế quy trình', exact: true }).getByRole('alert')).toContainText('SCHEMA_INVALID');
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
  await expect(page.getByRole('region', { name: 'Trình thiết kế quy trình', exact: true }).getByRole('alert')).toContainText('tab khác');
  await expect(page.getByLabel('Tên workflow', { exact: true })).toHaveValue('Chỉnh sửa chưa lưu ở tab một');
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Xuất JSON', exact: true }).click();
  const download = await pending, exported = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(exported.content.title).toBe('Chỉnh sửa chưa lưu ở tab một');
  await second.close();
});

test('read-only local preview disables mutations and never calls a workflow publication API', async ({ page }) => {
  const workflowRequests: string[] = [];
  page.on('request', req => { if (req.url().includes('/v1/workflow')) workflowRequests.push(req.url()); });
  await openEditor(page); const before = await documentFromPreview(page);
  await page.getByLabel('Chỉ xem cục bộ').check();
  await expect(page.getByRole('button', { name: 'Lưu cục bộ', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Người xử lý', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Kết nối', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Xuất bản (chưa kết nối)', exact: true })).toBeDisabled();
  await expect(page.getByTestId('workflow-properties')).toBeDisabled();
  expect(await documentFromPreview(page)).toEqual(before);
  expect(workflowRequests).toEqual([]);
});

test('tampered stored draft is not rendered and cannot be overwritten by a save', async ({ page }) => {
  await page.goto(`${webUrl}/quy-trinh`);
  const key = draftKey(`${DRAFT_KEY}.sandbox`);
  await page.evaluate(k => localStorage.setItem(k, '{broken'), key);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Trình thiết kế quy trình', exact: true }).getByRole('alert')).toContainText('Không thể đọc bản nháp');
  await page.getByRole('button', { name: 'Mở trình vẽ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bắt đầu', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Lưu cục bộ', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Trình thiết kế quy trình', exact: true }).getByRole('alert')).toContainText('Không lưu được');
  expect(await page.evaluate(k => localStorage.getItem(k), key)).toBe('{broken');
});
