// FAILING-FIRST probe for AUD-20261102-F10 (cancel/capture lifecycle race).
// Loads the BASE refund.ts with main() stripped (bodies verbatim). On real PostgreSQL, a holder
// connection captures the payment inside an open transaction (holds the row lock). The base
// cancel() does SELECT lifecycle (sees the committed 'authorized'), then an UNCONDITIONAL UPDATE
// that blocks on the lock. A deterministic barrier (pg_stat_activity lock wait, no sleep) waits
// until that UPDATE is blocked, then the holder commits the capture. The base UPDATE then
// proceeds and overwrites captured -> voided. Exits 0 only if that regression is observed.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import pg from 'pg';

const BL = process.env.BL!;
const PGCONN = process.env.PGCONN!;
const src = fs.readFileSync(path.join(BL, 'refund.ts'), 'utf8');
if (!/async function cancel\(/.test(src)) { console.log('  [f10] base has no cancel(); finding not present at base'); process.exit(1); }

let patched = src.replace(/main\(\)\.catch\([\s\S]*$/, '');
patched += `\nexport { cancel, seedPayment, initSchema, pool };\n`;
const tmp = path.join(BL, '_probe_cancel_base.ts');
fs.writeFileSync(tmp, patched, 'utf8');

const mod: any = await import(url.pathToFileURL(tmp).href);
const { cancel, seedPayment, initSchema, pool } = mod;

await initSchema();
await seedPayment('race', 'T1', 1000, 'authorized');

const admin = new pg.Client({ connectionString: PGCONN }); await admin.connect();
const holder = new pg.Client({ connectionString: PGCONN }); await holder.connect();
await holder.query('BEGIN');
await holder.query(`UPDATE payments SET lifecycle='captured' WHERE id='race' AND tenant_id='T1' AND lifecycle='authorized'`);

const pending = cancel('race', 'T1').then(() => 'voided', (e: Error) => 'threw:' + e.message);

const deadline = Date.now() + 10000;
for (;;) {
  const r = await admin.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%lifecycle=''voided''%'`);
  if (r.rowCount) break;
  if (Date.now() > deadline) { console.log('  [f10] barrier timeout: base cancel never blocked'); process.exit(1); }
  await new Promise((res) => setImmediate(res));
}
await holder.query('COMMIT');
const outcome = await pending;
const s = await admin.query(`SELECT lifecycle FROM payments WHERE id='race' AND tenant_id='T1'`);
const finalState = s.rows[0].lifecycle;

// base bug: cancel reports success AND the committed capture is overwritten to voided.
const reproduced = outcome === 'voided' && finalState === 'voided';
console.log(`  [f10] base cancel=${outcome} final=${finalState} (bug if a committed capture became voided)`);

await holder.end(); await admin.end(); await pool.end().catch(() => {});
fs.rmSync(tmp, { force: true });
process.exit(reproduced ? 0 : 1);
