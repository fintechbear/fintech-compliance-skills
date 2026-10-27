// Fintech refund/cancel reference on REAL PostgreSQL. Exercises FCS-REFUND-001 (a refund is
// bounded by its source capture; partials accumulate; concurrent refunds serialize so the cap
// is never raced past), FCS-REFUNDTERM-001 (cancel/void before capture vs reversal/refund
// after — distinct, not synonyms), FCS-OUTCOME-001 (unknown outcome is not auto-failure and is
// never re-sent with a new key) and FCS-AUTHZ-001 (a refund stays inside its (tenant,provider)
// scope). The provider is a labelled TEST DOUBLE, not a real sandbox.
import crypto from 'node:crypto';
import pg from 'pg';
const { Pool } = pg;

const PGCONN = process.env.PGCONN ?? 'postgresql://fcs:fcs@127.0.0.1:55443/fcs';
const pool = new Pool({ connectionString: PGCONN, max: 12 });

type Lifecycle = 'authorized' | 'captured' | 'voided';

async function initSchema() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DROP TABLE IF EXISTS refunds, payments CASCADE');
    // A payment has a captured amount (minor units) and a lifecycle stage.
    await c.query(`CREATE TABLE payments(
      id text PRIMARY KEY, tenant_id text NOT NULL, provider text NOT NULL,
      currency text NOT NULL, captured_minor bigint NOT NULL, lifecycle text NOT NULL)`);
    // Each refund is bounded to one source payment. idem_key dedups a retried refund.
    await c.query(`CREATE TABLE refunds(
      id bigserial PRIMARY KEY, payment_id text NOT NULL REFERENCES payments(id),
      tenant_id text NOT NULL, idem_key text NOT NULL, amount_minor bigint NOT NULL,
      state text NOT NULL,
      UNIQUE (tenant_id, payment_id, idem_key))`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

async function seedPayment(id: string, tenant: string, capturedMinor: number, lifecycle: Lifecycle = 'captured', currency = 'USD') {
  await pool.query(
    `INSERT INTO payments(id,tenant_id,provider,currency,captured_minor,lifecycle)
     VALUES($1,$2,'double',$3,$4,$5)`,
    [id, tenant, currency, capturedMinor, lifecycle]);
}

// --- provider TEST DOUBLE (not a real sandbox) ---
class ProviderDouble {
  private refunds = new Map<string, string>(); // idem_key -> providerRefundId (dedup)
  failNext: 'timeout' | 'ok' = 'ok';
  refund(idemKey: string): { refundId: string } {
    if (this.failNext === 'timeout') { this.failNext = 'ok'; throw new Error('provider timeout (unknown outcome)'); }
    let id = this.refunds.get(idemKey);
    if (!id) { id = 're_' + crypto.randomBytes(6).toString('hex'); this.refunds.set(idemKey, id); }
    return { refundId: id };
  }
}
const provider = new ProviderDouble();

// FCS-REFUNDTERM-001: cancel/void only applies BEFORE capture. Refusing to "refund" an
// authorized-but-not-captured payment (and vice versa) is the point.
async function cancel(paymentId: string, tenant: string): Promise<'voided'> {
  const r = await pool.query(`SELECT lifecycle FROM payments WHERE id=$1 AND tenant_id=$2`, [paymentId, tenant]);
  if (!r.rowCount) throw new Error('payment not found in tenant scope'); // FCS-AUTHZ-001
  if (r.rows[0].lifecycle !== 'authorized') throw new Error(`cannot cancel/void: payment is ${r.rows[0].lifecycle}, not authorized (use refund after capture)`);
  await pool.query(`UPDATE payments SET lifecycle='voided' WHERE id=$1`, [paymentId]);
  return 'voided';
}

type RefundResult = 'confirmed' | 'rejected_exceeds_cap' | 'rejected_lifecycle' | 'rejected_scope' | 'replayed' | 'pending_unknown';

// FCS-REFUND-001: serialize on the payment row (FOR UPDATE), sum existing confirmed refunds,
// reject if this one would push the total over the captured amount.
async function refund(paymentId: string, tenant: string, idemKey: string, amountMinor: number): Promise<RefundResult> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Lock the source payment so concurrent refunds cannot both read the old refunded total.
    const p = await c.query(`SELECT currency, captured_minor, lifecycle FROM payments WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [paymentId, tenant]);
    if (!p.rowCount) { await c.query('ROLLBACK'); return 'rejected_scope'; } // FCS-AUTHZ-001
    if (p.rows[0].lifecycle !== 'captured') { await c.query('ROLLBACK'); return 'rejected_lifecycle'; } // FCS-REFUNDTERM-001
    if (amountMinor <= 0) { await c.query('ROLLBACK'); throw new Error('refund amount must be positive'); } // FCS-MONEY-001

    // Idempotent replay: same (tenant,payment,key) already recorded -> return its effect, no new money.
    const existing = await c.query(`SELECT state FROM refunds WHERE tenant_id=$1 AND payment_id=$2 AND idem_key=$3`, [tenant, paymentId, idemKey]);
    if (existing.rowCount) {
      await c.query('COMMIT');
      return existing.rows[0].state === 'confirmed' ? 'replayed' : 'pending_unknown';
    }

    const captured = Number(p.rows[0].captured_minor);
    const sumRow = await c.query(`SELECT COALESCE(SUM(amount_minor),0)::bigint s FROM refunds WHERE payment_id=$1 AND state IN ('confirmed','pending_unknown')`, [paymentId]);
    const already = Number(sumRow.rows[0].s);
    if (already + amountMinor > captured) { await c.query('ROLLBACK'); return 'rejected_exceeds_cap'; } // FCS-REFUND-001

    // Reserve the refund row (pending) INSIDE the lock so the cap includes in-flight refunds.
    await c.query(`INSERT INTO refunds(payment_id,tenant_id,idem_key,amount_minor,state) VALUES($1,$2,$3,$4,'pending_unknown')`,
      [paymentId, tenant, idemKey, amountMinor]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }

  // Call the provider OUTSIDE the lock, with the SAME idem key (FCS-IDEMP-001).
  try {
    provider.refund(idemKey);
  } catch {
    // Unknown outcome: leave the row pending_unknown. Do NOT retry with a new key, do NOT
    // mark failure. The reserved amount still counts against the cap until resolved. (FCS-OUTCOME-001)
    return 'pending_unknown';
  }
  await pool.query(`UPDATE refunds SET state='confirmed' WHERE tenant_id=$1 AND payment_id=$2 AND idem_key=$3`, [tenant, paymentId, idemKey]);
  return 'confirmed';
}

async function refundedTotal(paymentId: string): Promise<number> {
  const r = await pool.query(`SELECT COALESCE(SUM(amount_minor),0)::bigint s FROM refunds WHERE payment_id=$1 AND state IN ('confirmed','pending_unknown')`, [paymentId]);
  return Number(r.rows[0].s);
}

let pass = 0, fail = 0; const failures: string[] = [];
async function check(name: string, fn: () => Promise<boolean>) {
  try { if (await fn()) { pass++; console.log(`  ok   ${name}`); } else { fail++; failures.push(name); console.log(`  FAIL ${name}`); } }
  catch (e) { fail++; failures.push(`${name} :: ${(e as Error).message}`); console.log(`  FAIL ${name} :: ${(e as Error).message}`); }
}

async function main() {
  await initSchema();
  console.log('refund/cancel reference @ real PostgreSQL');

  await check('refund: full refund of a captured payment confirms', async () => {
    await seedPayment('p1', 'T1', 1000);
    const r = await refund('p1', 'T1', 'rk-1', 1000);
    return r === 'confirmed' && (await refundedTotal('p1')) === 1000;
  });

  await check('refund: partial refunds accumulate up to the captured amount', async () => {
    await seedPayment('p2', 'T1', 1000);
    const a = await refund('p2', 'T1', 'rk-a', 300);
    const b = await refund('p2', 'T1', 'rk-b', 400);
    return a === 'confirmed' && b === 'confirmed' && (await refundedTotal('p2')) === 700;
  });

  await check('refund: a refund that would exceed the captured amount is rejected', async () => {
    await seedPayment('p3', 'T1', 1000);
    await refund('p3', 'T1', 'rk-1', 800);
    const over = await refund('p3', 'T1', 'rk-2', 300); // 800+300 > 1000
    return over === 'rejected_exceeds_cap' && (await refundedTotal('p3')) === 800;
  });

  await check('refund: same idem key replays the one effect (no double refund)', async () => {
    await seedPayment('p4', 'T1', 1000);
    const a = await refund('p4', 'T1', 'rk-same', 500);
    const b = await refund('p4', 'T1', 'rk-same', 500); // replay
    return a === 'confirmed' && b === 'replayed' && (await refundedTotal('p4')) === 500;
  });

  await check('refund: concurrent refunds cannot race past the cap (serialized)', async () => {
    await seedPayment('p5', 'T1', 1000);
    // Fire 5 concurrent 300-refunds. Only 3 can fit (3*300=900 <= 1000); the rest rejected.
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => refund('p5', 'T1', `rk-c${n}`, 300)));
    const ok = results.filter((r) => r === 'confirmed').length;
    const total = await refundedTotal('p5');
    return ok === 3 && total === 900 && total <= 1000;
  });

  await check('refund: unknown provider outcome stays pending (not failed, not re-sent)', async () => {
    await seedPayment('p6', 'T1', 1000);
    provider.failNext = 'timeout';
    const r = await refund('p6', 'T1', 'rk-timeout', 400);
    // pending_unknown still counts against the cap; a retry with the SAME key does not double.
    const replay = await refund('p6', 'T1', 'rk-timeout', 400);
    return r === 'pending_unknown' && replay === 'pending_unknown' && (await refundedTotal('p6')) === 400;
  });

  await check('cancel/void: applies before capture; refund is refused on it (FCS-REFUNDTERM-001)', async () => {
    await seedPayment('p7', 'T1', 1000, 'authorized');
    const v = await cancel('p7', 'T1');
    // After void, a refund is lifecycle-rejected (money was never captured).
    const r = await refund('p7', 'T1', 'rk-x', 100);
    return v === 'voided' && r === 'rejected_lifecycle';
  });

  await check('cancel/void: refused on an already-captured payment (not a synonym for refund)', async () => {
    await seedPayment('p8', 'T1', 1000, 'captured');
    try { await cancel('p8', 'T1'); return false; } catch (e) { return /not authorized/.test((e as Error).message); }
  });

  await check('refund: a payment in another tenant is out of scope (FCS-AUTHZ-001)', async () => {
    await seedPayment('p9', 'T1', 1000, 'captured');
    const r = await refund('p9', 'T2', 'rk-steal', 100); // wrong tenant
    return r === 'rejected_scope' && (await refundedTotal('p9')) === 0;
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
  pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
