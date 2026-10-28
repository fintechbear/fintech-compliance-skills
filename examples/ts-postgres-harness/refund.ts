// Fintech refund/cancel reference on REAL PostgreSQL. Exercises FCS-REFUND-001 (a refund is
// bounded by its source capture; partials accumulate; concurrent refunds serialize so the cap
// is never raced past), FCS-REFUNDTERM-001 (cancel/void before capture vs reversal/refund
// after — distinct, not synonyms), FCS-OUTCOME-001 (unknown outcome is not auto-failure and is
// never re-sent with a new key), FCS-IDEMP-001 (idempotency key is scoped AND fingerprinted)
// and FCS-AUTHZ-001 (a refund stays inside its (tenant,payment) scope). The provider is a
// labelled TEST DOUBLE, not a real sandbox.
//
// R09 (hardening over the first sketch):
//   - Same idem key + DIFFERENT amount is a CONFLICT, not a silent replay: the refund carries a
//     canonical payload fingerprint; a replay must match it.
//   - Money is BigInt end-to-end (R06): captured amount and the in-flight sum are summed as
//     BigInt, never Number(bigint) — so a near-int64 cap cannot be raced by float rounding.
//   - The key sent to the provider is SCOPED to (tenant,payment,operation,provider), so two
//     tenants (or two payments) reusing the same client key never collide at the provider.
//   - Crash recovery: an intent reserved before the provider call is recoverable after a crash
//     (the row stays pending_unknown; resolving reuses the SAME scoped key — never a blind re-send).
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
    await c.query('DROP TABLE IF EXISTS refund_audit, refunds, payments CASCADE');
    await c.query(`CREATE TABLE payments(
      id text NOT NULL, tenant_id text NOT NULL, provider text NOT NULL,
      currency text NOT NULL, captured_minor bigint NOT NULL, lifecycle text NOT NULL,
      PRIMARY KEY (tenant_id, id))`);
    // Each refund is bounded to one source payment. (tenant,payment,idem_key) dedups a retried
    // refund; payload_fingerprint lets a replay with a DIFFERENT amount be rejected as a conflict.
    await c.query(`CREATE TABLE refunds(
      id bigserial PRIMARY KEY, payment_id text NOT NULL, tenant_id text NOT NULL,
      idem_key text NOT NULL, payload_fingerprint text NOT NULL,
      amount_minor bigint NOT NULL, state text NOT NULL, provider_key text NOT NULL,
      UNIQUE (tenant_id, payment_id, idem_key))`);
    // append-only corrective ledger for refunds (FCS-AUDIT-001): one row per state transition.
    await c.query(`CREATE TABLE refund_audit(
      id bigserial PRIMARY KEY, tenant_id text NOT NULL, payment_id text NOT NULL,
      idem_key text NOT NULL, event text NOT NULL, amount_minor bigint NOT NULL,
      at timestamptz NOT NULL DEFAULT now())`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

async function seedPayment(id: string, tenant: string, capturedMinor: number | bigint, lifecycle: Lifecycle = 'captured', currency = 'USD') {
  await pool.query(
    `INSERT INTO payments(id,tenant_id,provider,currency,captured_minor,lifecycle)
     VALUES($1,$2,'double',$3,$4,$5)`,
    [id, tenant, currency, BigInt(capturedMinor).toString(), lifecycle]);
}

// Canonical refund fingerprint (FCS-IDEMP-001): stable JSON of the scoped request. A replay
// with the same (tenant,payment,key) but a different amount/currency will not match this.
function fingerprint(tenant: string, paymentId: string, amountMinor: bigint, currency: string): string {
  return crypto.createHash('sha256').update(JSON.stringify([tenant, paymentId, amountMinor.toString(), currency])).digest('hex');
}
// Provider-facing key is SCOPED so two tenants/payments reusing the same client key never
// collide at the provider (FCS-IDEMP-001 + FCS-AUTHZ-001).
function providerKey(tenant: string, paymentId: string, idemKey: string): string {
  return crypto.createHash('sha256').update(JSON.stringify(['refund', 'double', tenant, paymentId, idemKey])).digest('hex');
}

// --- provider TEST DOUBLE (not a real sandbox). Dedups on the SCOPED key. ---
class ProviderDouble {
  private refunds = new Map<string, string>(); // scopedKey -> providerRefundId (dedup)
  failNext: 'timeout' | 'ok' = 'ok';
  refund(scopedKey: string): { refundId: string } {
    if (this.failNext === 'timeout') { this.failNext = 'ok'; throw new Error('provider timeout (unknown outcome)'); }
    let id = this.refunds.get(scopedKey);
    if (!id) { id = 're_' + crypto.randomBytes(6).toString('hex'); this.refunds.set(scopedKey, id); }
    return { refundId: id };
  }
  callCount(): number { return this.refunds.size; }
}
const provider = new ProviderDouble();

async function cancel(paymentId: string, tenant: string): Promise<'voided'> {
  const r = await pool.query(`SELECT lifecycle FROM payments WHERE id=$1 AND tenant_id=$2`, [paymentId, tenant]);
  if (!r.rowCount) throw new Error('payment not found in tenant scope');
  if (r.rows[0].lifecycle !== 'authorized') throw new Error(`cannot cancel/void: payment is ${r.rows[0].lifecycle}, not authorized (use refund after capture)`);
  await pool.query(`UPDATE payments SET lifecycle='voided' WHERE id=$1 AND tenant_id=$2`, [paymentId, tenant]);
  return 'voided';
}

type RefundResult = 'confirmed' | 'rejected_exceeds_cap' | 'rejected_lifecycle' | 'rejected_scope'
  | 'replayed' | 'conflict' | 'pending_unknown';

async function refund(paymentId: string, tenant: string, idemKey: string, amountMinorIn: number | bigint, currency = 'USD'): Promise<RefundResult> {
  const amountMinor = BigInt(amountMinorIn);
  const fp = fingerprint(tenant, paymentId, amountMinor, currency);
  const pkey = providerKey(tenant, paymentId, idemKey);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const p = await c.query(`SELECT currency, captured_minor, lifecycle FROM payments WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [paymentId, tenant]);
    if (!p.rowCount) { await c.query('ROLLBACK'); return 'rejected_scope'; }           // FCS-AUTHZ-001
    if (p.rows[0].lifecycle !== 'captured') { await c.query('ROLLBACK'); return 'rejected_lifecycle'; } // FCS-REFUNDTERM-001
    if (amountMinor <= 0n) { await c.query('ROLLBACK'); throw new Error('refund amount must be positive'); } // FCS-MONEY-001
    if (p.rows[0].currency !== currency) { await c.query('ROLLBACK'); throw new Error('currency mismatch'); }

    // Idempotent replay: same (tenant,payment,key). A matching fingerprint replays the one
    // effect; a DIFFERENT fingerprint (e.g. 500 then 900) is a CONFLICT, never a silent replay.
    const existing = await c.query(`SELECT state, payload_fingerprint FROM refunds WHERE tenant_id=$1 AND payment_id=$2 AND idem_key=$3`, [tenant, paymentId, idemKey]);
    if (existing.rowCount) {
      const row = existing.rows[0];
      await c.query('COMMIT');
      if (row.payload_fingerprint !== fp) return 'conflict';                            // R09: same key, different amount
      return row.state === 'confirmed' ? 'replayed' : 'pending_unknown';
    }

    // BigInt cap arithmetic (R06): sum in BigInt, never Number(bigint).
    const captured = BigInt(p.rows[0].captured_minor);
    const sumRow = await c.query(`SELECT COALESCE(SUM(amount_minor),0)::text s FROM refunds WHERE payment_id=$1 AND tenant_id=$2 AND state IN ('confirmed','pending_unknown')`, [paymentId, tenant]);
    const already = BigInt(sumRow.rows[0].s);
    if (already + amountMinor > captured) { await c.query('ROLLBACK'); return 'rejected_exceeds_cap'; } // FCS-REFUND-001

    await c.query(`INSERT INTO refunds(payment_id,tenant_id,idem_key,payload_fingerprint,amount_minor,state,provider_key)
                   VALUES($1,$2,$3,$4,$5,'pending_unknown',$6)`,
      [paymentId, tenant, idemKey, fp, amountMinor.toString(), pkey]);
    await c.query(`INSERT INTO refund_audit(tenant_id,payment_id,idem_key,event,amount_minor) VALUES($1,$2,$3,'reserved',$4)`,
      [tenant, paymentId, idemKey, amountMinor.toString()]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }

  // Call the provider OUTSIDE the lock, with the SCOPED key (FCS-IDEMP-001 + scope).
  try {
    provider.refund(pkey);
  } catch {
    // Unknown outcome: leave pending_unknown. Do NOT retry with a new key, do NOT mark failure.
    await pool.query(`INSERT INTO refund_audit(tenant_id,payment_id,idem_key,event,amount_minor) VALUES($1,$2,$3,'provider_unknown',$4)`,
      [tenant, paymentId, idemKey, BigInt(amountMinorIn).toString()]);
    return 'pending_unknown';
  }
  await pool.query(`UPDATE refunds SET state='confirmed' WHERE tenant_id=$1 AND payment_id=$2 AND idem_key=$3`, [tenant, paymentId, idemKey]);
  await pool.query(`INSERT INTO refund_audit(tenant_id,payment_id,idem_key,event,amount_minor) VALUES($1,$2,$3,'confirmed',$4)`,
    [tenant, paymentId, idemKey, BigInt(amountMinorIn).toString()]);
  return 'confirmed';
}

// Recovery: resolve any pending_unknown refund by REUSING its stored scoped key — never a new one.
async function resolvePending(tenant: string, paymentId: string, idemKey: string): Promise<RefundResult> {
  const r = await pool.query(`SELECT provider_key, state FROM refunds WHERE tenant_id=$1 AND payment_id=$2 AND idem_key=$3`, [tenant, paymentId, idemKey]);
  if (!r.rowCount) return 'rejected_scope';
  if (r.rows[0].state === 'confirmed') return 'replayed';
  try { provider.refund(r.rows[0].provider_key); } catch { return 'pending_unknown'; }
  await pool.query(`UPDATE refunds SET state='confirmed' WHERE tenant_id=$1 AND payment_id=$2 AND idem_key=$3`, [tenant, paymentId, idemKey]);
  await pool.query(`INSERT INTO refund_audit(tenant_id,payment_id,idem_key,event,amount_minor) VALUES($1,$2,$3,'confirmed_on_recovery',(SELECT amount_minor FROM refunds WHERE tenant_id=$1 AND payment_id=$2 AND idem_key=$3))`,
    [tenant, paymentId, idemKey]);
  return 'confirmed';
}

async function refundedTotal(paymentId: string, tenant: string): Promise<bigint> {
  const r = await pool.query(`SELECT COALESCE(SUM(amount_minor),0)::text s FROM refunds WHERE payment_id=$1 AND tenant_id=$2 AND state IN ('confirmed','pending_unknown')`, [paymentId, tenant]);
  return BigInt(r.rows[0].s);
}
async function auditCount(tenant: string, paymentId: string, idemKey: string): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int n FROM refund_audit WHERE tenant_id=$1 AND payment_id=$2 AND idem_key=$3`, [tenant, paymentId, idemKey]);
  return r.rows[0].n;
}

let pass = 0, fail = 0; const failures: string[] = [];
async function check(name: string, fn: () => Promise<boolean>) {
  try { if (await fn()) { pass++; console.log(`  ok   ${name}`); } else { fail++; failures.push(name); console.log(`  FAIL ${name}`); } }
  catch (e) { fail++; failures.push(`${name} :: ${(e as Error).message}`); console.log(`  FAIL ${name} :: ${(e as Error).message}`); }
}

async function main() {
  await initSchema();
  console.log('refund/cancel reference @ real PostgreSQL (provider is a labelled TEST DOUBLE)');

  await check('refund: full refund of a captured payment confirms', async () => {
    await seedPayment('p1', 'T1', 1000);
    const r = await refund('p1', 'T1', 'rk-1', 1000);
    return r === 'confirmed' && (await refundedTotal('p1', 'T1')) === 1000n;
  });
  await check('refund: partial refunds accumulate up to the captured amount', async () => {
    await seedPayment('p2', 'T1', 1000);
    const a = await refund('p2', 'T1', 'rk-a', 300);
    const b = await refund('p2', 'T1', 'rk-b', 400);
    return a === 'confirmed' && b === 'confirmed' && (await refundedTotal('p2', 'T1')) === 700n;
  });
  await check('refund: a refund that would exceed the captured amount is rejected', async () => {
    await seedPayment('p3', 'T1', 1000);
    await refund('p3', 'T1', 'rk-1', 800);
    const over = await refund('p3', 'T1', 'rk-2', 300);
    return over === 'rejected_exceeds_cap' && (await refundedTotal('p3', 'T1')) === 800n;
  });
  await check('refund: same key + SAME payload replays the one effect (no double refund)', async () => {
    await seedPayment('p4', 'T1', 1000);
    const a = await refund('p4', 'T1', 'rk-same', 500);
    const b = await refund('p4', 'T1', 'rk-same', 500);
    return a === 'confirmed' && b === 'replayed' && (await refundedTotal('p4', 'T1')) === 500n;
  });
  // R09 core: same key, DIFFERENT amount => conflict (was a silent replay).
  await check('refund: same key + DIFFERENT amount (500 then 900) => conflict, no second effect', async () => {
    await seedPayment('p4b', 'T1', 1000);
    const a = await refund('p4b', 'T1', 'rk-diff', 500);
    const b = await refund('p4b', 'T1', 'rk-diff', 900); // same key, different amount
    return a === 'confirmed' && b === 'conflict' && (await refundedTotal('p4b', 'T1')) === 500n;
  });
  await check('refund: concurrent refunds cannot race past the cap (serialized)', async () => {
    await seedPayment('p5', 'T1', 1000);
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => refund('p5', 'T1', `rk-c${n}`, 300)));
    const ok = results.filter((r) => r === 'confirmed').length;
    const total = await refundedTotal('p5', 'T1');
    return ok === 3 && total === 900n && total <= 1000n;
  });
  await check('refund: unknown provider outcome stays pending (not failed, not re-sent)', async () => {
    await seedPayment('p6', 'T1', 1000);
    provider.failNext = 'timeout';
    const r = await refund('p6', 'T1', 'rk-timeout', 400);
    const replay = await refund('p6', 'T1', 'rk-timeout', 400);
    return r === 'pending_unknown' && replay === 'pending_unknown' && (await refundedTotal('p6', 'T1')) === 400n;
  });
  // R09: different tenants OR different payments reusing the SAME client key are independent,
  // and the provider is called with DISTINCT scoped keys (no cross-tenant collision).
  await check('refund: same client key across two tenants is independent (scoped provider key)', async () => {
    await seedPayment('shared', 'T1', 1000);
    await seedPayment('shared', 'T2', 1000);
    const before = provider.callCount();
    const a = await refund('shared', 'T1', 'client-key', 100);
    const b = await refund('shared', 'T2', 'client-key', 100);
    return a === 'confirmed' && b === 'confirmed'
      && (await refundedTotal('shared', 'T1')) === 100n && (await refundedTotal('shared', 'T2')) === 100n
      && provider.callCount() === before + 2; // two DISTINCT provider calls, not deduped into one
  });
  await check('refund: crash after reserve (pending) recovers by REUSING the scoped key', async () => {
    await seedPayment('p-crash', 'T1', 1000);
    provider.failNext = 'timeout'; // provider call "lost" -> pending
    const r = await refund('p-crash', 'T1', 'rk-crash', 200);
    const before = provider.callCount();
    const rec = await resolvePending('T1', 'p-crash', 'rk-crash'); // recovery reuses stored scoped key
    // the provider dedups on the SAME scoped key -> no new provider refund id minted
    return r === 'pending_unknown' && rec === 'confirmed' && provider.callCount() === before;
  });
  await check('cancel/void: applies before capture; refund is refused on it', async () => {
    await seedPayment('p7', 'T1', 1000, 'authorized');
    const v = await cancel('p7', 'T1');
    const r = await refund('p7', 'T1', 'rk-x', 100);
    return v === 'voided' && r === 'rejected_lifecycle';
  });
  await check('cancel/void: refused on an already-captured payment (not a synonym for refund)', async () => {
    await seedPayment('p8', 'T1', 1000, 'captured');
    try { await cancel('p8', 'T1'); return false; } catch (e) { return /not authorized/.test((e as Error).message); }
  });
  await check('refund: a payment in another tenant is out of scope (FCS-AUTHZ-001)', async () => {
    await seedPayment('p9', 'T1', 1000, 'captured');
    const r = await refund('p9', 'T2', 'rk-steal', 100);
    return r === 'rejected_scope' && (await refundedTotal('p9', 'T1')) === 0n;
  });
  // R06 at a near-int64 cap: a float-summed cap check would mis-handle these; BigInt is exact.
  await check('refund: near-int64 cap is enforced exactly (BigInt, no float rounding)', async () => {
    const cap = 9_007_199_254_740_993n; // > Number.MAX_SAFE_INTEGER
    await seedPayment('pbig', 'T1', cap);
    const a = await refund('pbig', 'T1', 'rk-big1', cap - 1n);
    const b = await refund('pbig', 'T1', 'rk-big2', 2n); // (cap-1)+2 = cap+1 > cap -> reject
    const okc = await refund('pbig', 'T1', 'rk-big3', 1n); // (cap-1)+1 = cap -> ok
    return a === 'confirmed' && b === 'rejected_exceeds_cap' && okc === 'confirmed' && (await refundedTotal('pbig', 'T1')) === cap;
  });
  await check('refund: a confirmed refund has an append-only audit trail (reserved+confirmed)', async () => {
    await seedPayment('p10', 'T1', 1000);
    await refund('p10', 'T1', 'rk-audit', 100);
    return (await auditCount('T1', 'p10', 'rk-audit')) >= 2; // reserved + confirmed
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
  pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
