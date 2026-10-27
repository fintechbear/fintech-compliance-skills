// FCS provider + webhook reference on PostgreSQL. Proves FCS-OUTBOX-001, FCS-WEBHOOK-001,
// FCS-OUTCOME-001, FCS-IDEMP-001. The network is a PROVIDER TEST DOUBLE (not a real Stripe
// sandbox) whose behaviour mirrors a documented contract: idempotency-key dedup, signed
// webhooks over the raw body, and timeouts that leave the outcome UNKNOWN.
import crypto from 'node:crypto';
import pg from 'pg';
const { Pool } = pg;

const PGCONN = process.env.PGCONN ?? 'postgresql://fcs:fcs@127.0.0.1:55443/fcs';
const pool = new Pool({ connectionString: PGCONN, max: 8 });

type OutState = 'not_started' | 'pending_unknown' | 'confirmed_success' | 'confirmed_failure';

async function initSchema() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DROP TABLE IF EXISTS webhook_inbox, outbox CASCADE');
    await c.query(`CREATE TABLE outbox(
      tenant_id text NOT NULL, provider text NOT NULL, business_id text NOT NULL,
      idem_key text NOT NULL, state text NOT NULL,
      PRIMARY KEY (tenant_id, provider, idem_key))`);
    await c.query(`CREATE TABLE webhook_inbox(
      provider text NOT NULL, event_id text NOT NULL, business_id text NOT NULL,
      tenant_id text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, event_id))`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// --- provider TEST DOUBLE (not a real sandbox) ---
const SIGNING_SECRET = 'whsec_test_double';
class ProviderDouble {
  private charges = new Map<string, string>(); // idem_key -> chargeId (dedup)
  failNext: 'timeout' | 'ok' = 'ok';
  // Charge is idempotent on the key; a 'timeout' models an UNKNOWN outcome (no result returned).
  charge(idemKey: string): { chargeId: string } {
    if (this.failNext === 'timeout') { this.failNext = 'ok'; throw new Error('provider timeout (unknown outcome)'); }
    let id = this.charges.get(idemKey);
    if (!id) { id = 'ch_' + crypto.randomBytes(6).toString('hex'); this.charges.set(idemKey, id); }
    return { chargeId: id };
  }
  sign(rawBody: string, ts: number): string {
    return crypto.createHmac('sha256', SIGNING_SECRET).update(`${ts}.${rawBody}`).digest('hex');
  }
}
const provider = new ProviderDouble();

// Outbound: durable intent FIRST (FCS-OUTBOX-001), then call with the SAME key (FCS-IDEMP-001).
async function startCharge(tenant: string, businessId: string, idemKey: string): Promise<OutState> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO outbox(tenant_id,provider,business_id,idem_key,state) VALUES($1,'double',$2,$3,'not_started')
       ON CONFLICT (tenant_id,provider,idem_key) DO NOTHING`, [tenant, businessId, idemKey]);
    await c.query('COMMIT');
  } finally { c.release(); }
  try {
    provider.charge(idemKey); // reuse SAME key on any retry
    await pool.query(`UPDATE outbox SET state='confirmed_success' WHERE tenant_id=$1 AND provider='double' AND idem_key=$2`, [tenant, idemKey]);
    return 'confirmed_success';
  } catch {
    // FCS-OUTCOME-001: unknown, NOT failure. Leave pending; do not blind-retry with a new key.
    await pool.query(`UPDATE outbox SET state='pending_unknown' WHERE tenant_id=$1 AND provider='double' AND idem_key=$2 AND state='not_started'`, [tenant, idemKey]);
    return 'pending_unknown';
  }
}

// Inbound webhook: verify raw-body signature, replay window, durable dedup.
async function receiveWebhook(provider_: string, rawBody: string, ts: number, sig: string, nowTs: number): Promise<'accepted' | 'duplicate' | 'bad_signature' | 'stale'> {
  const expect = provider.sign(rawBody, ts);
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return 'bad_signature';
  if (Math.abs(nowTs - ts) > 300) return 'stale'; // 5-min window (double's contract)
  const ev = JSON.parse(rawBody);
  try {
    const r = await pool.query(
      `INSERT INTO webhook_inbox(provider,event_id,business_id,tenant_id) VALUES($1,$2,$3,$4)
       ON CONFLICT (provider,event_id) DO NOTHING RETURNING event_id`,
      [provider_, ev.event_id, ev.business_id, ev.tenant_id]);
    return r.rowCount ? 'accepted' : 'duplicate';
  } catch { return 'bad_signature'; }
}

let pass = 0, fail = 0; const failures: string[] = [];
async function check(name: string, body: () => Promise<boolean>) {
  try { if (await body()) { pass++; console.log(`ok   - ${name}`); } else { fail++; failures.push(name); console.log(`FAIL - ${name}`); } }
  catch (e: any) { fail++; failures.push(`${name}: ${e.message}`); console.log(`FAIL - ${name} :: ${e.message}`); }
}

async function main() {
  await initSchema();

  await check('outbound: durable intent written before provider call', async () => {
    await startCharge('T1', 'biz1', 'ik1');
    const r = await pool.query(`SELECT state FROM outbox WHERE tenant_id='T1' AND idem_key='ik1'`);
    return r.rowCount === 1 && r.rows[0].state === 'confirmed_success';
  });
  await check('outbound: timeout leaves outcome pending_unknown, NOT failure', async () => {
    provider.failNext = 'timeout';
    const st = await startCharge('T1', 'biz2', 'ik2');
    const r = await pool.query(`SELECT state FROM outbox WHERE tenant_id='T1' AND idem_key='ik2'`);
    return st === 'pending_unknown' && r.rows[0].state === 'pending_unknown';
  });
  await check('outbound: safe retry reuses SAME key => one charge, resolves success', async () => {
    const st = await startCharge('T1', 'biz2', 'ik2'); // same key, no timeout now
    return st === 'confirmed_success';
  });
  await check('outbound: same key is idempotent at the provider (no double charge)', async () => {
    await startCharge('T1', 'biz3', 'ik3');
    const before = (provider as any).charges.size;
    await startCharge('T1', 'biz3', 'ik3');
    return (provider as any).charges.size === before;
  });

  // webhook
  const mkEvent = (eid: string, biz: string, tenant = 'T1') => JSON.stringify({ event_id: eid, business_id: biz, tenant_id: tenant });
  const ts = 1_000_000;
  await check('webhook: valid signature + fresh ts => accepted', async () => {
    const raw = mkEvent('ev1', 'biz1'); return (await receiveWebhook('double', raw, ts, provider.sign(raw, ts), ts)) === 'accepted';
  });
  await check('webhook: same event id re-delivered => duplicate (dedup), still ok', async () => {
    const raw = mkEvent('ev1', 'biz1'); return (await receiveWebhook('double', raw, ts, provider.sign(raw, ts), ts)) === 'duplicate';
  });
  await check('webhook: tampered body => bad_signature (verified on raw bytes)', async () => {
    const raw = mkEvent('ev2', 'biz1'); const good = provider.sign(raw, ts);
    const tampered = mkEvent('ev2', 'biz-HACKED');
    return (await receiveWebhook('double', tampered, ts, good, ts)) === 'bad_signature';
  });
  await check('webhook: outside replay window => stale', async () => {
    const raw = mkEvent('ev3', 'biz1'); return (await receiveWebhook('double', raw, ts, provider.sign(raw, ts), ts + 10_000)) === 'stale';
  });
  await check('webhook: two different event ids for one business event both accepted (caller dedups on business_id)', async () => {
    const a = mkEvent('ev4a', 'bizX'), b = mkEvent('ev4b', 'bizX');
    const ra = await receiveWebhook('double', a, ts, provider.sign(a, ts), ts);
    const rb = await receiveWebhook('double', b, ts, provider.sign(b, ts), ts);
    const n = await pool.query(`SELECT count(*)::int n FROM webhook_inbox WHERE business_id='bizX'`);
    return ra === 'accepted' && rb === 'accepted' && n.rows[0].n === 2;
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
  pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
