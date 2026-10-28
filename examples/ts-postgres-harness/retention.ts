// Fintech retention/erasure reference on REAL PostgreSQL. Exercises FCS-RETAIN-001 (retention
// is per data category by legal basis: mandatory financial retention vs active legal hold vs
// erasable profile data — no single blanket rule) and FCS-ERASE-001 (over-retention AND
// over-deletion are both failures, checked separately; crypto-shredding is a TECHNIQUE, not a
// universal legal-erasure guarantee). All DURATIONS here are DEMO values, NOT cited regulation,
// and "erased" is a MODELLED key-destruction marker, not a claim of legally-sufficient erasure.
//
// R12 (new finding) — hold/erase race: the destructive write MUST be linearized with the hold
// decision. The old code read legal_hold=false, then issued an UNCONDITIONAL `UPDATE ... WHERE
// id=$1 SET erased=true`; if a hold was placed in between, an actively-held record was erased.
// The fix locks the record row (FOR UPDATE) and re-checks the hold INSIDE the same transaction,
// and the destructive UPDATE is itself CONDITIONAL (`WHERE id=$1 AND legal_hold=false AND
// erased=false`) so even without the lock it can never erase a held/already-erased row.
import crypto from 'node:crypto';
import pg from 'pg';
const { Pool } = pg;

const PGCONN = process.env.PGCONN ?? 'postgresql://fcs:fcs@127.0.0.1:55443/fcs';
const pool = new Pool({ connectionString: PGCONN, max: 8 });

type Basis = 'mandatory_financial' | 'erasable_profile';
const CATEGORY: Record<string, { basis: Basis; retainDays: number }> = {
  transaction_record: { basis: 'mandatory_financial', retainDays: 3650 }, // demo: long financial retention
  kyc_record:         { basis: 'mandatory_financial', retainDays: 1825 }, // demo
  marketing_profile:  { basis: 'erasable_profile',    retainDays: 0 },    // erasable on request
  support_note:       { basis: 'erasable_profile',    retainDays: 0 },    // erasable on request
};

async function initSchema() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DROP TABLE IF EXISTS records CASCADE');
    await c.query(`CREATE TABLE records(
      id text PRIMARY KEY, subject_id text NOT NULL, category text NOT NULL,
      age_days int NOT NULL, legal_hold boolean NOT NULL DEFAULT false,
      erased boolean NOT NULL DEFAULT false, erase_method text NULL)`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

async function seed(id: string, subject: string, category: string, ageDays: number, legalHold = false) {
  await pool.query(`INSERT INTO records(id,subject_id,category,age_days,legal_hold) VALUES($1,$2,$3,$4,$5)`,
    [id, subject, category, ageDays, legalHold]);
}

type EraseDecision = 'erased' | 'kept_mandatory_retention' | 'kept_legal_hold' | 'kept_unknown_category' | 'kept_raced_hold';

// Place a legal hold. To make the hold-vs-erase ordering EXPLICIT (linearizable), a hold is set
// with a conditional UPDATE guarded on erased=false: you cannot "hold" an already-erased record,
// and the erase path (below) is guarded on legal_hold=false — the two conditional writes race on
// the same row and exactly one wins, deterministically, under the row lock.
async function placeHold(id: string): Promise<'held' | 'too_late_erased'> {
  const r = await pool.query(`UPDATE records SET legal_hold=true WHERE id=$1 AND erased=false`, [id]);
  return r.rowCount === 1 ? 'held' : 'too_late_erased';
}

// crypto_shred inside an EXISTING transaction/connection, as a CONDITIONAL destructive write:
// it erases ONLY if the row is still unheld and unerased. Returns whether it actually erased.
async function shredIfErasable(c: pg.PoolClient, id: string): Promise<boolean> {
  const keyId = 'k_' + crypto.randomBytes(4).toString('hex');
  const r = await c.query(
    `UPDATE records SET erased=true, erase_method=$2 WHERE id=$1 AND legal_hold=false AND erased=false`,
    [id, `crypto_shred:${keyId}_destroyed`]);
  return r.rowCount === 1;
}

// A subject's erasure request. Per record: LOCK the row, re-read the hold INSIDE the tx, decide,
// and perform the destructive write CONDITIONALLY — so a hold placed concurrently is honoured.
async function eraseRequest(subject: string): Promise<Record<EraseDecision, number>> {
  const out: Record<EraseDecision, number> = { erased: 0, kept_mandatory_retention: 0, kept_legal_hold: 0, kept_unknown_category: 0, kept_raced_hold: 0 };
  const ids = (await pool.query(`SELECT id FROM records WHERE subject_id=$1 AND erased=false`, [subject])).rows.map((r) => r.id);
  for (const id of ids) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // Lock the record so a concurrent placeHold serializes against this decision.
      const row = await c.query(`SELECT category, age_days, legal_hold, erased FROM records WHERE id=$1 FOR UPDATE`, [id]);
      if (!row.rowCount) { await c.query('ROLLBACK'); continue; }
      const r = row.rows[0];
      if (r.erased) { await c.query('ROLLBACK'); continue; }
      if (r.legal_hold) { out.kept_legal_hold++; await c.query('COMMIT'); continue; }     // hold wins
      const cat = CATEGORY[r.category];
      if (!cat) { out.kept_unknown_category++; await c.query('COMMIT'); continue; }        // unknown => keep
      if (cat.basis === 'mandatory_financial' && r.age_days < cat.retainDays) {            // still in retention
        out.kept_mandatory_retention++; await c.query('COMMIT'); continue;
      }
      // erasable (or retention lapsed): CONDITIONAL destructive write inside the lock.
      const erased = await shredIfErasable(c, id);
      if (erased) out.erased++; else out.kept_raced_hold++; // a hold slipped in despite the lock: do NOT erase
      await c.query('COMMIT');
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      c.release();
      throw e;
    }
    c.release();
  }
  return out;
}

// A retention SWEEP removes erasable data kept past its basis (over-retention side of FCS-ERASE-001).
// Same discipline: lock the row, re-check hold/erased, conditional destructive write.
async function retentionSweep(): Promise<{ swept: number }> {
  const ids = (await pool.query(`SELECT id FROM records WHERE erased=false`)).rows.map((r) => r.id);
  let swept = 0;
  for (const id of ids) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const row = await c.query(`SELECT category, age_days, legal_hold, erased FROM records WHERE id=$1 FOR UPDATE`, [id]);
      if (!row.rowCount) { await c.query('ROLLBACK'); continue; }
      const r = row.rows[0];
      if (r.erased || r.legal_hold) { await c.query('ROLLBACK'); continue; }
      const cat = CATEGORY[r.category];
      if (!cat) { await c.query('ROLLBACK'); continue; }
      if (r.age_days >= cat.retainDays) { if (await shredIfErasable(c, id)) swept++; }
      await c.query('COMMIT');
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      c.release();
      throw e;
    }
    c.release();
  }
  return { swept };
}

// Detective checks (FCS-ERASE-001), computed independently of the actions above.
async function overRetained(): Promise<number> {
  const r = await pool.query(`SELECT category, age_days, legal_hold FROM records WHERE erased=false`);
  return r.rows.filter((x) => { const c = CATEGORY[x.category]; return c && c.basis === 'erasable_profile' && !x.legal_hold && x.age_days >= c.retainDays; }).length;
}
async function overDeleted(): Promise<number> {
  const r = await pool.query(`SELECT category, age_days, legal_hold FROM records WHERE erased=true`);
  return r.rows.filter((x) => { const c = CATEGORY[x.category]; return x.legal_hold || (c && c.basis === 'mandatory_financial' && x.age_days < c.retainDays); }).length;
}

let pass = 0, fail = 0; const failures: string[] = [];
async function check(name: string, fn: () => Promise<boolean>) {
  try { if (await fn()) { pass++; console.log(`  ok   ${name}`); } else { fail++; failures.push(name); console.log(`  FAIL ${name}`); } }
  catch (e) { fail++; failures.push(`${name} :: ${(e as Error).message}`); console.log(`  FAIL ${name} :: ${(e as Error).message}`); }
}

async function main() {
  await initSchema();
  console.log('retention/erasure reference @ real PostgreSQL (demo durations, not cited law)');

  await check('erase: profile data is erased, mandatory financial record is kept', async () => {
    await seed('r1', 'S1', 'marketing_profile', 10);
    await seed('r2', 'S1', 'transaction_record', 10);
    const d = await eraseRequest('S1');
    return d.erased === 1 && d.kept_mandatory_retention === 1;
  });

  await check('erase: a legal hold blocks deletion even for otherwise-erasable data', async () => {
    await seed('r3', 'S2', 'marketing_profile', 100, true);
    const d = await eraseRequest('S2');
    return d.kept_legal_hold === 1 && d.erased === 0;
  });

  await check('erase: an expired mandatory record IS erasable (retention lapsed)', async () => {
    await seed('r4', 'S3', 'kyc_record', 2000);
    const d = await eraseRequest('S3');
    return d.erased === 1;
  });

  await check('erase: an unknown category is NOT blindly deleted', async () => {
    await seed('r5', 'S4', 'mystery_category', 9999);
    const d = await eraseRequest('S4');
    return d.kept_unknown_category === 1 && d.erased === 0;
  });

  await check('sweep: over-retained profile data is removed; mandatory-in-window is not', async () => {
    await seed('r6', 'S5', 'support_note', 500);
    await seed('r7', 'S5', 'transaction_record', 100);
    const before = await overRetained();
    const { swept } = await retentionSweep();
    const after = await overRetained();
    return before >= 1 && swept >= 1 && after === 0 && (await overDeleted()) === 0;
  });

  await check('check: over-retention and over-deletion are measured separately', async () => {
    return (await overDeleted()) === 0;
  });

  await check('crypto-shred: records an erase METHOD, never claimed as universal legal erasure', async () => {
    await seed('r8', 'S6', 'marketing_profile', 5);
    await eraseRequest('S6');
    const m = await pool.query(`SELECT erase_method FROM records WHERE id='r8'`);
    return /^crypto_shred:/.test(m.rows[0].erase_method) && !/legal|guaranteed|compliant/i.test(m.rows[0].erase_method);
  });

  // ---- R12: hold/erase race, induced with TWO real connections ----
  await check('R12 race: a hold placed concurrently with an erase keeps the record (no over-deletion)', async () => {
    // Run the race many times; the record must NEVER end up erased-while-held.
    let violations = 0, heldKept = 0, erasedFree = 0;
    for (let i = 0; i < 40; i++) {
      const id = `race-${i}`;
      await pool.query(`DELETE FROM records WHERE id=$1`, [id]);
      await seed(id, `RS-${i}`, 'marketing_profile', 5); // erasable
      // fire the hold and the erase at the same time
      const [holdRes, eraseRes] = await Promise.all([placeHold(id), eraseRequest(`RS-${i}`)]);
      const row = (await pool.query(`SELECT legal_hold, erased FROM records WHERE id=$1`, [id])).rows[0];
      // INVARIANT: never both held and erased.
      if (row.legal_hold && row.erased) violations++;
      if (row.legal_hold && !row.erased) heldKept++;
      if (!row.legal_hold && row.erased) erasedFree++;
      void holdRes; void eraseRes;
    }
    console.log(`     [R12] violations=${violations} heldKept=${heldKept} erasedFree=${erasedFree}`);
    return violations === 0 && (heldKept + erasedFree) === 40;
  });

  await check('R12: once erased, a late hold cannot resurrect/claim it (too_late_erased)', async () => {
    await seed('r-late', 'S-late', 'marketing_profile', 5);
    await eraseRequest('S-late');                 // erase first
    const h = await placeHold('r-late');          // hold attempt after erase
    const row = (await pool.query(`SELECT legal_hold, erased FROM records WHERE id='r-late'`)).rows[0];
    return h === 'too_late_erased' && row.erased === true && row.legal_hold === false;
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
  pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
