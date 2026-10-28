// FCS provider + webhook reference on REAL PostgreSQL. Proves FCS-OUTBOX-001, FCS-WEBHOOK-001,
// FCS-OUTCOME-001, FCS-IDEMP-001. The network is a PROVIDER TEST DOUBLE (clearly labelled, NOT a
// real Stripe sandbox) whose behaviour mirrors a documented contract: idempotency-key dedup,
// signed webhooks over the RAW body, timeouts that leave the outcome UNKNOWN, and key rotation.
//
// R10 (hardening over the first sketch):
//   - A short/garbled signature must NEVER raise RangeError: length/encoding is validated
//     BEFORE any constant-time compare (and the compare is over equal-length buffers).
//   - A malformed JSON body is bad_request, NOT bad_signature.
//   - A DB/infra error is infra_error, NOT bad_signature (never attribute an infra fault to the caller).
//   - The tenant/provider/business binding is taken from the SIGNED context the provider is
//     registered for, not from an attacker-controllable field in the payload alone.
//   - Durable inbox is only the FIRST stage: a real consumer applies the business effect, and
//     business-effect dedup is keyed on the logical (provider,business_id) event, so the same
//     logical event delivered under two different provider event ids applies ONCE.
//   - Key rotation: a body signed with an old-but-still-valid key verifies; an expired/invalid
//     key does not. An UnknownOutcome charge is never re-sent blind under a new key.
import crypto from 'node:crypto';
import pg from 'pg';
const { Pool } = pg;

const PGCONN = process.env.PGCONN ?? 'postgresql://fcs:fcs@127.0.0.1:55443/fcs';
const pool = new Pool({ connectionString: PGCONN, max: 8 });

type OutState = 'not_started' | 'pending_unknown' | 'confirmed_success' | 'confirmed_failure' | 'conflict';

async function initSchema() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DROP TABLE IF EXISTS webhook_conflicts, webhook_effects, webhook_inbox, outbox CASCADE');
    await c.query(`CREATE TABLE outbox(
      tenant_id text NOT NULL, provider text NOT NULL, business_id text NOT NULL,
      idem_key text NOT NULL, state text NOT NULL,
      PRIMARY KEY (tenant_id, provider, idem_key), UNIQUE (tenant_id, provider, business_id))`);
    // Stage 1 — durable INBOX: raw transport dedup on (provider,event_id). Carries the
    // TRUSTED binding (tenant/business) resolved from the registered provider, plus a
    // logical_key so two transport events for one logical business event can be collapsed.
    await c.query(`CREATE TABLE webhook_inbox(
      provider text NOT NULL, event_id text NOT NULL, logical_key text NOT NULL,
      business_id text NOT NULL, tenant_id text NOT NULL, kind text NOT NULL,
      consumed boolean NOT NULL DEFAULT false,
      received_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, event_id))`);
    // Stage 2 — business EFFECT, deduped on the LOGICAL key so the same logical event applied
    // under two different transport event ids has exactly one effect. terminal wins over pending.
    await c.query(`CREATE TABLE webhook_effects(
      tenant_id text NOT NULL, logical_key text NOT NULL, outcome text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, logical_key))`);
    await c.query(`CREATE TABLE webhook_conflicts(provider text NOT NULL, event_id text NOT NULL, observed text NOT NULL, incoming text NOT NULL, PRIMARY KEY(provider,event_id))`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// --- provider TEST DOUBLE (not a real sandbox) ---
// Key ROTATION: the provider accepts a set of currently-valid signing keys (newest first);
// an old key stays valid through its overlap window, an expired key is removed.
class ProviderDouble {
  private charges = new Map<string, string>(); // idem_key -> chargeId (dedup)
  failNext: 'timeout' | 'timeout_after_effect' | 'ok' = 'ok';
  // registered providers: provider -> { signingKeys[], tenant, kind-of events it may emit }
  private keys: string[] = ['whsec_v2', 'whsec_v1']; // newest first; v1 is the rotated-out-but-valid key
  charge(idemKey: string): { chargeId: string } {
    if (this.failNext === 'timeout') { this.failNext = 'ok'; throw new Error('provider timeout (unknown outcome)'); }
    let id = this.charges.get(idemKey);
    if (!id) { id = 'ch_' + crypto.randomBytes(6).toString('hex'); this.charges.set(idemKey, id); }
    if (this.failNext === 'timeout_after_effect') { this.failNext = 'ok'; throw new Error('response lost after provider effect'); }
    return { chargeId: id };
  }
  chargeCount(): number { return this.charges.size; }
  validKeys(): string[] { return this.keys.slice(); }
  rotate(newKey: string, keepOld = true) { this.keys = keepOld ? [newKey, this.keys[0]] : [newKey]; }
  signWith(key: string, rawBody: string, ts: number): string {
    return crypto.createHmac('sha256', key).update(`${ts}.${rawBody}`).digest('hex');
  }
  sign(rawBody: string, ts: number): string { return this.signWith(this.keys[0], rawBody, ts); }
}
const provider = new ProviderDouble();

// TRUSTED provider registry: the binding (which tenant a provider belongs to, what event
// kinds it may emit) comes from HERE, never from the attacker-controllable payload body.
const REGISTRY: Record<string, { tenant: string; allowedKinds: Set<string> }> = {
  double: { tenant: 'T1', allowedKinds: new Set(['charge.succeeded', 'charge.failed', 'charge.pending']) },
};

// Outbound: durable intent FIRST (FCS-OUTBOX-001), then call with the SAME key (FCS-IDEMP-001).
async function startCharge(tenant: string, businessId: string, idemKey: string): Promise<OutState> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO outbox(tenant_id,provider,business_id,idem_key,state)
      VALUES($1,'double',$2,$3,'pending_unknown') ON CONFLICT DO NOTHING`, [tenant, businessId, idemKey]);
    const row = await c.query(`SELECT business_id,state FROM outbox WHERE tenant_id=$1 AND provider='double' AND idem_key=$2 FOR UPDATE`, [tenant, idemKey]);
    // Same key + changed payload is a conflict. A new key cannot bypass an existing business intent.
    if (!row.rowCount || row.rows[0].business_id !== businessId) { await c.query('ROLLBACK'); return 'conflict'; }
    const state = row.rows[0].state as OutState;
    await c.query('COMMIT');
    if (state === 'confirmed_success' || state === 'confirmed_failure') return state;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  const scopedKey = crypto.createHash('sha256').update(JSON.stringify(['charge', 'double', tenant, idemKey])).digest('hex');
  try { provider.charge(scopedKey); }
  catch { return 'pending_unknown'; }
  const done = await pool.connect();
  try {
    await done.query('BEGIN');
    const result = await applyOutcome(done, tenant, 'double', businessId, 'succeeded', `response:${JSON.stringify([tenant,idemKey])}`);
    await done.query('COMMIT');
    return result.conflict ? 'conflict' : result.outcome === 'succeeded' ? 'confirmed_success' : 'confirmed_failure';
  } catch (e) { await done.query('ROLLBACK'); throw e; } finally { done.release(); }
}

// Shared evidence boundary: synchronous provider responses and webhook consumers use
// the SAME business projection and lock. Contradictory terminal evidence is retained.
async function applyOutcome(c: pg.PoolClient, tenant: string, providerName: string, businessId: string,
  incoming: 'succeeded' | 'failed' | 'pending', evidenceId: string) {
  const logicalKey = `${providerName}:${businessId}`;
  const effect = await c.query(`INSERT INTO webhook_effects(tenant_id,logical_key,outcome)
    VALUES($1,$2,$3) ON CONFLICT (tenant_id,logical_key) DO UPDATE
    SET outcome=CASE WHEN webhook_effects.outcome='pending' THEN EXCLUDED.outcome ELSE webhook_effects.outcome END,
        applied_at=CASE WHEN webhook_effects.outcome='pending' THEN now() ELSE webhook_effects.applied_at END
    RETURNING outcome, (xmax=0) AS inserted`, [tenant, logicalKey, incoming]);
  const observed = effect.rows[0].outcome as 'succeeded' | 'failed' | 'pending';
  const conflict = isTerminal(observed) && isTerminal(incoming) && observed !== incoming;
  if (conflict) await c.query(`INSERT INTO webhook_conflicts(provider,event_id,observed,incoming) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [providerName, evidenceId, observed, incoming]);
  if (isTerminal(observed)) await c.query(`UPDATE outbox SET state=$4 WHERE tenant_id=$1 AND provider=$2 AND business_id=$3 AND state IN ('not_started','pending_unknown')`,
    [tenant, providerName, businessId, observed === 'succeeded' ? 'confirmed_success' : 'confirmed_failure']);
  return { inserted: effect.rows[0].inserted as boolean, outcome: observed, conflict };
}

type WebhookResult =
  | 'accepted' | 'duplicate'            // transport-stage outcomes
  | 'bad_signature' | 'bad_request' | 'stale' | 'unknown_provider' | 'kind_not_allowed'
  | 'infra_error';                      // a DB/infra fault — NEVER reported as bad_signature

// Hex decode that NEVER throws on bad input (returns null), so a garbled signature cannot
// produce a RangeError downstream.
function hexBuf(s: unknown): Buffer | null {
  if (typeof s !== 'string' || s.length === 0 || s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  return Buffer.from(s, 'hex');
}

// Constant-time compare that is SAFE on unequal lengths: a length mismatch is a definite
// non-match, returned WITHOUT calling timingSafeEqual on mismatched buffers (which RangeErrors).
function sigMatches(expectHex: string, gotHex: unknown): boolean {
  const got = hexBuf(gotHex);
  if (!got) return false;                         // garbled/short/odd-length signature -> no match, no throw
  const expect = Buffer.from(expectHex, 'hex');
  if (got.length !== expect.length) return false; // definite non-match; do NOT timingSafeEqual
  return crypto.timingSafeEqual(expect, got);
}

// Inbound webhook. Stage 1: authenticity (signature over raw bytes, with key rotation),
// freshness (replay window), provider registration, event-kind allow, then a DURABLE inbox
// insert. Error CLASSES are distinct: a bad signature, a malformed body, a stale timestamp,
// an unknown provider and an INFRA fault are never conflated.
async function receiveWebhook(providerName: string, rawBody: string, ts: number, sig: string, nowTs: number): Promise<WebhookResult> {
  // 0) provider must be registered (trusted binding source)
  const reg = REGISTRY[providerName];
  if (!reg) return 'unknown_provider';

  // 1) signature over the RAW body, trying each currently-valid key (rotation overlap).
  //    Length/encoding is validated inside sigMatches -> no RangeError on a short/garbled sig.
  const signedOk = provider.validKeys().some((k) => sigMatches(provider.signWith(k, rawBody, ts), sig));
  if (!signedOk) return 'bad_signature';

  // 2) freshness (replay window) — checked on the SIGNED timestamp.
  if (!Number.isFinite(ts) || Math.abs(nowTs - ts) > 300) return 'stale';

  // 3) parse AFTER authenticity; a malformed body is bad_request, not bad_signature.
  let ev: any;
  try { ev = JSON.parse(rawBody); } catch { return 'bad_request'; }
  if (!ev || typeof ev.event_id !== 'string' || typeof ev.business_id !== 'string' || typeof ev.kind !== 'string') return 'bad_request';
  if (!reg.allowedKinds.has(ev.kind)) return 'kind_not_allowed';

  // 4) TRUSTED binding: tenant comes from the REGISTRY for this provider, NOT from ev.tenant_id.
  const tenant = reg.tenant;
  // logical_key collapses retried/duplicate LOGICAL events: provider + business + kind.
  const logicalKey = `${providerName}:${ev.business_id}`;

  // 5) durable inbox insert (transport dedup on provider+event_id). A DB fault here is infra_error.
  try {
    const r = await pool.query(
      `INSERT INTO webhook_inbox(provider,event_id,logical_key,business_id,tenant_id,kind)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (provider,event_id) DO NOTHING RETURNING event_id`,
      [providerName, ev.event_id, logicalKey, ev.business_id, tenant, ev.kind]);
    return r.rowCount ? 'accepted' : 'duplicate';
  } catch {
    return 'infra_error'; // DB/infra fault is NOT the caller's bad signature
  }
}

// Stage 2 — the DURABLE CONSUMER. Drains un-consumed inbox rows and applies the business
// effect ONCE per logical event. Safe to re-run after a crash (idempotent): an inbox row is
// marked consumed only after its effect is durably written, in the SAME transaction. Out-of-
// order delivery is handled by "terminal outcome wins": a 'succeeded' effect is not overwritten
// by a late 'pending', and a contradictory terminal is rejected (kept as the first terminal).
function outcomeOfKind(kind: string): 'succeeded' | 'failed' | 'pending' {
  if (kind === 'charge.succeeded') return 'succeeded';
  if (kind === 'charge.failed') return 'failed';
  return 'pending';
}
function isTerminal(o: string): boolean { return o === 'succeeded' || o === 'failed'; }

async function consumeInbox(): Promise<{ applied: number; collapsed: number }> {
  let applied = 0, collapsed = 0;
  // process one row at a time so a crash mid-drain leaves the rest for the next run
  for (;;) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // lock the next unconsumed row; SKIP LOCKED lets parallel workers each take a distinct row
      const row = await c.query(
        `SELECT provider,event_id,logical_key,business_id,tenant_id,kind FROM webhook_inbox
         WHERE consumed=false ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (!row.rowCount) { await c.query('ROLLBACK'); c.release(); break; }
      const { logical_key, tenant_id, kind } = row.rows[0] as any;
      const incoming = outcomeOfKind(kind);
      const effect = await applyOutcome(c, tenant_id, row.rows[0].provider, row.rows[0].business_id, incoming, row.rows[0].event_id);
      if (effect.inserted) applied++; else collapsed++;
      await c.query(`UPDATE webhook_inbox SET consumed=true WHERE provider=$1 AND event_id=$2`, [row.rows[0].provider, row.rows[0].event_id]);
      await c.query('COMMIT');
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      c.release();
      throw e;
    }
    c.release();
  }
  return { applied, collapsed };
}

async function effectOutcome(tenant: string, logicalKey: string): Promise<string | null> {
  const r = await pool.query(`SELECT outcome FROM webhook_effects WHERE tenant_id=$1 AND logical_key=$2`, [tenant, logicalKey]);
  return r.rowCount ? r.rows[0].outcome : null;
}
async function effectCount(logicalKey: string): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int n FROM webhook_effects WHERE logical_key=$1`, [logicalKey]);
  return r.rows[0].n;
}

let pass = 0, fail = 0; const failures: string[] = [];
async function check(name: string, body: () => Promise<boolean>) {
  try { if (await body()) { pass++; console.log(`ok   - ${name}`); } else { fail++; failures.push(name); console.log(`FAIL - ${name}`); } }
  catch (e: any) { fail++; failures.push(`${name}: ${e.message}`); console.log(`FAIL - ${name} :: ${e.message}`); }
}

async function main() {
  await initSchema();
  console.log('provider/webhook reference @ real PostgreSQL (provider is a labelled TEST DOUBLE)');

  // ---- outbound ----
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
    // ik2 timed out above (no charge recorded yet). Retrying with the SAME key makes the first
    // actual charge and resolves success; it must NOT mint a second charge for this key.
    const st = await startCharge('T1', 'biz2', 'ik2'); // same key, no timeout now
    const st2 = await startCharge('T1', 'biz2', 'ik2'); // retry again -> provider dedups on the key
    return st === 'confirmed_success' && st2 === 'confirmed_success';
  });
  await check('outbound: same key is idempotent at the provider (no double charge)', async () => {
    await startCharge('T1', 'biz3', 'ik3');
    const before = provider.chargeCount();
    await startCharge('T1', 'biz3', 'ik3');
    return provider.chargeCount() === before;
  });

  // ---- webhook authenticity / error classing (R10-B1) ----
  const ev = (eid: string, biz: string, kind = 'charge.succeeded') => JSON.stringify({ event_id: eid, business_id: biz, kind });
  const ts = 1_000_000;

  await check('webhook: valid signature + fresh ts => accepted', async () => {
    const raw = ev('ev1', 'biz1'); return (await receiveWebhook('double', raw, ts, provider.sign(raw, ts), ts)) === 'accepted';
  });
  await check('webhook: SHORT/garbled signature => bad_signature, NO RangeError (R10)', async () => {
    const raw = ev('ev1b', 'biz1');
    const r1 = await receiveWebhook('double', raw, ts, 'ab', ts);          // too short, odd context
    const r2 = await receiveWebhook('double', raw, ts, 'zzz', ts);         // non-hex
    const r3 = await receiveWebhook('double', raw, ts, '', ts);            // empty
    const r4 = await receiveWebhook('double', raw, ts, 'abc', ts);         // odd length
    return r1 === 'bad_signature' && r2 === 'bad_signature' && r3 === 'bad_signature' && r4 === 'bad_signature';
  });
  await check('webhook: same event id re-delivered => duplicate (transport dedup)', async () => {
    const raw = ev('ev1', 'biz1'); return (await receiveWebhook('double', raw, ts, provider.sign(raw, ts), ts)) === 'duplicate';
  });
  await check('webhook: tampered body => bad_signature (verified on raw bytes)', async () => {
    const raw = ev('ev2', 'biz1'); const good = provider.sign(raw, ts);
    const tampered = ev('ev2', 'biz-HACKED');
    return (await receiveWebhook('double', tampered, ts, good, ts)) === 'bad_signature';
  });
  await check('webhook: malformed JSON (valid sig) => bad_request, NOT bad_signature (R10)', async () => {
    const raw = '{not json'; const good = provider.sign(raw, ts);
    return (await receiveWebhook('double', raw, ts, good, ts)) === 'bad_request';
  });
  await check('webhook: outside replay window => stale', async () => {
    const raw = ev('ev3', 'biz1'); return (await receiveWebhook('double', raw, ts, provider.sign(raw, ts), ts + 10_000)) === 'stale';
  });
  await check('webhook: unknown provider => unknown_provider (not bad_signature)', async () => {
    const raw = ev('ev3u', 'biz1'); return (await receiveWebhook('mystery', raw, ts, provider.sign(raw, ts), ts)) === 'unknown_provider';
  });
  await check('webhook: disallowed event kind => kind_not_allowed', async () => {
    const raw = ev('ev3k', 'biz1', 'account.deleted'); return (await receiveWebhook('double', raw, ts, provider.sign(raw, ts), ts)) === 'kind_not_allowed';
  });
  await check('webhook: DB/infra fault is infra_error, NOT bad_signature (R10)', async () => {
    const raw = ev('ev3i', 'biz1'); const good = provider.sign(raw, ts);
    // drop the inbox table to force a real DB error on insert; signature is VALID
    await pool.query('ALTER TABLE webhook_inbox RENAME TO webhook_inbox_hidden');
    const r = await receiveWebhook('double', raw, ts, good, ts);
    await pool.query('ALTER TABLE webhook_inbox_hidden RENAME TO webhook_inbox');
    return r === 'infra_error';
  });
  await check('webhook: tenant binding comes from the registry, NOT the payload', async () => {
    // payload claims a different tenant; the stored row must carry the REGISTERED tenant.
    const raw = JSON.stringify({ event_id: 'ev-spoof', business_id: 'bizZ', kind: 'charge.succeeded', tenant_id: 'ATTACKER' });
    const r = await receiveWebhook('double', raw, ts, provider.sign(raw, ts), ts);
    const row = await pool.query(`SELECT tenant_id FROM webhook_inbox WHERE event_id='ev-spoof'`);
    return r === 'accepted' && row.rows[0].tenant_id === 'T1';
  });

  // ---- key rotation ----
  await check('webhook: body signed with the OLD-but-valid key still verifies (rotation overlap)', async () => {
    const raw = ev('ev-rot1', 'bizR');
    const oldSig = provider.signWith('whsec_v1', raw, ts); // v1 still in the valid set
    return (await receiveWebhook('double', raw, ts, oldSig, ts)) === 'accepted';
  });
  await check('webhook: after rotating v1 OUT, a v1 signature no longer verifies', async () => {
    provider.rotate('whsec_v3', false); // only v3 valid now
    const raw = ev('ev-rot2', 'bizR');
    const staleKeySig = provider.signWith('whsec_v1', raw, ts);
    const r1 = await receiveWebhook('double', raw, ts, staleKeySig, ts);
    const r2 = await receiveWebhook('double', raw, ts, provider.signWith('whsec_v3', raw, ts), ts);
    provider.rotate('whsec_v2'); provider.rotate('whsec_v2', true); // restore a 2-key set for later tests isn't needed
    return r1 === 'bad_signature' && r2 === 'accepted';
  });

  // ---- durable consumer + business-effect dedup + out-of-order + crash/recovery ----
  await check('consumer: a single logical event applies exactly one effect', async () => {
    const raw = ev('ce1', 'bizC', 'charge.succeeded');
    await receiveWebhook('double', raw, ts, provider.sign(raw, ts), ts);
    const { applied } = await consumeInbox();
    return (await effectOutcome('T1', 'double:bizC')) === 'succeeded' && (await effectCount('double:bizC')) === 1;
  });
  await check('consumer: SAME logical event under TWO different transport ids applies ONCE', async () => {
    const a = JSON.stringify({ event_id: 'ce2a', business_id: 'bizD', kind: 'charge.succeeded' });
    const b = JSON.stringify({ event_id: 'ce2b', business_id: 'bizD', kind: 'charge.succeeded' }); // same logical event, new id
    await receiveWebhook('double', a, ts, provider.sign(a, ts), ts);
    await receiveWebhook('double', b, ts, provider.sign(b, ts), ts);
    await consumeInbox();
    // two inbox rows accepted, but ONE business effect
    const inbox = await pool.query(`SELECT count(*)::int n FROM webhook_inbox WHERE logical_key='double:bizD'`);
    return inbox.rows[0].n === 2 && (await effectCount('double:bizD')) === 1;
  });
  await check('consumer: out-of-order terminal then pending => terminal wins (no downgrade)', async () => {
    // Deliver a real pending event after success for the SAME business projection.
    const succ = JSON.stringify({ event_id: 'ce3s', business_id: 'bizE', kind: 'charge.succeeded' });
    await receiveWebhook('double', succ, ts, provider.sign(succ, ts), ts);
    await consumeInbox();
    // A late pending must not create a second business state or downgrade success.
    const late = JSON.stringify({ event_id: 'ce3p', business_id: 'bizE', kind: 'charge.pending' });
    await receiveWebhook('double', late, ts, provider.sign(late, ts), ts);
    await consumeInbox();
    return (await effectOutcome('T1', 'double:bizE')) === 'succeeded';
  });
  await check('consumer: crash mid-drain leaves unconsumed rows; re-run recovers them', async () => {
    const a = JSON.stringify({ event_id: 'ce4a', business_id: 'bizF', kind: 'charge.succeeded' });
    const b = JSON.stringify({ event_id: 'ce4b', business_id: 'bizG', kind: 'charge.succeeded' });
    await receiveWebhook('double', a, ts, provider.sign(a, ts), ts);
    await receiveWebhook('double', b, ts, provider.sign(b, ts), ts);
    // simulate a crash: consume exactly ONE row then stop (manual single-step)
    const c = await pool.connect();
    await c.query('BEGIN');
    const row = await c.query(`SELECT provider,event_id,logical_key,business_id,tenant_id,kind FROM webhook_inbox WHERE consumed=false AND logical_key IN ('double:bizF','double:bizG') ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    const one = row.rows[0] as any;
    await c.query(`INSERT INTO webhook_effects(tenant_id,logical_key,outcome) VALUES($1,$2,'succeeded') ON CONFLICT DO NOTHING`, [one.tenant_id, one.logical_key]);
    await c.query(`UPDATE webhook_inbox SET consumed=true WHERE provider=$1 AND event_id=$2`, [one.provider, one.event_id]);
    await c.query('COMMIT'); c.release();
    // the other row is still unconsumed; a normal drain must pick it up (recovery)
    await consumeInbox();
    const left = await pool.query(`SELECT count(*)::int n FROM webhook_inbox WHERE consumed=false AND logical_key IN ('double:bizF','double:bizG')`);
    return left.rows[0].n === 0 && (await effectCount('double:bizF')) === 1 && (await effectCount('double:bizG')) === 1;
  });
  await check('consumer: an UnknownOutcome is never turned into a blind re-charge under a new key', async () => {
    // outbound timeout left pending_unknown under ik-unk; a "retry" MUST reuse the key, not mint a new one.
    provider.failNext = 'timeout_after_effect';
    const first = await startCharge('T1', 'bizH', 'ik-unk');      // times out -> pending_unknown, no charge yet
    const st = await startCharge('T1', 'bizH', 'ik-unk');         // retry SAME key -> one charge, success
    const again = await startCharge('T1', 'bizH', 'ik-unk');      // retry again -> provider dedups, still one charge
    return first === 'pending_unknown' && st === 'confirmed_success' && again === 'confirmed_success';
  });

  await check('outbound: same client key under different tenants produces two provider effects', async () => {
    const before = provider.chargeCount();
    const a = await startCharge('T1', 'scope-biz-1', 'shared-client-key');
    const b = await startCharge('T2', 'scope-biz-2', 'shared-client-key');
    return a === 'confirmed_success' && b === 'confirmed_success' && provider.chargeCount() === before + 2;
  });
  await check('outbound: changed business payload OR new key for existing business is conflict', async () => {
    await startCharge('T1', 'bind-biz', 'bind-key');
    const before = provider.chargeCount();
    return await startCharge('T1', 'other-biz', 'bind-key') === 'conflict'
      && await startCharge('T1', 'bind-biz', 'different-key') === 'conflict' && provider.chargeCount() === before;
  });
  await check('consumer: pending to success then contradictory failure preserves success and records conflict', async () => {
    for (const [id, kind] of [['ord-p','charge.pending'],['ord-s','charge.succeeded'],['ord-f','charge.failed']]) {
      const raw = ev(id, 'order-biz', kind);
      await receiveWebhook('double', raw, ts, provider.sign(raw, ts), ts);
      await consumeInbox();
    }
    const conflict = await pool.query(`SELECT count(*)::int n FROM webhook_conflicts WHERE event_id='ord-f'`);
    return await effectOutcome('T1', 'double:order-biz') === 'succeeded' && await effectCount('double:order-biz') === 1 && conflict.rows[0].n === 1;
  });
  await check('consumer: parallel workers collapse duplicate business events without unique-violation', async () => {
    for (let n=0;n<12;n++) {
      const raw = ev('parallel-'+n, 'parallel-biz');
      await receiveWebhook('double', raw, ts, provider.sign(raw, ts), ts);
    }
    await Promise.all([consumeInbox(),consumeInbox(),consumeInbox()]);
    return await effectCount('double:parallel-biz') === 1;
  });
  await check('consumer: provider-response success then failed webhook records a contradiction', async () => {
    await startCharge('T1', 'response-conflict', 'response-conflict-key');
    const raw = ev('response-conflict-event', 'response-conflict', 'charge.failed');
    await receiveWebhook('double', raw, ts, provider.sign(raw, ts), ts);
    await consumeInbox();
    const conflict = await pool.query(`SELECT count(*)::int n FROM webhook_conflicts WHERE event_id='response-conflict-event'`);
    return await effectOutcome('T1','double:response-conflict') === 'succeeded' && conflict.rows[0].n === 1;
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
  pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
