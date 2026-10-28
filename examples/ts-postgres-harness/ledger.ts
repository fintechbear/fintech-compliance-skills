// FCS ledger + reconciliation reference on PostgreSQL. Proves FCS-LEDGER-001 (balanced,
// append-only, unique reference, reversal-not-edit) and FCS-RECON-001 (classify
// discrepancies; a discrepancy is a REVIEW flag, not authorization to re-pay).
import pg from 'pg';
const { Pool } = pg;

const PGCONN = process.env.PGCONN ?? 'postgresql://fcs:fcs@127.0.0.1:55443/fcs';
const pool = new Pool({ connectionString: PGCONN, max: 8 });

async function initSchema() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DROP TABLE IF EXISTS ledger_entries, ledger_tx CASCADE');
    // A ledger transaction groups balanced entries; the business_ref is unique (dedup).
    await c.query(`CREATE TABLE ledger_tx(
      id bigserial PRIMARY KEY, business_ref text NOT NULL UNIQUE,
      currency text NOT NULL, kind text NOT NULL, reverses bigint NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    // Entries are append-only (no UPDATE/DELETE in this reference). amount_minor signed:
    // negative = debit, positive = credit; they must net to zero per tx/currency.
    await c.query(`CREATE TABLE ledger_entries(
      id bigserial PRIMARY KEY, tx_id bigint NOT NULL REFERENCES ledger_tx(id),
      account text NOT NULL, currency text NOT NULL, amount_minor bigint NOT NULL)`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

interface Leg { account: string; amountMinor: number | bigint | string; } // signed minor units

// R06: exact money. Legs may be given as number, bigint, or a decimal-free integer string;
// they are normalised to BigInt and ALL arithmetic (sum, balance, reversal) is done in BigInt
// so a set of individually-safe legs whose FLOAT sum rounds to 0 (e.g. [-9e15,-2,9e15,1],
// float-sum 0 but exact -1) can never be mistaken for balanced. Values must fit signed int64
// (the PostgreSQL bigint column); anything outside is rejected, not silently wrapped.
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
function toMinorBigInt(v: number | bigint | string, where: string): bigint {
  let b: bigint;
  if (typeof v === 'bigint') b = v;
  else if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`${where}: amount ${v} is not an integer minor-unit value`);
    if (!Number.isSafeInteger(v)) throw new Error(`${where}: amount ${v} exceeds JS safe-integer range; pass a bigint or string`);
    b = BigInt(v);
  } else {
    if (!/^-?\d+$/.test(v.trim())) throw new Error(`${where}: amount "${v}" is not an integer`);
    b = BigInt(v.trim());
  }
  if (b < INT64_MIN || b > INT64_MAX) throw new Error(`${where}: amount ${b} out of int64 range`);
  return b;
}

// Post a balanced double-entry transaction (FCS-LEDGER-001). Throws if unbalanced or dup ref.
async function post(businessRef: string, currency: string, legs: Leg[], kind = 'normal', reverses: number | bigint | null = null): Promise<number> {
  if (!legs.length) throw new Error('a transaction needs at least one leg');
  const norm = legs.map((l, i) => ({ account: l.account, amount: toMinorBigInt(l.amountMinor, `leg[${i}]`) }));
  const sum = norm.reduce((a, l) => a + l.amount, 0n);   // EXACT BigInt sum
  if (sum !== 0n) throw new Error(`unbalanced: legs sum to ${sum}, must be 0`);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const tx = await c.query('INSERT INTO ledger_tx(business_ref,currency,kind,reverses) VALUES($1,$2,$3,$4) RETURNING id',
      [businessRef, currency, kind, reverses === null ? null : reverses.toString()]);
    const txId = tx.rows[0].id;
    for (const l of norm) {
      // pass the amount as a string so node-postgres binds it to bigint without a float round-trip
      await c.query('INSERT INTO ledger_entries(tx_id,account,currency,amount_minor) VALUES($1,$2,$3,$4)',
        [txId, l.account, currency, l.amount.toString()]);
    }
    await c.query('COMMIT');
    return txId;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// Reverse a posted tx by posting its mirror (FCS-LEDGER-001: correct by reversal, not edit).
async function reverse(originalTxId: number | bigint, businessRef: string): Promise<number> {
  const rows = await pool.query('SELECT account, currency, amount_minor FROM ledger_entries WHERE tx_id=$1', [originalTxId.toString()]);
  const currency = rows.rows[0].currency;
  // amount_minor comes back from pg as a STRING for bigint; negate in BigInt, never via Number().
  const legs: Leg[] = rows.rows.map((r: any) => ({ account: r.account, amountMinor: -BigInt(r.amount_minor) }));
  return post(businessRef, currency, legs, 'reversal', originalTxId);
}

async function balance(account: string, currency: string): Promise<bigint> {
  const r = await pool.query('SELECT COALESCE(SUM(amount_minor),0)::bigint s FROM ledger_entries WHERE account=$1 AND currency=$2', [account, currency]);
  return BigInt(r.rows[0].s); // exact; pg returns bigint SUM as a string
}

// Reconciliation: classify each provider record against internal postings.
type Discrepancy = { ref: string; kind: 'missing_internal' | 'missing_provider' | 'duplicate' | 'amount_mismatch' | 'currency_mismatch' | 'ok' };
async function reconcile(providerRecords: { ref: string; currency: string; amountMinor: number | bigint | string }[]): Promise<Discrepancy[]> {
  const out: Discrepancy[] = [];
  const seen = new Set<string>();
  for (const p of providerRecords) {
    if (seen.has(p.ref)) { out.push({ ref: p.ref, kind: 'duplicate' }); continue; }
    seen.add(p.ref);
    const tx = await pool.query('SELECT id, currency FROM ledger_tx WHERE business_ref=$1', [p.ref]);
    if (!tx.rowCount) { out.push({ ref: p.ref, kind: 'missing_internal' }); continue; }
    if (tx.rows[0].currency !== p.currency) { out.push({ ref: p.ref, kind: 'currency_mismatch' }); continue; }
    // internal "amount" for a transfer tx: the positive (credit) leg total — compared in BigInt
    const amt = await pool.query('SELECT COALESCE(SUM(amount_minor),0)::bigint s FROM ledger_entries WHERE tx_id=$1 AND amount_minor>0', [tx.rows[0].id]);
    if (BigInt(amt.rows[0].s) !== BigInt(p.amountMinor)) { out.push({ ref: p.ref, kind: 'amount_mismatch' }); continue; }
    out.push({ ref: p.ref, kind: 'ok' });
  }
  // internal refs the provider never reported
  const internal = await pool.query('SELECT business_ref FROM ledger_tx WHERE kind=$1', ['normal']);
  for (const row of internal.rows) if (!seen.has(row.business_ref)) out.push({ ref: row.business_ref, kind: 'missing_provider' });
  return out;
}

let pass = 0, fail = 0; const failures: string[] = [];
async function check(name: string, body: () => Promise<boolean>) {
  try { if (await body()) { pass++; console.log(`ok   - ${name}`); } else { fail++; failures.push(name); console.log(`FAIL - ${name}`); } }
  catch (e: any) { fail++; failures.push(`${name}: ${e.message}`); console.log(`FAIL - ${name} :: ${e.message}`); }
}

async function main() {
  await initSchema();

  await check('ledger: balanced posting succeeds, updates both accounts', async () => {
    await post('t-100', 'USD', [{ account: 'A', amountMinor: -500 }, { account: 'B', amountMinor: 500 }]);
    return (await balance('A', 'USD')) === -500n && (await balance('B', 'USD')) === 500n;
  });
  await check('ledger: unbalanced posting rejected', async () => {
    try { await post('t-bad', 'USD', [{ account: 'A', amountMinor: -500 }, { account: 'B', amountMinor: 400 }]); return false; }
    catch { return true; }
  });
  await check('ledger: duplicate business_ref rejected (unique)', async () => {
    try { await post('t-100', 'USD', [{ account: 'A', amountMinor: -100 }, { account: 'B', amountMinor: 100 }]); return false; }
    catch { return true; }
  });
  await check('ledger: correction is a reversal entry, original stays visible', async () => {
    const id = await post('t-200', 'USD', [{ account: 'A', amountMinor: -300 }, { account: 'B', amountMinor: 300 }]);
    await reverse(id, 't-200-rev');
    const orig = await pool.query(`SELECT count(*)::int n FROM ledger_tx WHERE business_ref='t-200'`);
    const net = await balance('A', 'USD'); // -500 (t-100) -300 +300 (t-200 + reversal) = -500
    return orig.rows[0].n === 1 && net === -500n;
  });
  await check('ledger: currencies are not summed together', async () => {
    await post('t-eur', 'EUR', [{ account: 'A', amountMinor: -700 }, { account: 'B', amountMinor: 700 }]);
    return (await balance('A', 'USD')) === -500n && (await balance('A', 'EUR')) === -700n;
  });

  // --- R06: exact money (BigInt), the float-rounding hole closed ---
  await check('R06: legs whose FLOAT sum is 0 but EXACT sum is non-zero are rejected', async () => {
    // [-9007199254740991, -2, 9007199254740991, 1]: each a safe integer; JS float sum === 0,
    // exact sum === -1. The old Number reducer accepted it. BigInt sum must reject it.
    const before = await pool.query(`SELECT count(*)::int n FROM ledger_tx WHERE business_ref='t-float-hole'`);
    let rejected = false;
    try {
      await post('t-float-hole', 'USD', [
        { account: 'A', amountMinor: -9007199254740991 },
        { account: 'B', amountMinor: -2 },
        { account: 'C', amountMinor: 9007199254740991 },
        { account: 'D', amountMinor: 1 },
      ]);
    } catch { rejected = true; }
    const after = await pool.query(`SELECT count(*)::int n FROM ledger_tx WHERE business_ref='t-float-hole'`);
    const entries = await pool.query(`SELECT count(*)::int n FROM ledger_entries e JOIN ledger_tx t ON e.tx_id=t.id WHERE t.business_ref='t-float-hole'`);
    // rejected AND nothing persisted (no tx row, no entries) — no posting/audit residue
    return rejected && before.rows[0].n === 0 && after.rows[0].n === 0 && entries.rows[0].n === 0;
  });
  await check('R06: the SAME legs as exact BigInt/strings still reject (exact -1), balanced variant posts', async () => {
    // give the legs as strings so there is no float path at all; exact sum is -1 -> reject
    let rej = false;
    try {
      await post('t-exact-bad', 'USD', [
        { account: 'A', amountMinor: '-9007199254740991' },
        { account: 'B', amountMinor: '-2' },
        { account: 'C', amountMinor: '9007199254740991' },
        { account: 'D', amountMinor: '1' },
      ]);
    } catch { rej = true; }
    // a truly balanced large multi-leg DOES post (sum exactly 0)
    const id = await post('t-exact-ok', 'USD', [
      { account: 'A', amountMinor: '-9007199254740991' },
      { account: 'B', amountMinor: '-1' },
      { account: 'C', amountMinor: '9007199254740991' },
      { account: 'D', amountMinor: '1' },
    ]);
    // pg may return bigserial id as a string; success = rejected the bad one AND got an id back
    return rej && id != null;
  });
  await check('R06: an int64-overflowing leg is rejected (not silently wrapped)', async () => {
    let rej = false;
    try { await post('t-ovf', 'USD', [{ account: 'A', amountMinor: '9223372036854775808' }, { account: 'B', amountMinor: '-9223372036854775808' }]); }
    catch { rej = true; }   // 2^63 is one past INT64_MAX
    return rej;
  });
  await check('R06: a non-integer number leg is rejected', async () => {
    let rej = false;
    try { await post('t-frac', 'USD', [{ account: 'A', amountMinor: -1.5 }, { account: 'B', amountMinor: 1.5 }]); }
    catch { rej = true; }
    return rej;
  });
  await check('R06: balance of a large exact posting is exact (no Number precision loss)', async () => {
    await post('t-big', 'USD', [{ account: 'BIG', amountMinor: '9007199254740993' }, { account: 'BIGC', amountMinor: '-9007199254740993' }]);
    // 9007199254740993 is 2^53+1 — NOT representable as a JS number; BigInt balance must be exact
    return (await balance('BIG', 'USD')) === 9007199254740993n;
  });
  await check('R06: reversal of a large exact posting nets to zero exactly', async () => {
    const id = await post('t-bigrev', 'USD', [{ account: 'X', amountMinor: '9007199254740993' }, { account: 'Y', amountMinor: '-9007199254740993' }]);
    await reverse(id, 't-bigrev-rev');
    return (await balance('X', 'USD')) === 0n && (await balance('Y', 'USD')) === 0n;
  });

  // reconciliation
  await check('reconcile: classifies ok / missing_internal / duplicate / amount / currency', async () => {
    // provider reports: t-100 ok (credit 500), t-100 again (duplicate), t-xxx (missing_internal),
    // t-eur wrong amount, t-200 wrong currency. It does NOT report ... (none here) but t-200/t-eur
    // ARE reported, so to exercise missing_provider we post one internal tx the provider omits.
    await post('t-only-internal', 'USD', [{ account: 'A', amountMinor: -50 }, { account: 'B', amountMinor: 50 }]);
    const recs = [
      { ref: 't-100', currency: 'USD', amountMinor: 500 },
      { ref: 't-100', currency: 'USD', amountMinor: 500 },
      { ref: 't-xxx', currency: 'USD', amountMinor: 100 },
      { ref: 't-eur', currency: 'EUR', amountMinor: 999 },
      { ref: 't-200', currency: 'GBP', amountMinor: 300 },
    ];
    const d = await reconcile(recs);
    const kindOf = (ref: string) => d.filter((x) => x.ref === ref).map((x) => x.kind);
    return kindOf('t-100').includes('ok') && kindOf('t-100').includes('duplicate')
      && kindOf('t-xxx').includes('missing_internal')
      && kindOf('t-eur').includes('amount_mismatch')
      && kindOf('t-200').includes('currency_mismatch')
      && kindOf('t-only-internal').includes('missing_provider');
  });
  await check('reconcile: a discrepancy does NOT move money (detective only)', async () => {
    // balances are unchanged by running reconcile
    const a = await balance('A', 'USD');
    await reconcile([{ ref: 't-xxx', currency: 'USD', amountMinor: 100 }]);
    return (await balance('A', 'USD')) === a;
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log('failures:\n' + failures.map((f) => '  - ' + f).join('\n'));
  pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
