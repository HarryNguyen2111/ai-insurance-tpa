import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { freePort, startCoreApi, startWeb, stop, type Owned } from './processes';

// Browser-only organisation onboarding PROTOTYPE on the real production build.
const EVIDENCE = 'test-results/evidence';
const STORE_KEY = 'tpa.prototype.workspaces.v1';

let api: Owned | undefined;
let web: Owned | undefined;
let webUrl: string;
// The journey spans several tests in ONE browser profile (like a real user); the
// tamper test below uses its own fresh context.
let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });
  page = await context.newPage();
  const apiPort = await freePort();
  const webPort = await freePort();
  api = await startCoreApi(apiPort);
  web = await startWeb(webPort, `http://127.0.0.1:${apiPort}`);
  webUrl = `http://127.0.0.1:${webPort}`;
});

test.afterAll(async () => {
  await context?.close();
  await stop(web);
  await stop(api);
});

async function makePng(page: Page, size = 256): Promise<Buffer> {
  const b64 = await page.evaluate(s => {
    const c = document.createElement('canvas');
    c.width = s; c.height = s;
    const x = c.getContext('2d')!;
    x.fillStyle = '#0f766e'; x.fillRect(0, 0, s, s);
    x.fillStyle = '#ffffff'; x.beginPath(); x.arc(s / 2, s / 2, s / 3, 0, Math.PI * 2); x.fill();
    return c.toDataURL('image/png').split(',')[1]!;
  }, size);
  return Buffer.from(b64, 'base64');
}

async function primaryVar(page: Page): Promise<string> {
  return page.evaluate(() => document.documentElement.style.getPropertyValue('--primary'));
}

test('full journey: welcome → create organisation with logo and theme → branded workspace', async () => {
  const foreign: string[] = [];
  page.on('request', r => { if (!r.url().startsWith(webUrl) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) foreign.push(r.url()); });

  await page.goto(webUrl);
  await expect(page.getByTestId('welcome')).toBeVisible();
  await expect(page.getByTestId('active-workspace-name')).toHaveText('TPA Workspace');
  await page.screenshot({ path: `${EVIDENCE}/10-welcome.png`, fullPage: true });
  await page.getByTestId('cta-create').click();
  await expect(page).toHaveURL(`${webUrl}/to-chuc/tao-moi`);

  // Step 1: validation, Vietnamese slug suggestion, reserved slug
  await page.getByTestId('wizard-next').click();
  await expect(page.locator('#ws-name-err')).toHaveText('Tên tổ chức cần ít nhất 2 ký tự.');
  await page.getByTestId('ws-name').fill('Bảo hiểm Mẫu Minh Họa');
  await expect(page.getByTestId('ws-slug')).toHaveValue('bao-hiem-mau-minh-hoa');
  await expect(page.getByTestId('ws-short')).toHaveValue('BHMMH');
  await page.getByTestId('ws-slug').fill('admin');
  await page.getByTestId('wizard-next').click();
  await expect(page.locator('#ws-slug-err')).toHaveText('Định danh URL này được hệ thống dành riêng.');
  await page.getByTestId('ws-slug').fill('bao-hiem-mau');
  await page.getByTestId('ws-type-INSURER').click();
  await page.getByTestId('ws-desc').fill('Tổ chức mẫu để minh họa hành trình thiết lập.');
  await expect(page.getByTestId('brand-preview')).toContainText('Bảo hiểm Mẫu Minh Họa');
  await page.screenshot({ path: `${EVIDENCE}/11-wizard-info.png`, fullPage: true });
  await page.getByTestId('wizard-next').click();
  await expect(page.getByTestId('wizard-step-logo')).toHaveAttribute('data-state', 'current');

  // Step 2: SVG disguised as PNG is rejected by content sniffing; a real PNG is re-encoded
  await page.getByTestId('logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>') });
  await expect(page.getByTestId('logo-error')).toContainText('Không hỗ trợ SVG');
  await page.getByTestId('logo-input').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: await makePng(page, 32) });
  await expect(page.getByTestId('logo-error')).toContainText('tối thiểu 64');
  await page.getByTestId('logo-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: await makePng(page, 1024) });
  await expect(page.getByTestId('logo-meta')).toContainText('512×512px');
  await expect(page.getByTestId('brand-preview').getByRole('img', { name: 'Logo Bảo hiểm Mẫu Minh Họa' })).toBeVisible();
  await page.getByTestId('wizard-next').click();

  // Step 3: theme with live, scoped preview
  await page.getByTestId('preset-0f766e').click();
  await page.getByTestId('theme-sidebar-BRAND').click();
  await page.getByTestId('theme-radius-LG').click();
  await expect(page.getByTestId('brand-preview')).toHaveAttribute('data-primary', '#0f766e');
  await expect(page.getByTestId('theme-contrast')).toContainText('AA');
  await page.getByTestId('theme-hex').fill('#zzzzzz');
  await expect(page.getByText('Mã màu phải có dạng #RRGGBB.')).toBeVisible();
  await page.getByTestId('theme-hex').fill('#0f766e');
  await page.screenshot({ path: `${EVIDENCE}/12-wizard-theme.png`, fullPage: true });
  await page.getByTestId('wizard-next').click();

  // Step 4: review + honest notice, then create
  await expect(page.getByTestId('wizard-review')).toContainText('/w/bao-hiem-mau');
  await expect(page.getByTestId('prototype-notice')).toContainText('chưa lưu máy chủ');
  await page.getByTestId('wizard-create').click();
  await expect(page).toHaveURL(`${webUrl}/?created=1`);
  await expect(page.getByTestId('created-alert')).toContainText('Chưa có tenant hay máy chủ nào được tạo');
  await expect(page.getByTestId('dashboard-title')).toHaveText('Bảo hiểm Mẫu Minh Họa');
  await expect(page.getByTestId('active-workspace-name')).toHaveText('Bảo hiểm Mẫu Minh Họa');
  await expect(page.getByTestId('setup-checklist')).toContainText('3/5');
  await expect.poll(() => primaryVar(page)).toBe('#0f766e');
  await expect(page.getByTestId('app-sidebar').getByRole('img', { name: 'Logo Bảo hiểm Mẫu Minh Họa' })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/13-dashboard-branded.png`, fullPage: true });

  // Persisted only in this browser, under one versioned key; survives reload
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).toEqual([STORE_KEY]);
  await page.reload();
  await expect(page.getByTestId('dashboard-title')).toHaveText('Bảo hiểm Mẫu Minh Họa');
  expect(foreign).toEqual([]);
});

test('settings: edit profile, switch to dark theme, and detect a stale version', async () => {
  await page.goto(webUrl);
  await expect(page.getByTestId('dashboard-title')).toBeVisible();
  await page.getByTestId('app-sidebar').getByRole('link', { name: 'Cài đặt tổ chức' }).click();
  await expect(page).toHaveURL(`${webUrl}/to-chuc/cai-dat`);
  await page.getByTestId('ws-name').fill('Bảo hiểm Mẫu Minh Họa Việt Nam');
  await page.getByTestId('save-general').click();
  await expect(page.getByTestId('save-ok')).toBeVisible();
  await expect(page.getByTestId('active-workspace-name')).toHaveText('Bảo hiểm Mẫu Minh Họa Việt Nam');

  await page.getByRole('tab', { name: 'Giao diện' }).click();
  await page.getByTestId('theme-mode-DARK').click();
  await page.getByTestId('save-theme').click();
  await expect(page.getByTestId('save-ok')).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({ path: `${EVIDENCE}/14-settings-dark.png`, fullPage: true });

  // Another tab bumps the version: saving the stale copy must be refused, not overwrite.
  await page.evaluate(key => {
    const s = JSON.parse(localStorage.getItem(key)!);
    s.workspaces[0].version += 1;
    localStorage.setItem(key, JSON.stringify(s));
  }, STORE_KEY);
  await page.getByTestId('theme-mode-LIGHT').click();
  await page.getByTestId('save-theme').click();
  await expect(page.getByTestId('save-error')).toContainText('tab khác');
  await expect(page.locator('html')).toHaveClass(/dark/);

  await page.getByRole('tab', { name: 'Thành viên' }).click();
  await expect(page.getByText('Thành viên & vai trò — chưa khả dụng')).toBeVisible();
});

test('workspace switcher lists organisations; deleting falls back to the welcome screen', async () => {
  await page.goto(webUrl);
  await page.getByTestId('workspace-switcher').click();
  await page.getByTestId('switcher-create').click();
  await expect(page).toHaveURL(`${webUrl}/to-chuc/tao-moi`);
  await page.getByTestId('ws-name').fill('Công ty TPA Thử Nghiệm');
  await page.getByTestId('ws-slug').fill('bao-hiem-mau');
  await page.getByTestId('wizard-next').click();
  await expect(page.locator('#ws-slug-err')).toHaveText('Định danh URL đã được dùng cho tổ chức khác.');
  await page.getByTestId('ws-slug').fill('tpa-thu-nghiem');
  await page.getByTestId('ws-type-TPA_OPERATOR').click();
  for (let i = 0; i < 3; i++) await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-create').click();
  await expect(page.getByTestId('active-workspace-name')).toHaveText('Công ty TPA Thử Nghiệm');
  await expect.poll(() => primaryVar(page)).toBe('#1d4ed8');

  await page.getByTestId('workspace-switcher').click();
  await page.getByRole('menuitem', { name: /Bảo hiểm Mẫu Minh Họa Việt Nam/ }).click();
  await expect(page.getByTestId('active-workspace-name')).toHaveText('Bảo hiểm Mẫu Minh Họa Việt Nam');
  await expect.poll(() => primaryVar(page)).toBe('#0f766e');

  for (const _ of [1, 2]) {
    await page.goto(`${webUrl}/to-chuc/cai-dat`);
    await page.getByRole('tab', { name: 'Nâng cao' }).click();
    await page.getByTestId('delete-workspace').click();
    await page.getByTestId('confirm-delete').click();
  }
  await expect(page.getByTestId('settings-empty')).toBeVisible();
  await page.goto(webUrl);
  await expect(page.getByTestId('welcome')).toBeVisible();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test('tampered browser storage is discarded, never rendered', async ({ page: fresh }) => {
  const page = fresh;
  await page.goto(webUrl);
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({
    schema: 1, activeId: '00000000-0000-4000-8000-000000000001',
    workspaces: [{
      id: '00000000-0000-4000-8000-000000000001', version: 1, createdAt: '2026-11-26T04:00:00.000Z', updatedAt: '2026-11-26T04:00:00.000Z',
      profile: { displayName: '<img src=x onerror=alert(1)>', shortName: 'X', slug: 'xss', orgType: 'INSURER', description: '' },
      theme: { primaryColor: 'red;}*{display:none', radius: 'MD', mode: 'LIGHT', sidebarStyle: 'LIGHT' }, logo: null,
    }],
  })), STORE_KEY);
  const dialogs: string[] = [];
  page.on('dialog', d => { dialogs.push(d.message()); void d.dismiss(); });
  await page.reload();
  await expect(page.getByTestId('welcome')).toBeVisible();
  await expect(page.getByTestId('active-workspace-name')).toHaveText('TPA Workspace');
  expect(await primaryVar(page)).toBe('#1d4ed8');
  expect(dialogs).toEqual([]);
});
