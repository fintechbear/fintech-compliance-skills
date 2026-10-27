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

interface Leg { account: string; amountMinor: number; } // signed

// Post a balanced double-entry transaction (FCS-LEDGER-001). Throws if unbalanced or dup ref.
async function post(businessRef: string, currency: string, legs: Leg[], kind = 'normal', reverses: number | null = null): Promise<number> {
  const sum = legs.reduce((a, l) => a + l.amountMinor, 0);
  if (sum !== 0) throw new Error(`unbalanced: legs sum to ${sum}, must be 0`);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const tx = await c.query('INSERT INTO ledger_tx(business_ref,currency,kind,reverses) VALUES($1,$2,$3,$4) RETURNING id',
      [businessRef, currency, kind, reverses]);
    const txId = tx.rows[0].id;
    for (const l of legs) {
      await c.query('INSERT INTO ledger_entries(tx_id,account,currency,amount_minor) VALUES($1,$2,$3,$4)',
        [txId, l.account, currency, l.amountMinor]);
    }
    await c.query('COMMIT');
    return txId;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// Reverse a posted tx by posting its mirror (FCS-LEDGER-001: correct by reversal, not edit).
async function reverse(originalTxId: number, businessRef: string): Promise<number> {
  const rows = await pool.query('SELECT account, currency, amount_minor FROM ledger_entries WHERE tx_id=$1', [originalTxId]);
  const currency = rows.rows[0].currency;
  const legs: Leg[] = rows.rows.map((r: any) => ({ account: r.account, amountMinor: -Number(r.amount_minor) }));
  return post(businessRef, currency, legs, 'reversal', originalTxId);
}

async function balance(account: string, currency: string): Promise<number> {
  const r = await pool.query('SELECT COALESCE(SUM(amount_minor),0)::bigint s FROM ledger_entries WHERE account=$1 AND currency=$2', [account, currency]);
  return Number(r.rows[0].s);
}

// Reconciliation: classify each provider record against internal postings.
type Discrepancy = { ref: string; kind: 'missing_internal' | 'missing_provider' | 'duplicate' | 'amount_mismatch' | 'currency_mismatch' | 'ok' };
async function reconcile(providerRecords: { ref: string; currency: string; amountMinor: number }[]): Promise<Discrepancy[]> {
  const out: Discrepancy[] = [];
  const seen = new Set<string>();
  for (const p of providerRecords) {
    if (seen.has(p.ref)) { out.push({ ref: p.ref, kind: 'duplicate' }); continue; }
    seen.add(p.ref);
    const tx = await pool.query('SELECT id, currency FROM ledger_tx WHERE business_ref=$1', [p.ref]);
    if (!tx.rowCount) { out.push({ ref: p.ref, kind: 'missing_internal' }); continue; }
    if (tx.rows[0].currency !== p.currency) { out.push({ ref: p.ref, kind: 'currency_mismatch' }); continue; }
    // internal "amount" for a transfer tx: the positive (credit) leg total
    const amt = await pool.query('SELECT COALESCE(SUM(amount_minor),0)::bigint s FROM ledger_entries WHERE tx_id=$1 AND amount_minor>0', [tx.rows[0].id]);
    if (Number(amt.rows[0].s) !== p.amountMinor) { out.push({ ref: p.ref, kind: 'amount_mismatch' }); continue; }
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
    return (await balance('A', 'USD')) === -500 && (await balance('B', 'USD')) === 500;
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
    return orig.rows[0].n === 1 && net === -500;
  });
  await check('ledger: currencies are not summed together', async () => {
    await post('t-eur', 'EUR', [{ account: 'A', amountMinor: -700 }, { account: 'B', amountMinor: 700 }]);
    return (await balance('A', 'USD')) === -500 && (await balance('A', 'EUR')) === -700;
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
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
