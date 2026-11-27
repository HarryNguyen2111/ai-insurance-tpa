import assert from 'node:assert/strict';
import test from 'node:test';
import { PortError, type WorkspaceMembership, type WorkspacePort } from '../adapters/ports.ts';
import { SyntheticWorkspaceAdapter, parseScenario } from '../adapters/synthetic.ts';
import {
  SYNTHETIC_LOYALTY,
  SYNTHETIC_MEMBERSHIPS,
  SYNTHETIC_PERSONAL_LOYALTY,
  SYNTHETIC_PROFILE,
  SYNTHETIC_THEMES,
  SYNTHETIC_TPA,
  WS,
} from '../fixtures/workspaces.ts';
import { PERSONAL } from './context-ring.ts';
import { ContextSwitcher, type SwitchState } from './context-switcher.ts';

/** Read state without TS narrowing it across awaits. */
const st = (s: ContextSwitcher): SwitchState => s.state;
const ready = (s: ContextSwitcher) => {
  const x = st(s);
  assert.equal(x.phase, 'ready');
  return (x as Extract<SwitchState, { phase: 'ready' }>).active;
};
const failed = (s: ContextSwitcher) => {
  const x = st(s);
  assert.equal(x.phase, 'failed');
  return x as Extract<SwitchState, { phase: 'failed' }>;
};
import { NEUTRAL_THEME } from './theme.ts';

/** Port whose every call waits until the test releases it (in any order) — deterministic races. */
function manualPort(memberships: WorkspaceMembership[]) {
  const calls: { op: string; target: string; resolve: (v?: unknown) => void; reject: (e: unknown) => void }[] = [];
  let list = memberships;
  const hold = <T>(op: string, target: string, value: () => T) =>
    new Promise<T>((resolve, reject) => calls.push({ op, target, resolve: () => resolve(value()), reject }));
  const port: WorkspacePort = {
    listMemberships: async () => ({ profile: SYNTHETIC_PROFILE, memberships: list }),
    selectMembership: (id) => hold('select', id, () => ({ membershipId: id, expiresAt: 'x', contextToken: `t-${id}` })),
    getTheme: (ctx, v) => hold('theme', ctx.membershipId, () => SYNTHETIC_THEMES[`${ctx.membershipId}:${v}`]!),
    getTenantSnapshot: (ctx, services) =>
      hold('data', ctx.membershipId, () => ({
        tpa: services.includes('TPA_INSURANCE') ? SYNTHETIC_TPA[ctx.membershipId] ?? null : null,
        loyalty: services.includes('LOYALTY360') ? SYNTHETIC_LOYALTY[ctx.membershipId] ?? null : null,
      })),
    getPersonalLoyalty: () => hold('personal', PERSONAL, () => SYNTHETIC_PERSONAL_LOYALTY),
  };
  const flush = () => new Promise((r) => setImmediate(r));
  /** Release every pending call for `target`, repeatedly, until none is left. */
  const release = async (target: string) => {
    for (let i = 0; i < 6; i++) {
      await flush();
      const mine = calls.filter((c) => c.target === target);
      if (!mine.length) continue;
      mine.forEach((c) => calls.splice(calls.indexOf(c), 1));
      mine.forEach((c) => c.resolve());
    }
    await flush();
  };
  const fail = async (target: string, code: PortError['code']) => {
    await flush();
    const c = calls.find((x) => x.target === target)!;
    calls.splice(calls.indexOf(c), 1);
    c.reject(new PortError(code));
    await flush();
    await flush();
  };
  return { port, release, fail, setList: (l: WorkspaceMembership[]) => (list = l), calls };
}

const { A, B, C } = SYNTHETIC_MEMBERSHIPS;

async function readyAt(target: string) {
  const m = manualPort([A, B, C]);
  const s = new ContextSwitcher(m.port);
  await s.refreshMemberships();
  const p = s.switchTo(target);
  await m.release(target);
  assert.equal(await p, 'committed');
  return { s, m };
}

test('switch commits membership + theme + data together; label/theme/data are never mixed', async () => {
  const { s, m } = await readyAt(WS.A);
  const phases: string[] = [];
  s.subscribe(() => phases.push(st(s).phase));
  const p = s.switchTo(WS.B);
  assert.equal(st(s).phase, 'switching');
  assert.equal((st(s) as Extract<SwitchState, { phase: 'switching' }>).targetLabel, 'Bình Minh — DNBH mẫu');
  // While switching there is no active context at all: A's data and colour are already gone.
  assert.equal(s.activeId, null);
  await m.release(WS.B);
  assert.equal(await p, 'committed');
  const a = ready(s);
  assert.ok(a.kind === 'TENANT');
  assert.equal(a.membership.membershipId, WS.B);
  assert.equal(a.theme.tokens.brand, '#ecbf3b');
  assert.equal(a.snapshot.tpa?.claims[0]?.claimCode, 'MAU-2026-000611');
  assert.deepEqual(phases, ['switching', 'ready']);
});

test('delayed old response is ignored: B answers after C was chosen → C wins, B dropped', async () => {
  const { s, m } = await readyAt(WS.A);
  const pb = s.switchTo(WS.B);
  const pc = s.switchTo(WS.C);
  await m.release(WS.C);
  assert.equal(await pc, 'committed');
  await m.release(WS.B); // the late B select response finally arrives
  assert.equal(await pb, 'stale');
  assert.equal(s.activeId, WS.C);
  assert.equal(ready(s).theme.tokens.brand, '#6d28d9');
  assert.equal(s.staleDropped, 1);
});

test('rapid double taps are bounded: a quick switch while one is in flight is ignored', async () => {
  const { s, m } = await readyAt(WS.A);
  const first = s.quickSwitch();
  assert.equal(await s.quickSwitch(), 'ignored');
  assert.equal(await s.quickSwitch(), 'ignored');
  await m.release(WS.B);
  assert.equal(await first, 'committed');
  assert.equal(s.activeId, WS.B);
});

test('quick switch walks the stable ring and wraps through personal', async () => {
  const { s, m } = await readyAt(WS.C);
  const p = s.quickSwitch();
  await m.release(PERSONAL);
  assert.equal(await p, 'committed');
  assert.equal(s.activeId, PERSONAL);
  assert.equal(ready(s).kind, 'PERSONAL');
  assert.equal(ready(s).theme, NEUTRAL_THEME);
  const q = s.quickSwitch();
  await m.release(WS.A);
  assert.equal(await q, 'committed');
  assert.equal(s.activeId, WS.A);
});

test('revoked membership: 403 → authoritative refresh removes it; user is NOT moved to another tenant', async () => {
  const { s, m } = await readyAt(WS.A);
  m.setList([A, C]); // server-side revocation of B; client still has the stale list
  assert.ok(s.ring.includes(WS.B));
  const p = s.switchTo(WS.B);
  await m.fail(WS.B, 'FORBIDDEN');
  assert.equal(await p, 'failed');
  assert.equal(failed(s).reason, 'REVOKED');
  assert.equal(s.activeId, null, 'no tenant is active, nothing auto-selected');
  assert.ok(!s.ring.includes(WS.B));
  // Next quick switch continues from the last committed context (A) in the NEW ring.
  const q = s.quickSwitch();
  await m.release(WS.C);
  assert.equal(await q, 'committed');
  assert.equal(s.activeId, WS.C);
});

test('offline/error → failed state with no data; retry is an explicit switch', async () => {
  const { s, m } = await readyAt(WS.A);
  const p = s.switchTo(WS.B);
  await m.fail(WS.B, 'OFFLINE');
  assert.equal(await p, 'failed');
  assert.equal(failed(s).reason, 'OFFLINE');
  assert.equal(failed(s).from, WS.A);
  const r = s.switchTo(WS.B);
  await m.release(WS.B);
  assert.equal(await r, 'committed');
});

test('theme cache is keyed by membership + branding version; a branding update is fetched, old entry evicted', async () => {
  const adapter = new SyntheticWorkspaceAdapter({ ...parseScenario(''), latencyMs: 0 });
  const s = new ContextSwitcher(adapter);
  await s.init(WS.A);
  assert.deepEqual(s.themeCacheKeys(), [`theme:${WS.A}:v3`]);
  await s.switchTo(WS.B);
  adapter.controls.brandingBumped.add(WS.A);
  await s.refreshMemberships();
  assert.ok(!s.themeCacheKeys().includes(`theme:${WS.A}:v3`), 'stale version evicted');
  await s.switchTo(WS.A);
  assert.equal(ready(s).theme.tokens.brand, '#b91c1c');
  assert.ok(s.themeCacheKeys().includes(`theme:${WS.A}:v4`));
  for (const k of s.themeCacheKeys()) assert.match(k, /^theme:[0-9a-f-]{36}:v\d+$/, 'no PII in cache keys');
});

test('invalid theme payload → neutral theme for that tenant (never the previous tenant colour)', async () => {
  const adapter = new SyntheticWorkspaceAdapter({ ...parseScenario('?badtheme=CT'), latencyMs: 0 });
  const s = new ContextSwitcher(adapter);
  await s.init(WS.B);
  await s.switchTo(WS.C);
  const c = ready(s);
  assert.ok(c.kind === 'TENANT');
  assert.equal(c.theme, NEUTRAL_THEME);
  assert.equal(c.themeFallback, true);
});

test('active tenant revoked on refresh → leaves the tenant explicitly (failed REVOKED), data cleared', async () => {
  const adapter = new SyntheticWorkspaceAdapter({ ...parseScenario(''), latencyMs: 0 });
  const s = new ContextSwitcher(adapter);
  await s.init(WS.A);
  adapter.controls.revoked.add(WS.A);
  await s.refreshMemberships();
  assert.equal(failed(s).reason, 'REVOKED');
  assert.equal(s.activeId, null);
});

test('capability filtering: C has no TPA → snapshot.tpa null; personal context has no tenant data', async () => {
  const adapter = new SyntheticWorkspaceAdapter({ ...parseScenario(''), latencyMs: 0 });
  const s = new ContextSwitcher(adapter);
  await s.init(WS.C);
  const c = ready(s);
  assert.ok(c.kind === 'TENANT');
  assert.equal(c.snapshot.tpa, null);
  assert.ok(c.snapshot.loyalty);
  await s.switchTo(PERSONAL);
  const p = ready(s);
  assert.equal(p.kind, 'PERSONAL');
  assert.ok(!('snapshot' in p));
});

test('0/1 memberships and unknown preference start in personal Loyalty360', async () => {
  for (const q of ['?members=0', '?members=1&start=BM', '?start=PERSONAL']) {
    const s = new ContextSwitcher(new SyntheticWorkspaceAdapter({ ...parseScenario(q), latencyMs: 0 }));
    const sc = parseScenario(q);
    await s.init(sc.start);
    assert.equal(s.activeId, PERSONAL, q);
  }
});

test('personal loyalty payload holds no insurance/health/claim fields', () => {
  const blob = JSON.stringify([SYNTHETIC_PERSONAL_LOYALTY, SYNTHETIC_LOYALTY]).toLowerCase();
  for (const w of ['claim', 'eob', 'bệnh', 'thuốc', 'bồi thường', 'policy', 'cccd', 'bank', 'tài khoản']) {
    assert.ok(!blob.includes(w), w);
  }
});
