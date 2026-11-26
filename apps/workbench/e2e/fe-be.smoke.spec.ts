import { expect, test, type Page } from '@playwright/test';
import { freePort, startCoreApi, startWeb, stop, type Owned } from './processes';

// Real processes: compiled Nest (apps/core-api/dist) + production Next (`next start`).
// Nothing is mocked; backend-down is produced by actually stopping core-api.
const EVIDENCE = 'test-results/evidence';

let apiPort: number;
let api: Owned | undefined;
let web: Owned | undefined;
let webUrl: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  apiPort = await freePort();
  const webPort = await freePort();
  api = await startCoreApi(apiPort);
  web = await startWeb(webPort, `http://127.0.0.1:${apiPort}`);
  webUrl = `http://127.0.0.1:${webPort}`;
});

test.afterAll(async () => {
  await stop(web);
  await stop(api);
});

function trackForeignRequests(page: Page): string[] {
  const foreign: string[] = [];
  page.on('request', req => {
    if (!req.url().startsWith(webUrl)) foreign.push(req.url());
  });
  return foreign;
}

test('overview shows real core-api liveness through the same-origin route', async ({ page }) => {
  const foreign = trackForeignRequests(page);
  await page.goto(webUrl);
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Không gian làm việc TPA Sức khỏe & Nhân thọ');
  await expect(page.getByTestId('backend-status-pill')).toHaveAttribute('data-state', 'ONLINE');
  await expect(page.getByTestId('backend-status-title')).toHaveText('Core API đang chạy');
  await expect(page.getByTestId('backend-http-status')).toHaveText('200');
  await expect(page.getByTestId('backend-status-panel')).toContainText('KHÔNG phải sẵn sàng nghiệp vụ');
  await expect(page.getByTestId('preview-banner')).toContainText('BẢN XEM TRƯỚC CỤC BỘ');
  await expect(page.getByTestId('pending-capabilities')).toContainText('#37');
  await page.screenshot({ path: `${EVIDENCE}/01-overview-online.png`, fullPage: true });
  expect(foreign, 'browser must only talk to the web origin').toEqual([]);
});

test('health route is GET-only, fixed-target and does not echo the internal address', async ({ request }) => {
  const res = await request.get(`${webUrl}/api/backend-health?target=http://example.com/&path=/v1/claims`);
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toContain('no-store');
  const body = await res.json();
  expect(body).toMatchObject({ state: 'ONLINE', scope: 'PROCESS_LIVENESS_ONLY', httpStatus: 200, detail: 'LIVENESS_OK' });
  expect(JSON.stringify(body)).not.toContain(String(apiPort));
  expect((await request.post(`${webUrl}/api/backend-health`)).status()).toBe(405);
  // Existing scaffold expectation preserved: no claims API exists on core-api yet.
  expect((await request.post(`http://127.0.0.1:${apiPort}/v1/claims`, { data: {} })).status()).toBe(404);
});

test('intake preview is honest: local draft only, upload and submit disabled, no backend calls', async ({ page }) => {
  const foreign = trackForeignRequests(page);
  const apiCalls: string[] = [];
  page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/') && !req.url().endsWith('/api/backend-health')) apiCalls.push(req.url()); });
  await page.goto(`${webUrl}/tiep-nhan`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Yêu cầu bồi thường khám ngoại trú');
  await expect(page.getByTestId('submit-claim')).toBeDisabled();
  await expect(page.getByTestId('upload-invoice_docs')).toBeDisabled();
  await expect(page.getByTestId('field-insured_person')).toContainText('Cần backend');
  await expect(page.getByTestId('step-extra')).toHaveAttribute('data-visible', 'false');
  await expect(page.getByTestId('missing-list').locator('li')).toHaveCount(5);

  await page.getByTestId('draft-visit_reason').selectOption('ACCIDENT');
  await expect(page.getByTestId('step-extra')).toHaveAttribute('data-visible', 'true');
  await expect(page.getByTestId('field-accident_date')).toContainText('Bắt buộc khi nộp');
  await expect(page.getByTestId('missing-list')).toContainText('Ngày xảy ra tai nạn');
  await expect(page.getByTestId('field-has_police_report')).toHaveCount(0);
  await page.getByTestId('draft-accident_date').fill('2026-11-20');
  await expect(page.getByTestId('field-has_police_report')).toBeVisible();
  await expect(page.getByTestId('missing-list').locator('li')).toHaveCount(4);
  await page.screenshot({ path: `${EVIDENCE}/02-intake-preview.png`, fullPage: true });

  await page.reload();
  await expect(page.getByTestId('step-extra')).toHaveAttribute('data-visible', 'false');
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(foreign).toEqual([]);
  expect(apiCalls).toEqual([]);
});

test('backend down is shown truthfully and recovers when core-api restarts', async ({ page }) => {
  await page.goto(`${webUrl}/he-thong`);
  await expect(page.getByTestId('backend-status-panel')).toHaveAttribute('data-state', 'ONLINE');

  await stop(api);
  await page.getByRole('button', { name: 'Kiểm tra lại' }).click();
  await expect(page.getByTestId('backend-status-panel')).toHaveAttribute('data-state', 'UNREACHABLE');
  await expect(page.getByTestId('backend-status-title')).toHaveText('Không kết nối được Core API');
  await expect(page.getByTestId('backend-status-pill')).toHaveAttribute('data-state', 'UNREACHABLE');
  await expect(page.getByTestId('backend-detail')).toHaveText('CONNECTION_FAILED');
  await page.screenshot({ path: `${EVIDENCE}/03-backend-down.png`, fullPage: true });

  api = await startCoreApi(apiPort);
  await page.getByRole('button', { name: 'Kiểm tra lại' }).click();
  await expect(page.getByTestId('backend-status-panel')).toHaveAttribute('data-state', 'ONLINE');
});

test('browser offline state is distinct from backend failure and recovers when online', async ({ page, context }) => {
  await page.goto(`${webUrl}/he-thong`);
  await expect(page.getByTestId('backend-status-panel')).toHaveAttribute('data-state', 'ONLINE');
  await context.setOffline(true);
  await expect(page.getByTestId('backend-status-pill')).toHaveAttribute('data-state', 'BROWSER_OFFLINE');
  await page.getByRole('button', { name: 'Kiểm tra lại' }).click();
  await expect(page.getByTestId('backend-status-title')).toHaveText('Trình duyệt đang ngoại tuyến');
  await page.screenshot({ path: `${EVIDENCE}/04-browser-offline.png`, fullPage: true });
  await context.setOffline(false);
  await expect(page.getByTestId('backend-status-panel')).toHaveAttribute('data-state', 'ONLINE');
});

test('web server down is reported as web unreachable, not as a backend verdict', async ({ page }) => {
  const extraPort = await freePort();
  const extra = await startWeb(extraPort, `http://127.0.0.1:${apiPort}`);
  try {
    await page.goto(`http://127.0.0.1:${extraPort}/he-thong`);
    await expect(page.getByTestId('backend-status-panel')).toHaveAttribute('data-state', 'ONLINE');
    await stop(extra);
    await page.getByRole('button', { name: 'Kiểm tra lại' }).click();
    await expect(page.getByTestId('backend-status-panel')).toHaveAttribute('data-state', 'WEB_UNREACHABLE');
  } finally {
    await stop(extra);
  }
});

test('non-loopback backend address is refused at runtime (misconfigured, no request)', async ({ page }) => {
  const badPort = await freePort();
  const bad = await startWeb(badPort, 'http://169.254.169.254');
  try {
    await page.goto(`http://127.0.0.1:${badPort}/he-thong`);
    await expect(page.getByTestId('backend-status-panel')).toHaveAttribute('data-state', 'MISCONFIGURED');
    await expect(page.getByTestId('backend-detail')).toHaveText('CONFIG_NOT_LOOPBACK');
  } finally {
    await stop(bad);
  }
});

test('responsive navigation works on a phone-sized viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(webUrl);
  const menu = page.getByRole('button', { name: 'Mở menu' });
  await expect(menu).toBeVisible();
  await menu.click();
  await page.locator('#mobile-nav').getByRole('link', { name: /Tiếp nhận hồ sơ/ }).click();
  await expect(page).toHaveURL(`${webUrl}/tiep-nhan`);
  await expect(page.locator('#mobile-nav')).toHaveCount(0);
  await expect(page.getByTestId('backend-status-pill')).toHaveAttribute('data-state', 'ONLINE');
  await page.screenshot({ path: `${EVIDENCE}/05-mobile-intake.png`, fullPage: true });
});
