// Fintech retention/erasure reference on REAL PostgreSQL. Exercises FCS-RETAIN-001 (retention
// is per data category by legal basis: mandatory financial retention vs active legal hold vs
// erasable profile data — no single blanket rule) and FCS-ERASE-001 (over-retention AND
// over-deletion are both failures, checked separately; crypto-shredding is a technique, not a
// universal legal erasure guarantee). All DURATIONS here are DEMO values, NOT cited regulation.
import crypto from 'node:crypto';
import pg from 'pg';
const { Pool } = pg;

const PGCONN = process.env.PGCONN ?? 'postgresql://fcs:fcs@127.0.0.1:55443/fcs';
const pool = new Pool({ connectionString: PGCONN, max: 8 });

// Legal basis per category. retain_days is a DEMO minimum, not a cited law.
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
    // age_days = how old the record is now (demo clock). legal_hold freezes deletion.
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

type EraseDecision = 'erased' | 'kept_mandatory_retention' | 'kept_legal_hold' | 'kept_unknown_category';

// A subject's erasure request. Decide PER record by its category's legal basis (FCS-RETAIN-001):
// legal hold wins over everything; mandatory financial records are kept until retention expires;
// erasable profile data is erased.
async function eraseRequest(subject: string): Promise<Record<EraseDecision, number>> {
  const out: Record<EraseDecision, number> = { erased: 0, kept_mandatory_retention: 0, kept_legal_hold: 0, kept_unknown_category: 0 };
  const rows = await pool.query(`SELECT id, category, age_days, legal_hold FROM records WHERE subject_id=$1 AND erased=false`, [subject]);
  for (const r of rows.rows) {
    if (r.legal_hold) { out.kept_legal_hold++; continue; }                       // hold wins
    const cat = CATEGORY[r.category];
    if (!cat) { out.kept_unknown_category++; continue; }                         // unknown => do not blindly delete
    if (cat.basis === 'mandatory_financial' && r.age_days < cat.retainDays) {    // still within required retention
      out.kept_mandatory_retention++; continue;
    }
    await cryptoShred(r.id);                                                     // erasable (or retention expired)
    out.erased++;
  }
  return out;
}

// Crypto-shredding: mark erased by destroying the key (modelled). It is a TECHNIQUE; whether a
// regulator accepts it as erasure is jurisdiction-specific — we never claim universal legal erasure.
async function cryptoShred(id: string) {
  const keyId = 'k_' + crypto.randomBytes(4).toString('hex');
  await pool.query(`UPDATE records SET erased=true, erase_method=$2 WHERE id=$1`, [id, `crypto_shred:${keyId}_destroyed`]);
}

// A retention SWEEP removes erasable data kept past its basis (over-retention side of FCS-ERASE-001).
// It must NOT touch mandatory-retention-in-window data or legal holds (that would be over-deletion).
async function retentionSweep(): Promise<{ swept: number }> {
  const rows = await pool.query(`SELECT id, category, age_days, legal_hold FROM records WHERE erased=false`);
  let swept = 0;
  for (const r of rows.rows) {
    if (r.legal_hold) continue;
    const cat = CATEGORY[r.category];
    if (!cat) continue;
    const expired = r.age_days >= cat.retainDays; // erasable_profile retainDays=0 => always expired
    if (expired) { await cryptoShred(r.id); swept++; }
  }
  return { swept };
}

// Detective checks (FCS-ERASE-001), computed independently of the actions above.
async function overRetained(): Promise<number> {
  // erasable data still present past its (zero) retention basis
  const r = await pool.query(`SELECT id, category, age_days, legal_hold FROM records WHERE erased=false`);
  return r.rows.filter((x) => { const c = CATEGORY[x.category]; return c && c.basis === 'erasable_profile' && !x.legal_hold && x.age_days >= c.retainDays; }).length;
}
async function overDeleted(): Promise<number> {
  // anything erased while it was mandatory-in-window or under legal hold
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
    await seed('r2', 'S1', 'transaction_record', 10); // well within retention
    const d = await eraseRequest('S1');
    return d.erased === 1 && d.kept_mandatory_retention === 1;
  });

  await check('erase: a legal hold blocks deletion even for otherwise-erasable data', async () => {
    await seed('r3', 'S2', 'marketing_profile', 100, true); // hold
    const d = await eraseRequest('S2');
    return d.kept_legal_hold === 1 && d.erased === 0;
  });

  await check('erase: an expired mandatory record IS erasable (retention lapsed)', async () => {
    await seed('r4', 'S3', 'kyc_record', 2000); // > 1825 demo retention
    const d = await eraseRequest('S3');
    return d.erased === 1;
  });

  await check('erase: an unknown category is NOT blindly deleted', async () => {
    await seed('r5', 'S4', 'mystery_category', 9999);
    const d = await eraseRequest('S4');
    return d.kept_unknown_category === 1 && d.erased === 0;
  });

  await check('sweep: over-retained profile data is removed; mandatory-in-window is not', async () => {
    await seed('r6', 'S5', 'support_note', 500);        // erasable, retention 0 => over-retained
    await seed('r7', 'S5', 'transaction_record', 100);  // mandatory, in window
    const before = await overRetained();
    const { swept } = await retentionSweep();
    const after = await overRetained();
    return before >= 1 && swept >= 1 && after === 0 && (await overDeleted()) === 0;
  });

  await check('check: over-retention and over-deletion are measured separately', async () => {
    // Nothing illegally deleted anywhere so far in this record set.
    return (await overDeleted()) === 0;
  });

  await check('crypto-shred: records an erase METHOD, never claimed as universal legal erasure', async () => {
    await seed('r8', 'S6', 'marketing_profile', 5);
    await eraseRequest('S6');
    const m = await pool.query(`SELECT erase_method FROM records WHERE id='r8'`);
    // method is recorded and labelled as crypto-shred; it is a technique, not a legal guarantee.
    return /^crypto_shred:/.test(m.rows[0].erase_method) && !/legal|guaranteed|compliant/i.test(m.rows[0].erase_method);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
  pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
