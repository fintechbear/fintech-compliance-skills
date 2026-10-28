// FAILING-FIRST probe for R12 (retention hold/erase TOCTOU over-deletion).
// Loads the BASE (654018e) retention.ts with main() stripped (function bodies verbatim),
// seeds ONE erasable record, then runs the base eraseRequest while deterministically
// placing a legal hold in the window BETWEEN the base code's SELECT and its unconditional
// UPDATE erased=true. If the base erases an actively-held record, the bug is reproduced.
//
// The timing hook wraps pool.query to fire our hold exactly once, right after the base's
// SELECT returns and before its UPDATE runs. The base LOGIC is unchanged — only the
// interleaving is made deterministic (a standard race-probe technique, not a rewrite).
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import pg from 'pg';

const BL = process.env.BL!;
const PGCONN = process.env.PGCONN!;
const src = fs.readFileSync(path.join(BL, 'retention.ts'), 'utf8');

// Strip the auto-run and re-export what we need. We must also reach the base's own `pool`
// so we can hook it; the base declares `const pool = new Pool(...)` at top level, so we
// append an export of it.
let patched = src.replace(/main\(\)\.catch\([\s\S]*$/, '');
patched += `\nexport { eraseRequest, seed, initSchema, pool };\n`;
const tmp = path.join(BL, '_probe_retention_base.ts');
fs.writeFileSync(tmp, patched, 'utf8');

const mod: any = await import(url.pathToFileURL(tmp).href);
const { eraseRequest, seed, initSchema, pool } = mod;

// A SECOND independent connection to place the hold mid-flight.
const holder = new pg.Pool({ connectionString: PGCONN, max: 2 });

await initSchema();
await seed('toctou', 'SUB', 'marketing_profile', 5); // erasable, no hold

// Hook the base pool.query: the FIRST time we see the base's SELECT of this subject's
// records, we place a legal hold on the row before letting the base proceed to its UPDATE.
const origQuery = pool.query.bind(pool);
let injected = false;
pool.query = (async (...args: any[]) => {
  const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
  const isSelectForErase = typeof text === 'string' && /SELECT[\s\S]*FROM records WHERE subject_id/i.test(text);
  const res = await origQuery(...args);
  if (isSelectForErase && !injected) {
    injected = true;
    // base has now READ legal_hold=false; place the hold BEFORE its UPDATE runs.
    await holder.query(`UPDATE records SET legal_hold=true WHERE id='toctou'`);
  }
  return res;
}) as any;

await eraseRequest('SUB');

const row = (await holder.query(`SELECT legal_hold, erased FROM records WHERE id='toctou'`)).rows[0];
const reproduced = row.legal_hold === true && row.erased === true; // held AND erased = the bug
console.log(`  [r12] after race: legal_hold=${row.legal_hold} erased=${row.erased} injected=${injected}`);

fs.rmSync(tmp, { force: true });
await holder.end().catch(() => {});
await origQuery('SELECT 1').catch(() => {});
pool.end?.().catch?.(() => {});
process.exit(reproduced ? 0 : 1);
