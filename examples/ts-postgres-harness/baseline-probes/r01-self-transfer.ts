// FAILING-FIRST probe for R01 (self-transfer loses credit on an optimistic-version ledger).
// Loads the BASE (654018e) bank.ts (its transfer() is EXPORTED in the base, so no patch is
// needed) and runs a self-transfer A->A on real PostgreSQL. The base has no same_account guard
// and no per-UPDATE rowCount check, so the debit bumps the version and the credit matches 0
// rows: the result is 'posted' while the balance DROPS. Exits 0 only if that bug is reproduced.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import pg from 'pg';

const BL = process.env.BL!;
const PGCONN = process.env.PGCONN!;

// bank.ts at base exports transfer/initSchema/seedAccount/balance already; import directly.
const bankUrl = url.pathToFileURL(path.join(BL, 'bank.ts')).href;
const bank: any = await import(bankUrl);

const pool = new pg.Pool({ connectionString: PGCONN, max: 4 });
await bank.initSchema(pool);
await bank.seedAccount(pool, 'T1', 'A', 'USD', 1000); // 1000 minor

const before = await bank.balance(pool, 'T1', 'A');
const res = await bank.transfer(pool, 'T1', 'op', 'k1', { src: 'A', dst: 'A', amount: '9.00', currency: 'USD' });
const after = await bank.balance(pool, 'T1', 'A');

// base bug: outcome 'posted' AND balance decreased (credit lost). 900 == 1000 - 900(minor of 9.00).
const reproduced = res.outcome === 'posted' && Number(after) < Number(before);
console.log(`  [r01] base self-transfer outcome=${res.outcome} before=${before} after=${after}`);

await pool.end().catch(() => {});
process.exit(reproduced ? 0 : 1);
