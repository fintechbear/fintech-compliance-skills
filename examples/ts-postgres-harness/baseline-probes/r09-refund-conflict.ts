// FAILING-FIRST probe for R09 (same idem key + DIFFERENT amount silently replays, not conflict).
// Loads the BASE (654018e) refund.ts with main() stripped (bodies verbatim), seeds a captured
// payment on real PostgreSQL, refunds 500 under a key, then refunds 900 under the SAME key. The
// base keys only on (tenant,payment,key) with NO payload fingerprint, so the second call hits
// the existing row and returns 'replayed' (treating a different amount as the same request).
// Exits 0 only if the base returns 'replayed' (the bug), not a conflict.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import pg from 'pg';

const BL = process.env.BL!;
const PGCONN = process.env.PGCONN!;
const src = fs.readFileSync(path.join(BL, 'refund.ts'), 'utf8');

let patched = src.replace(/main\(\)\.catch\([^;]*\);?\s*$/m, '');
patched += `\nexport { refund, seedPayment, initSchema };\n`;
const tmp = path.join(BL, '_probe_refund_base.ts');
fs.writeFileSync(tmp, patched, 'utf8');

const mod: any = await import(url.pathToFileURL(tmp).href);
const { refund, seedPayment, initSchema } = mod;

await initSchema();
await seedPayment('pp', 'T1', 1000);
const a = await refund('pp', 'T1', 'same-key', 500);
const b = await refund('pp', 'T1', 'same-key', 900); // SAME key, different amount

// base bug: the second (different-amount) call is treated as a replay, not a conflict.
const reproduced = a === 'confirmed' && b === 'replayed';
console.log(`  [r09] base first=${a} second(diff-amount)=${b} (bug if replayed, not conflict)`);

fs.rmSync(tmp, { force: true });
process.exit(reproduced ? 0 : 1);
