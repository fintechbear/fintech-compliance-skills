// FAILING-FIRST probe for R02 (TS stack has NO object-level authorization).
// The BASE (654018e) bank.ts transfer() signature is (pool, tenant, operation, key, req) —
// there is no actor parameter and no account_grants table at all. So ANY caller who can name
// the tenant can debit the source account: there is no object authority to satisfy. This probe
// posts a transfer against the base with no grant in existence and asserts it POSTS (the bug:
// authorization is absent). The fixed code requires an actor to hold a debit grant.
import path from 'node:path';
import url from 'node:url';
import pg from 'pg';

const BL = process.env.BL!;
const PGCONN = process.env.PGCONN!;

const bank: any = await import(url.pathToFileURL(path.join(BL, 'bank.ts')).href);

const pool = new pg.Pool({ connectionString: PGCONN, max: 4 });
await bank.initSchema(pool);
await bank.seedAccount(pool, 'T1', 'A', 'USD', 1000);
await bank.seedAccount(pool, 'T1', 'B', 'USD', 0);

// base transfer takes NO actor; there is no grant table — nothing authorizes this debit.
const res = await bank.transfer(pool, 'T1', 'op', 'k1', { src: 'A', dst: 'B', amount: '1.00', currency: 'USD' });
const moved = (await bank.balance(pool, 'T1', 'B')) === 100;

// bug reproduced: the transfer posts with no object-authority check possible.
const reproduced = res.outcome === 'posted' && moved;
console.log(`  [r02] base transfer with no authorization outcome=${res.outcome} B=${await bank.balance(pool, 'T1', 'B')} (bug: no object authority)`);

await pool.end().catch(() => {});
process.exit(reproduced ? 0 : 1);
