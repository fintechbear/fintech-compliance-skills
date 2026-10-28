// FCS transfer reference — scenario suite against a REAL PostgreSQL (no mocks).
// Mirrors the .NET harness's invariants so the two references prove the same contract.
import pg from 'pg';
const { Pool } = pg;
import { initSchema, seedAccount, seedGrant, transfer, balance, count, Faults } from './bank.ts';

const PGCONN = process.env.PGCONN ?? 'postgresql://fcs:fcs@127.0.0.1:55432/fcs';
const pool = new Pool({ connectionString: PGCONN, max: 16 });

// R02: a transfer now requires an authenticated actor who holds a debit grant on the source.
// ACTOR holds grants seeded by fresh(); OUTSIDER never does.
const ACTOR = 'actor-1';
const OUTSIDER = 'actor-outsider';

let pass = 0, fail = 0;
const failures: string[] = [];
async function check(name: string, body: () => Promise<boolean>) {
  try {
    if (await body()) { pass++; console.log(`ok   - ${name}`); }
    else { fail++; failures.push(name); console.log(`FAIL - ${name}`); }
  } catch (e: any) { fail++; failures.push(`${name}: ${e.message}`); console.log(`FAIL - ${name} :: ${e.message}`); }
}

// unique idempotency key per call where we don't care about replay
let seq = 0;
const k = () => `k${seq++}`;

async function fresh(tenant = 'T1', currency = 'USD', a = 10_00, b = 0) {
  await initSchema(pool);
  await seedAccount(pool, tenant, 'A', currency, a);
  await seedAccount(pool, tenant, 'B', currency, b);
  await seedGrant(pool, tenant, 'A', ACTOR, true); // ACTOR may debit the source account
  await seedGrant(pool, tenant, 'B', ACTOR, true);
}

async function main() {
  // --- FCS-MONEY-001 ---
  await fresh();
  await check('money: zero rejected', async () => (await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '0', currency: 'USD' })).outcome === 'bad_amount');
  await check('money: negative rejected', async () => (await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '-1', currency: 'USD' })).outcome === 'bad_amount');
  await check('money: over-precision rejected (USD 1.005)', async () => (await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '1.005', currency: 'USD' })).outcome === 'over_precision');
  await check('money: unsupported currency rejected (XTS)', async () => (await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '1.00', currency: 'XTS' })).outcome === 'unsupported_currency');
  await check('money: overflow rejected (not wraps)', async () => (await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '99999999999999999', currency: 'USD' })).outcome === 'overflow');
  await check('money: JPY with decimals rejected (1.5 JPY)', async () => {
    await initSchema(pool); await seedAccount(pool, 'T1', 'A', 'JPY', 1000); await seedAccount(pool, 'T1', 'B', 'JPY', 0); await seedGrant(pool, 'T1', 'A', ACTOR, true); await seedGrant(pool, 'T1', 'B', ACTOR, true);
    return (await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '1.5', currency: 'JPY' })).outcome === 'over_precision';
  });
  await check('money: JPY 0-decimal posts; KWD 3-decimal posts', async () => {
    await initSchema(pool); await seedAccount(pool, 'T1', 'A', 'JPY', 1000); await seedAccount(pool, 'T1', 'B', 'JPY', 0); await seedGrant(pool, 'T1', 'A', ACTOR, true); await seedGrant(pool, 'T1', 'B', ACTOR, true);
    const jpy = await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '5', currency: 'JPY' });
    await initSchema(pool); await seedAccount(pool, 'T1', 'A', 'KWD', 5000); await seedAccount(pool, 'T1', 'B', 'KWD', 0); await seedGrant(pool, 'T1', 'A', ACTOR, true); await seedGrant(pool, 'T1', 'B', ACTOR, true);
    const kwd = await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '1.250', currency: 'KWD' });
    return jpy.outcome === 'posted' && kwd.outcome === 'posted' && (await balance(pool, 'T1', 'B')) === 1250;
  });

  // --- FCS-AUTHZ-001 ---
  await fresh();
  await check('currency mismatch rejected', async () => {
    await initSchema(pool); await seedAccount(pool, 'T1', 'A', 'USD', 10_00); await seedAccount(pool, 'T1', 'B', 'EUR', 0); await seedGrant(pool, 'T1', 'A', ACTOR, true); await seedGrant(pool, 'T1', 'B', ACTOR, true);
    return (await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '1.00', currency: 'USD' })).outcome === 'currency_mismatch';
  });
  await check('tenant isolation: T2 cannot name a T1 account', async () => {
    await fresh();
    return (await transfer(pool, 'T2', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '1.00', currency: 'USD' })).outcome === 'not_found_in_tenant';
  });

  // --- R02: OBJECT-LEVEL AUTHORIZATION (actor + source-account grant), two stacks prove one contract ---
  await check('R02: an actor WITH a debit grant on the source can post', async () => {
    await fresh(); // ACTOR granted on A
    return (await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '1.00', currency: 'USD' })).outcome === 'posted';
  });
  await check('R02: an actor in the SAME tenant WITHOUT a grant on the source is forbidden (tenant membership is not authorization)', async () => {
    await fresh(); // OUTSIDER has no grant on A, but is a legitimate tenant principal
    const r = await transfer(pool, 'T1', OUTSIDER, 'xfer', k(), { src: 'A', dst: 'B', amount: '1.00', currency: 'USD' });
    // forbidden AND no money moved, no audit/idempotency written
    const audit = await count(pool, 'audit', 'tenant_id=$1', ['T1']);
    return r.outcome === 'forbidden' && (await balance(pool, 'T1', 'A')) === 10_00 && audit === 0 && r.transferId === undefined;
  });
  await check('R02: an actor from a DIFFERENT tenant cannot name this account (not_found_in_tenant)', async () => {
    await fresh();
    // same actor string but the source account does not exist in T2's scope
    return (await transfer(pool, 'T2', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '1.00', currency: 'USD' })).outcome === 'not_found_in_tenant';
  });
  await check('R02: a REVOKED grant (can_debit=false) is forbidden', async () => {
    await fresh();
    await seedGrant(pool, 'T1', 'A', ACTOR, false); // revoke the debit capability
    const r = await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '1.00', currency: 'USD' });
    return r.outcome === 'forbidden' && (await balance(pool, 'T1', 'A')) === 10_00;
  });
  await check('R02: authorized replay returns the stored result to the SAME grant holder', async () => {
    await fresh(); const key = k(); const req = { src: 'A', dst: 'B', amount: '2.00', currency: 'USD' };
    const first = await transfer(pool, 'T1', ACTOR, 'xfer', key, req);
    const replay = await transfer(pool, 'T1', ACTOR, 'xfer', key, req);
    return first.outcome === 'posted' && replay.outcome === 'replayed' && replay.transferId === first.transferId;
  });
  // The important leak test: a DIFFERENT, UNAUTHORIZED actor presenting someone else's key must
  // NOT get the stored result back. Authorization is checked BEFORE the idempotency replay.
  await check('R02: an unauthorized actor presenting another actor\u2019s key is forbidden (no result leak)', async () => {
    await fresh(); const key = k(); const req = { src: 'A', dst: 'B', amount: '2.00', currency: 'USD' };
    const first = await transfer(pool, 'T1', ACTOR, 'xfer', key, req); // ACTOR posts
    const leak = await transfer(pool, 'T1', OUTSIDER, 'xfer', key, req); // OUTSIDER replays the same key
    return first.outcome === 'posted' && leak.outcome === 'forbidden' && leak.transferId === undefined;
  });

  // --- R01: self-transfer (source == destination) ---
  // Narrow reproduction from the finding: A starts at 10.00 (1000 minor); a transfer of
  // 1.00 (100 minor) A->A used to return 'posted' while the credit silently matched 0 rows
  // (version already bumped by the debit), so A ended at 9.00 — money vanished. Now it is
  // refused OUTRIGHT and nothing is written.
  await check('R01: self-transfer A->A is refused (same_account), not posted', async () => {
    await fresh(); // A = 10.00, B = 0
    return (await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'A', amount: '1.00', currency: 'USD' })).outcome === 'same_account';
  });
  await check('R01: refused self-transfer leaves balance unchanged and writes NO audit/idempotency', async () => {
    await fresh(); const key = k();
    const r = await transfer(pool, 'T1', ACTOR, 'xfer', key, { src: 'A', dst: 'A', amount: '1.00', currency: 'USD' });
    const auditN = await count(pool, 'audit', 'tenant_id=$1', ['T1']);
    const idemN = await count(pool, 'idempotency', 'tenant_id=$1 AND key=$2', ['T1', key]);
    return r.outcome === 'same_account'
      && (await balance(pool, 'T1', 'A')) === 10_00   // NOT 9_00 (no lost credit)
      && auditN === 0 && idemN === 0;
  });
  await check('R01: amount validation still runs before the self-transfer check (bad amount A->A)', async () => {
    await fresh();
    // a zero amount is still bad_amount, not same_account — validation order preserved
    return (await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'A', amount: '0', currency: 'USD' })).outcome === 'bad_amount';
  });

  // --- FCS-IDEMP-001 ---
  await check('idempotency: same key + same payload replays (no double spend)', async () => {
    await fresh(); const key = k(); const req = { src: 'A', dst: 'B', amount: '3.00', currency: 'USD' };
    const r1 = await transfer(pool, 'T1', ACTOR, 'xfer', key, req);
    const r2 = await transfer(pool, 'T1', ACTOR, 'xfer', key, req);
    return r1.outcome === 'posted' && r2.outcome === 'replayed' && (await balance(pool, 'T1', 'A')) === 7_00;
  });
  await check('idempotency: same key + DIFFERENT payload => conflict', async () => {
    await fresh(); const key = k();
    await transfer(pool, 'T1', ACTOR, 'xfer', key, { src: 'A', dst: 'B', amount: '3.00', currency: 'USD' });
    return (await transfer(pool, 'T1', ACTOR, 'xfer', key, { src: 'A', dst: 'B', amount: '4.00', currency: 'USD' })).outcome === 'conflict';
  });
  await check('idempotency: same key under different tenants is independent', async () => {
    await initSchema(pool);
    for (const t of ['T1', 'T2']) { await seedAccount(pool, t, 'A', 'USD', 10_00); await seedAccount(pool, t, 'B', 'USD', 0); await seedGrant(pool, t, 'A', ACTOR, true); await seedGrant(pool, t, 'B', ACTOR, true); }
    const key = 'shared';
    const r1 = await transfer(pool, 'T1', ACTOR, 'xfer', key, { src: 'A', dst: 'B', amount: '1.00', currency: 'USD' });
    const r2 = await transfer(pool, 'T2', ACTOR, 'xfer', key, { src: 'A', dst: 'B', amount: '1.00', currency: 'USD' });
    return r1.outcome === 'posted' && r2.outcome === 'posted';
  });

  // --- concurrency ---
  await check('concurrency: 20 identical same-key requests => one posted, rest replay, single debit', async () => {
    await fresh(); const key = k(); const req = { src: 'A', dst: 'B', amount: '1.00', currency: 'USD' };
    const results = await Promise.all(Array.from({ length: 20 }, () => transfer(pool, 'T1', ACTOR, 'xfer', key, req)));
    const posted = results.filter((r) => r.outcome === 'posted').length;
    const replayed = results.filter((r) => r.outcome === 'replayed').length;
    return posted === 1 && (posted + replayed) === 20 && (await balance(pool, 'T1', 'A')) === 9_00;
  });
  await check('concurrency: competing debits never overdraw AND at least one succeeds', async () => {
    await fresh(); // 10.00 available, 15 competing 1.00 debits with distinct keys
    const results = await Promise.all(Array.from({ length: 15 }, () => transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '1.00', currency: 'USD' })));
    const posted = results.filter((r) => r.outcome === 'posted').length;
    const bal = await balance(pool, 'T1', 'A');
    return posted >= 1 && posted <= 10 && bal === 10_00 - posted * 1_00 && bal >= 0 && (await balance(pool, 'T1', 'B')) === posted * 1_00;
  });
  await check('insufficient funds rejected', async () => {
    await initSchema(pool); await seedAccount(pool, 'T1', 'A', 'USD', 1_00); await seedAccount(pool, 'T1', 'B', 'USD', 0); await seedGrant(pool, 'T1', 'A', ACTOR, true); await seedGrant(pool, 'T1', 'B', ACTOR, true);
    return (await transfer(pool, 'T1', ACTOR, 'xfer', k(), { src: 'A', dst: 'B', amount: '2.00', currency: 'USD' })).outcome === 'insufficient_funds';
  });

  // --- FCS-AUDIT-001: atomic rollback + post-commit retry ---
  await check('rollback: fault after writes/before commit leaves NO transfer/audit/idempotency and balances unchanged', async () => {
    await fresh(); const key = k();
    Faults.afterWritesBeforeCommit = () => { throw new Error('injected pre-commit fault'); };
    let threw = false;
    try { await transfer(pool, 'T1', ACTOR, 'xfer', key, { src: 'A', dst: 'B', amount: '5.00', currency: 'USD' }); }
    catch { threw = true; }
    Faults.reset();
    const auditN = await count(pool, 'audit', 'tenant_id=$1', ['T1']);
    const idemN = await count(pool, 'idempotency', 'tenant_id=$1 AND key=$2', ['T1', key]);
    return threw && auditN === 0 && idemN === 0 && (await balance(pool, 'T1', 'A')) === 10_00 && (await balance(pool, 'T1', 'B')) === 0;
  });
  await check('post-commit retry: response lost after commit; same-key retry replays; one effect', async () => {
    await fresh(); const key = k(); const req = { src: 'A', dst: 'B', amount: '2.00', currency: 'USD' };
    Faults.afterCommitBeforeResponse = () => { throw new Error('response lost after commit'); };
    let lost = false;
    try { await transfer(pool, 'T1', ACTOR, 'xfer', key, req); } catch { lost = true; }
    Faults.reset();
    const retry = await transfer(pool, 'T1', ACTOR, 'xfer', key, req); // safe retry
    return lost && retry.outcome === 'replayed' && (await balance(pool, 'T1', 'A')) === 8_00 && (await count(pool, 'audit', 'tenant_id=$1', ['T1'])) === 1;
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('failures:\n' + failures.map((f) => '  - ' + f).join('\n')); }
  pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
