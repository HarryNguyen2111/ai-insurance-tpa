import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type pg from 'pg';
import { appendOutboxEvent } from '../../src/outbox.ts';
import type { TenantDatabase, TenantTransaction } from '../../src/tenant.ts';

// PAY-01 (#44) / PT14 scenarios: balanced immutable journal, protected float balances,
// ledger/audit/outbox atomicity, reversal-only corrections and reconciliation source.
// Run by ledger.integration.test.ts on actual PostgreSQL 16 through tpa_app + SET LOCAL.
// Synthetic funds only (no PII, no real bank, no payout).
type Side = 'DEBIT' | 'CREDIT';
const MONEY = /^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
const code = (expected: string) => (e: unknown) => e instanceof Error && 'code' in e && e.code === expected;
const cents = (money: string) => BigInt(money.replace('.', ''));
const money = (c: bigint) => { const s = c.toString().padStart(3, '0'); return `${s.slice(0, -2)}.${s.slice(-2)}`; };
const randomMoney = (maxInt: number) => `${randomInt(1, maxInt)}.${String(randomInt(0, 100)).padStart(2, '0')}`;

export async function ledgerScenarios(t: TestContext, ctx: { db: TenantDatabase; owner: pg.Client }): Promise<void> {
  const { db, owner } = ctx;
  // Dynamic file URL runs the actual core module without adding a package dependency.
  const ledger = await import(new URL('../../../../apps/core-api/src/ledger/ledger.ts', import.meta.url).href);
  const outbox = (tx: TenantTransaction, draft: Parameters<typeof appendOutboxEvent>[1]) => appendOutboxEvent(tx, draft);
  const service = new ledger.LedgerService(db, outbox);
  const actor = { type: 'SERVICE', id: randomUUID() };
  const trace = () => ({ correlationId: randomUUID(), causationId: randomUUID() });
  const key = () => `pay01:${randomUUID()}`;
  const rows = (tenant: string, sql: string, values: unknown[] = []) =>
    db.withTenantTransaction(tenant, async tx => (await tx.query(sql, values)).rows);

  interface Book { tenant: string; float: string; bank: string; clearing: string }
  const setup = async (fund?: string, tenant: string = randomUUID()): Promise<Book> => {
    const open = (purpose: string) => service.openAccount(tenant, actor, { purpose, currency: 'VND', trace: trace() });
    const [float, bank, clearing] = await Promise.all([open('INSURER_FLOAT'), open('SETTLEMENT_BANK'), open('PAYOUT_CLEARING')]);
    const book = { tenant, float: float.accountId, bank: bank.accountId, clearing: clearing.accountId };
    if (fund) assert.equal((await topup(book, fund)).kind, 'POSTED');
    return book;
  };
  const lines = (debit: string, credit: string, amount: string) =>
    [{ accountId: debit, side: 'DEBIT' as Side, amount }, { accountId: credit, side: 'CREDIT' as Side, amount }];
  const topup = (b: Book, amount: string, k = key()) =>
    service.post(b.tenant, actor, { idempotencyKey: k, entryType: 'FLOAT_TOPUP', trace: trace(), lines: lines(b.bank, b.float, amount) });
  const commit = (b: Book, amount: string, k = key()) =>
    service.post(b.tenant, actor, { idempotencyKey: k, entryType: 'PAYOUT_COMMIT', paymentId: randomUUID(), trace: trace(), lines: lines(b.float, b.clearing, amount) });
  const settle = (b: Book, amount: string, k = key()) =>
    service.post(b.tenant, actor, { idempotencyKey: k, entryType: 'PAYOUT_SETTLE', trace: trace(), lines: lines(b.clearing, b.bank, amount) });
  const reverse = (b: Book, entryId: string, k = key()) =>
    service.reverse(b.tenant, actor, { idempotencyKey: k, entryId, reasonCode: 'SYNTHETIC_CORRECTION', trace: trace() });
  const balance = async (b: Book, accountId: string) => (await service.getAccount(b.tenant, accountId)).balance as string;

  /** Raw tpa_app entry (bypasses service validation and locks); the database must still enforce PT14. */
  const rawEntry = async (tx: TenantTransaction, entry: { id?: string; type?: string; reverses?: string },
    raw: [string, Side, string][]) => {
    const id = entry.id ?? randomUUID();
    await tx.query(`INSERT INTO tpa.journal_entries (tenant_id,id,entry_type,reverses_entry_id,reason_code,idempotency_key,request_hash,posted_by_type,posted_by_id)
      VALUES (tpa.current_tenant_id(),$1,$2,$3,$4,$5,repeat('a',64),'SERVICE',$6)`,
    [id, entry.type ?? 'FLOAT_TOPUP', entry.reverses ?? null, entry.reverses ? 'SYNTHETIC_CORRECTION' : null, key(), actor.id]);
    for (const [i, [account, side, amount]] of raw.entries()) {
      await tx.query(`INSERT INTO tpa.journal_lines (tenant_id,entry_id,line_no,account_id,currency,side,amount,balance_after,account_version)
        SELECT tpa.current_tenant_id(),$1,$2,a.id,a.currency,$4,$5::numeric,0,0 FROM tpa.ledger_accounts a WHERE a.id=$3`, [id, i + 1, account, side, amount]);
    }
    return id;
  };

  /** Reconciliation + one audit per account change + contiguous per-account outbox versions. */
  const consistent = async (tenant: string, viaServiceOnly = true) => {
    const report = await service.reconcile(tenant);
    assert.equal(report.consistent, true, 'ledger reconciles with posted journal lines');
    assert.equal(report.unbalancedEntries, 0);
    for (const a of report.accounts) {
      assert.equal(a.matches, true); assert.equal(a.balance, a.journalBalance);
      for (const m of [a.balance, a.debitTotal, a.creditTotal, a.journalBalance]) assert.match(m, MONEY);
      if (!viaServiceOnly) continue; // raw-SQL postings carry no service audit/outbox rows
      const [x] = await rows(tenant, `SELECT (SELECT count(*)::int FROM tpa.audit_logs l WHERE l.entity_type='LEDGER_ACCOUNT' AND l.entity_id=$1) AS audits,
          (SELECT array_agg(o.aggregate_version ORDER BY o.aggregate_version) FROM tpa.outbox_events o WHERE o.aggregate_id=$1) AS versions`, [a.accountId]);
      assert.equal(x.audits, a.version, 'one audit per account version');
      assert.deepEqual(x.versions, Array.from({ length: a.version }, (_, i) => i + 1), 'one outbox event per account version');
    }
    return report;
  };

  await t.test('accounts open idempotently at zero; post/replay/conflict; reconciliation, audit and outbox', async () => {
    const b = await setup();
    const again = await service.openAccount(b.tenant, actor, { purpose: 'INSURER_FLOAT', currency: 'VND', trace: trace() });
    assert.equal(again.accountId, b.float); assert.equal(again.balance, '0.00'); assert.equal(again.normalSide, 'CREDIT');
    assert.equal((await service.getAccount(b.tenant, b.bank)).normalSide, 'DEBIT');
    const k = key();
    const posted = await topup(b, '1000000.00', k);
    assert.equal(posted.kind, 'POSTED'); assert.equal(posted.replayed, false);
    assert.deepEqual(posted.entry.lines.map((l: { side: string; amount: string; balanceAfter: string; accountVersion: number }) =>
      [l.side, l.amount, l.balanceAfter, l.accountVersion]).sort(),
    [['CREDIT', '1000000.00', '1000000.00', 2], ['DEBIT', '1000000.00', '1000000.00', 2]]);
    const replays = await Promise.all(Array.from({ length: 8 }, () => topup(b, '1000000.00', k)));
    assert.ok(replays.every(r => r.kind === 'POSTED' && r.replayed && r.entry.entryId === posted.entry.entryId));
    await assert.rejects(topup(b, '1000000.01', k), ledger.LedgerIdempotencyConflict);
    await assert.rejects(commit(b, '1000000.00', k), ledger.LedgerIdempotencyConflict);
    assert.equal(await balance(b, b.float), '1000000.00'); assert.equal(await balance(b, b.bank), '1000000.00');
    const [count] = await rows(b.tenant, 'SELECT count(*)::int AS n FROM tpa.journal_entries');
    assert.equal(count.n, 1);
    const [audit] = await rows(b.tenant, "SELECT count(*)::int AS n FROM tpa.audit_logs WHERE entity_type='JOURNAL_ENTRY' AND entity_id=$1 AND action='JOURNAL_POSTED'", [posted.entry.entryId]);
    assert.equal(audit.n, 1);
    const [event] = await rows(b.tenant, `SELECT envelope FROM tpa.outbox_events WHERE aggregate_id=$1 AND aggregate_version=2`, [b.float]);
    assert.deepEqual(event.envelope.payload, { changeKind: 'JOURNAL_POSTED', entryId: posted.entry.entryId, entryType: 'FLOAT_TOPUP' });
    assert.ok(!JSON.stringify(event.envelope).includes('1000000'), 'outbox carries no amounts');
    const report = await consistent(b.tenant);
    assert.deepEqual(report.currencies, [{ currency: 'VND', debitTotal: '1000000.00', creditTotal: '1000000.00', balanced: true }]);
  });

  await t.test('PT14: unbalanced, one-line, empty and cross-currency entries fail the whole transaction', async () => {
    const b = await setup('500000.00');
    await assert.rejects(service.post(b.tenant, actor, { idempotencyKey: key(), entryType: 'FLOAT_TOPUP', trace: trace(),
      lines: [{ accountId: b.bank, side: 'DEBIT', amount: '10.00' }, { accountId: b.float, side: 'CREDIT', amount: '9.99' }] }), ledger.LedgerInputError);
    const attempts: [string, (tx: TenantTransaction) => Promise<unknown>][] = [
      ['Dr 10.00 / Cr 9.99', tx => rawEntry(tx, {}, [[b.bank, 'DEBIT', '10.00'], [b.float, 'CREDIT', '9.99']])],
      ['single line', tx => rawEntry(tx, {}, [[b.bank, 'DEBIT', '10.00']])],
      ['no lines', tx => rawEntry(tx, {}, [])],
      ['immediate constraints', async tx => { await tx.query('SET CONSTRAINTS ALL IMMEDIATE'); return rawEntry(tx, {}, [[b.bank, 'DEBIT', '1.00'], [b.float, 'CREDIT', '1.00']]); }],
    ];
    for (const [label, attempt] of attempts) await assert.rejects(db.withTenantTransaction(b.tenant, attempt), code('23514'), label);
    // Per-currency: a VND debit cannot be balanced by a USD credit.
    const usdBank = randomUUID(), usdFloat = randomUUID();
    await rows(b.tenant, `INSERT INTO tpa.ledger_accounts (tenant_id,id,purpose,currency,normal_side) VALUES
      (tpa.current_tenant_id(),$1,'SETTLEMENT_BANK','USD','DEBIT'),(tpa.current_tenant_id(),$2,'INSURER_FLOAT','USD','CREDIT')`, [usdBank, usdFloat]);
    await assert.rejects(db.withTenantTransaction(b.tenant, tx => rawEntry(tx, {}, [[b.bank, 'DEBIT', '100.00'], [usdFloat, 'CREDIT', '100.00']])), code('23514'));
    // Balanced in each currency commits.
    await db.withTenantTransaction(b.tenant, tx => rawEntry(tx, {}, [[b.bank, 'DEBIT', '100.00'], [b.float, 'CREDIT', '100.00'], [usdBank, 'DEBIT', '5.00'], [usdFloat, 'CREDIT', '5.00']]));
    // A line currency must match its account (composite FK).
    await assert.rejects(db.withTenantTransaction(b.tenant, async tx => {
      const id = await rawEntry(tx, {}, [[b.bank, 'DEBIT', '1.00'], [b.float, 'CREDIT', '1.00']]);
      await tx.query(`INSERT INTO tpa.journal_lines (tenant_id,entry_id,line_no,account_id,currency,side,amount,balance_after,account_version)
        VALUES (tpa.current_tenant_id(),$1,3,$2,'USD','DEBIT',1.00,0,0)`, [id, b.bank]);
    }), code('23503'));
    const after = await consistent(b.tenant, false);
    assert.equal(after.accounts.find((a: { accountId: string }) => a.accountId === b.float)!.balance, '500100.00');
    assert.deepEqual(after.currencies.map((c: { currency: string; balanced: boolean }) => [c.currency, c.balanced]), [['USD', true], ['VND', true]]);
    assert.equal((await rows(b.tenant, 'SELECT count(*)::int AS n FROM tpa.journal_entries'))[0].n, 2);
  });

  await t.test('PT14: posted entries, lines and balances cannot be edited, deleted or truncated (app and owner)', async () => {
    const b = await setup('300000.00');
    const posted = await commit(b, '100000.00');
    const snapshot = await service.getEntry(b.tenant, posted.entry.entryId);
    const edits = [
      'UPDATE tpa.journal_lines SET amount = amount + 1', 'DELETE FROM tpa.journal_lines', "UPDATE tpa.journal_entries SET reason_code='X'",
      'DELETE FROM tpa.journal_entries', 'TRUNCATE tpa.journal_lines', 'TRUNCATE tpa.journal_entries', 'TRUNCATE tpa.ledger_accounts',
      'UPDATE tpa.ledger_accounts SET balance = balance + 1000000', 'UPDATE tpa.ledger_accounts SET version = version + 1',
      'DELETE FROM tpa.ledger_accounts',
    ];
    for (const sql of edits) await assert.rejects(rows(b.tenant, sql), code('42501'), `tpa_app: ${sql}`);
    // Adding a line to an already committed entry is an edit, too.
    await assert.rejects(db.withTenantTransaction(b.tenant, tx => tx.query(`INSERT INTO tpa.journal_lines
      (tenant_id,entry_id,line_no,account_id,currency,side,amount,balance_after,account_version)
      VALUES (tpa.current_tenant_id(),$1,3,$2,'VND','CREDIT',1.00,0,0)`, [posted.entry.entryId, b.float])), code('42501'));
    // The migration owner holds table privileges, but the triggers still block every change.
    // (TRUNCATE of FK-referenced tables is refused by PostgreSQL before triggers; journal_lines covers the trigger path.)
    for (const sql of edits.filter(s => s !== 'TRUNCATE tpa.ledger_accounts' && s !== 'TRUNCATE tpa.journal_entries')) {
      await owner.query('BEGIN');
      try {
        await owner.query("SELECT set_config('app.current_tenant_id',$1,true)", [b.tenant]);
        await assert.rejects(owner.query(sql), code('42501'), `owner: ${sql}`);
      } finally { await owner.query('ROLLBACK'); }
    }
    assert.deepEqual(await service.getEntry(b.tenant, posted.entry.entryId), snapshot);
    await consistent(b.tenant);
  });

  await t.test('PT14: corrections only by mirrored reversal; one reversal per entry; reversal not reversible', async () => {
    const b = await setup('1000000.00');
    const payout = await commit(b, '300000.00');
    const original = await service.getEntry(b.tenant, payout.entry.entryId);
    assert.equal(await balance(b, b.float), '700000.00');
    // Hand-made reversals that do not mirror exactly fail at commit.
    await assert.rejects(db.withTenantTransaction(b.tenant, tx => rawEntry(tx, { type: 'REVERSAL', reverses: payout.entry.entryId },
      [[b.clearing, 'DEBIT', '200000.00'], [b.float, 'CREDIT', '200000.00']])), code('23514'));
    await assert.rejects(db.withTenantTransaction(b.tenant, tx => rawEntry(tx, { type: 'REVERSAL', reverses: payout.entry.entryId },
      [[b.clearing, 'DEBIT', '300000.00'], [b.bank, 'CREDIT', '300000.00']])), code('23514'));
    const keys = [key(), key(), key()];
    const concurrent = await Promise.allSettled(keys.map(k => reverse(b, payout.entry.entryId, k)));
    const winner = concurrent.findIndex(r => r.status === 'fulfilled');
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1, 'exactly one concurrent reversal wins');
    for (const r of concurrent) if (r.status === 'rejected') assert.ok(r.reason instanceof ledger.LedgerStateError && r.reason.code === 'ALREADY_REVERSED');
    const reversal = (concurrent[winner] as PromiseFulfilledResult<{ kind: string; entry: { entryId: string; entryType: string; reversesEntryId: string; lines: { accountId: string; side: string; amount: string }[] } }>).value;
    assert.equal(reversal.kind, 'POSTED'); assert.equal(reversal.entry.entryType, 'REVERSAL');
    assert.equal(reversal.entry.reversesEntryId, payout.entry.entryId);
    const flip = (s: string) => (s === 'DEBIT' ? 'CREDIT' : 'DEBIT');
    assert.deepEqual(reversal.entry.lines.map(l => [l.accountId, l.side, l.amount]).sort(),
      original.lines.map((l: { accountId: string; side: string; amount: string }) => [l.accountId, flip(l.side), l.amount]).sort());
    assert.equal(await balance(b, b.float), '1000000.00'); assert.equal(await balance(b, b.clearing), '0.00');
    const replay = await reverse(b, payout.entry.entryId, keys[winner]);
    assert.equal(replay.replayed, true); assert.equal(replay.entry.entryId, reversal.entry.entryId);
    await assert.rejects(reverse(b, reversal.entry.entryId), (e: Error) => e instanceof ledger.LedgerStateError && /NOT_REVERSIBLE/.test(e.message));
    await assert.rejects(reverse(b, randomUUID()), ledger.LedgerNotFound);
    assert.deepEqual(await service.getEntry(b.tenant, payout.entry.entryId), original, 'original entry unchanged');
    // Audit chain: the original carries JOURNAL_POSTED then JOURNAL_REVERSED, hash-linked.
    const chain = await rows(b.tenant, `SELECT action, prev_hash, curr_hash FROM tpa.audit_logs WHERE entity_type='JOURNAL_ENTRY' AND entity_id=$1 ORDER BY sequence`, [payout.entry.entryId]);
    assert.deepEqual(chain.map(c => c.action), ['JOURNAL_POSTED', 'JOURNAL_REVERSED']);
    assert.equal(chain[1].prev_hash, chain[0].curr_hash);
    // Reversing a top-up whose funds were already committed would overdraw: refused, nothing posted.
    const b2 = await setup();
    const fund = await topup(b2, '500000.00');
    assert.equal((await commit(b2, '400000.00')).kind, 'POSTED');
    const refused = await reverse(b2, fund.entry.entryId);
    assert.equal(refused.kind, 'INSUFFICIENT_FUNDS');
    assert.deepEqual(refused.shortfalls.map((s: { purpose: string; availableBalance: string; requestedAmount: string }) => [s.purpose, s.availableBalance, s.requestedAmount]),
      [['INSURER_FLOAT', '100000.00', '500000.00']]);
    await consistent(b.tenant); await consistent(b2.tenant);
  });

  await t.test('PT14 race: two concurrent 800000.00 payouts against 1000000.00 never overdraw (20 rounds)', async () => {
    for (let round = 0; round < 20; round++) {
      const b = await setup('1000000.00');
      const results = await Promise.all([commit(b, '800000.00'), commit(b, '800000.00')]);
      assert.deepEqual(results.map(r => r.kind).sort(), ['INSUFFICIENT_FUNDS', 'POSTED']);
      const denied = results.find(r => r.kind === 'INSUFFICIENT_FUNDS');
      assert.deepEqual(denied.shortfalls, [{ accountId: b.float, purpose: 'INSURER_FLOAT', currency: 'VND', availableBalance: '200000.00', requestedAmount: '800000.00' }]);
      assert.equal(await balance(b, b.float), '200000.00');
      await consistent(b.tenant);
    }
  });

  await t.test('PT14 race without service locks: raw concurrent overdraw is blocked by the row lock + CHECK (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const b = await setup('1000000.00');
      let release!: () => void; const gate = new Promise<void>(r => { release = r; });
      let firstWritten!: () => void; const written = new Promise<void>(r => { firstWritten = r; });
      const first = db.withTenantTransaction(b.tenant, async tx => {
        await rawEntry(tx, { type: 'PAYOUT_COMMIT' }, [[b.clearing, 'CREDIT', '800000.00'], [b.float, 'DEBIT', '800000.00']]);
        firstWritten(); await gate; // hold the float row lock until the competitor is blocked on it
      });
      await written;
      const second = db.withTenantTransaction(b.tenant, tx =>
        rawEntry(tx, { type: 'PAYOUT_COMMIT' }, [[b.clearing, 'CREDIT', '800000.00'], [b.float, 'DEBIT', '800000.00']]));
      const settled = Promise.allSettled([first, second]);
      let blocked = false;
      for (let i = 0; i < 500 && !blocked; i++) {
        const [w] = await rows(b.tenant, "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = current_user AND wait_event_type = 'Lock'");
        blocked = w.n > 0;
        if (!blocked) await delay(10);
      }
      release();
      assert.ok(blocked, 'competitor was waiting on the account row lock (true overlap)');
      const [a, c] = await settled;
      assert.equal(a.status, 'fulfilled');
      assert.equal(c.status, 'rejected'); assert.ok(code('23514')((c as PromiseRejectedResult).reason), 'overdraw rejected by CHECK');
      assert.equal(await balance(b, b.float), '200000.00');
      assert.equal((await service.reconcile(b.tenant)).consistent, true);
    }
  });

  await t.test('PT14 storm: 40 concurrent payouts + 10 top-ups; float never negative, totals exact, ledger reconciles', async () => {
    const b = await setup('1000000.00');
    const payouts = Array.from({ length: 40 }, () => randomMoney(150000)), topups = Array.from({ length: 10 }, () => randomMoney(50000));
    const results = await Promise.all([...payouts.map(a => commit(b, a)), ...topups.map(a => topup(b, a))]);
    assert.ok(results.slice(40).every(r => r.kind === 'POSTED'));
    const granted = payouts.filter((_, i) => results[i].kind === 'POSTED');
    assert.ok(granted.length > 0);
    const expected = money(cents('1000000.00') + topups.reduce((s, a) => s + cents(a), 0n) - granted.reduce((s, a) => s + cents(a), 0n));
    assert.equal(await balance(b, b.float), expected);
    assert.equal(await balance(b, b.clearing), money(granted.reduce((s, a) => s + cents(a), 0n)));
    for (const [i, r] of results.slice(0, 40).entries()) {
      if (r.kind === 'INSUFFICIENT_FUNDS') assert.ok(cents(payouts[i]) > cents(r.shortfalls[0].availableBalance), 'denied only when it would overdraw');
    }
    const [floor] = await rows(b.tenant, 'SELECT min(balance_after)::text AS low FROM tpa.journal_lines WHERE account_id=$1', [b.float]);
    assert.ok(cents(floor.low) >= 0n, 'no intermediate negative balance');
    await consistent(b.tenant);
  });

  await t.test('property: 80 random operations match an exact cents oracle and always reconcile', async () => {
    const b = await setup();
    const oracle = new Map<string, bigint>([[b.float, 0n], [b.bank, 0n], [b.clearing, 0n]]);
    const normal: Record<string, Side> = { [b.float]: 'CREDIT', [b.bank]: 'DEBIT', [b.clearing]: 'CREDIT' };
    const reversible: { entryId: string; lines: [string, Side, string][] }[] = [];
    const apply = (ls: [string, Side, string][]) => { for (const [a, s, m] of ls) oracle.set(a, oracle.get(a)! + (s === normal[a] ? cents(m) : -cents(m))); };
    const fits = (ls: [string, Side, string][]) => ls.every(([a, s, m]) => s === normal[a] || oracle.get(a)! - cents(m) >= 0n);
    for (let i = 0; i < 80; i++) {
      const op = randomInt(0, 4), amount = randomMoney(400000);
      let planned: [string, Side, string][]; let run: () => Promise<{ kind: string; entry?: { entryId: string } }>;
      let target: { entryId: string; lines: [string, Side, string][] } | undefined;
      if (op === 3 && reversible.length) {
        target = reversible.splice(randomInt(0, reversible.length), 1)[0];
        const original = target;
        planned = original.lines.map(([a, s, m]) => [a, s === 'DEBIT' ? 'CREDIT' : 'DEBIT', m]);
        run = () => reverse(b, original.entryId);
      } else {
        const [d, c] = op === 0 || op === 3 ? [b.bank, b.float] : op === 1 ? [b.float, b.clearing] : [b.clearing, b.bank];
        planned = [[d, 'DEBIT', amount], [c, 'CREDIT', amount]];
        run = () => service.post(b.tenant, actor, { idempotencyKey: key(), entryType: op === 1 ? 'PAYOUT_COMMIT' : op === 2 ? 'PAYOUT_SETTLE' : 'FLOAT_TOPUP', trace: trace(),
          lines: planned.map(([accountId, side, m]) => ({ accountId, side, amount: m })) });
      }
      const expectPosted = fits(planned);
      const result = await run();
      assert.equal(result.kind, expectPosted ? 'POSTED' : 'INSUFFICIENT_FUNDS', `op ${i}`);
      if (expectPosted) {
        apply(planned);
        if (!target) reversible.push({ entryId: result.entry!.entryId, lines: planned });
      } else if (target) reversible.push(target); // still reversible later
      if (i % 20 === 19) await consistent(b.tenant);
    }
    for (const [account, expected] of oracle) assert.equal(await balance(b, account), money(expected));
    await consistent(b.tenant);
  });

  await t.test('atomicity: an outbox failure rolls back journal, balances and audit together', async () => {
    const b = await setup('600000.00');
    const [audits] = await rows(b.tenant, 'SELECT count(*)::int AS n FROM tpa.audit_logs');
    for (const failAt of [1, 2]) {
      let calls = 0;
      const failing = new ledger.LedgerService(db, async (tx: TenantTransaction, draft: Parameters<typeof appendOutboxEvent>[1]) => {
        if (++calls === failAt) throw new Error('synthetic outbox failure');
        return appendOutboxEvent(tx, draft);
      });
      const input = { idempotencyKey: key(), entryType: 'PAYOUT_COMMIT', paymentId: randomUUID(), lines: lines(b.float, b.clearing, '250000.00') };
      await assert.rejects(failing.post(b.tenant, actor, { ...input, trace: trace() }), /synthetic outbox failure/);
      assert.equal((await rows(b.tenant, 'SELECT count(*)::int AS n FROM tpa.journal_entries WHERE idempotency_key=$1', [input.idempotencyKey]))[0].n, 0);
      assert.equal(await balance(b, b.clearing), failAt === 1 ? '0.00' : '250000.00', 'rolled back balance');
      // The key was not consumed: the retry posts once, then replays.
      assert.equal((await service.post(b.tenant, actor, { ...input, trace: trace() })).replayed, false);
      assert.equal((await service.post(b.tenant, actor, { ...input, trace: trace() })).replayed, true);
    }
    assert.equal(await balance(b, b.float), '100000.00');
    const [after] = await rows(b.tenant, 'SELECT count(*)::int AS n FROM tpa.audit_logs');
    assert.equal(after.n, audits.n + 2 * 3, 'only the two successful posts were audited (2 accounts + 1 entry each)');
    await consistent(b.tenant);
  });

  await t.test('tenant isolation: another tenant cannot read, post to, reverse or reference the ledger', async () => {
    const a = await setup('100000.00'), other = await setup('100000.00');
    const payout = await commit(a, '1000.00');
    await assert.rejects(service.getAccount(other.tenant, a.float), ledger.LedgerNotFound);
    await assert.rejects(service.getEntry(other.tenant, payout.entry.entryId), ledger.LedgerNotFound);
    await assert.rejects(commit({ ...other, float: a.float }, '1.00'), ledger.LedgerNotFound);
    await assert.rejects(reverse(other, payout.entry.entryId), ledger.LedgerNotFound);
    // Composite (tenant_id, account_id, currency) FK: a line cannot reference another tenant's account.
    await assert.rejects(db.withTenantTransaction(other.tenant, async tx => {
      const id = await rawEntry(tx, {}, [[other.bank, 'DEBIT', '1.00']]);
      await tx.query(`INSERT INTO tpa.journal_lines (tenant_id,entry_id,line_no,account_id,currency,side,amount,balance_after,account_version)
        VALUES (tpa.current_tenant_id(),$1,2,$2,'VND','CREDIT',1.00,0,0)`, [id, a.float]);
    }), code('23503'));
    const ids = (await service.reconcile(other.tenant)).accounts.map((x: { accountId: string }) => x.accountId).sort();
    assert.deepEqual(ids, [other.float, other.bank, other.clearing].sort());
    assert.equal((await rows(other.tenant, 'SELECT count(*)::int AS n FROM tpa.journal_lines WHERE account_id=$1', [a.float]))[0].n, 0);
    await consistent(a.tenant); await consistent(other.tenant);
  });
}
