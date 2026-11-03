// FCS transfer reference on PostgreSQL via node-postgres (`pg`).
// Enforces FCS-AUTHZ-001 (tenant isolation), FCS-MONEY-001 (money), FCS-IDEMP-001
// (idempotency fingerprint), FCS-AUDIT-001 (atomic debit+credit+audit+idempotency).
//
// PostgreSQL specifics (NOT SQL Server): optimistic concurrency uses an explicit
// integer `version` column; a duplicate idempotency key is caught by unique-violation
// SQLSTATE 23505; serialization failures surface as 40001 and are retried.

import type { Pool } from 'pg';
import { toMinorUnits, MoneyError } from './money.ts';

export type Outcome =
  | 'posted' | 'replayed' | 'conflict'
  | 'bad_amount' | 'unsupported_currency' | 'over_precision' | 'overflow'
  | 'currency_mismatch' | 'not_found_in_tenant' | 'insufficient_funds'
  | 'same_account' | 'consistency_error' | 'forbidden'
  | 'retry_exhausted';

export interface TransferReq {
  src: string; dst: string; amount: string; currency: string;
}
export interface TransferResult { outcome: Outcome; transferId?: string; }

// Test-surface fault hooks (FCS req: injection only in the test surface, never prod paths).
export const Faults = {
  afterWritesBeforeCommit: null as null | (() => void),
  afterCommitBeforeResponse: null as null | (() => void),
  reset() { this.afterWritesBeforeCommit = null; this.afterCommitBeforeResponse = null; },
};

export async function initSchema(pool: Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DROP TABLE IF EXISTS audit, idempotency, account_grants, accounts CASCADE');
    await c.query(`CREATE TABLE accounts(
      id text NOT NULL, tenant_id text NOT NULL, currency text NOT NULL,
      balance_minor bigint NOT NULL, version int NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, id))`);
    // FCS-AUTHZ-001 object-level authorization: a principal (actor) holds explicit grants on an
    // account. Tenant membership is NOT authorization — the actor must hold a can_debit grant on
    // the SOURCE account. Mirrors the .NET harness's account_grants contract.
    await c.query(`CREATE TABLE account_grants(
      tenant_id text NOT NULL, account_id text NOT NULL, principal_id text NOT NULL,
      can_debit boolean NOT NULL DEFAULT false,
      PRIMARY KEY (tenant_id, account_id, principal_id))`);
    await c.query(`CREATE TABLE idempotency(
      tenant_id text NOT NULL, operation text NOT NULL, key text NOT NULL,
      payload_fingerprint text NOT NULL, transfer_id text NOT NULL,
      PRIMARY KEY (tenant_id, operation, key))`);
    await c.query(`CREATE TABLE audit(
      id bigserial PRIMARY KEY, tenant_id text NOT NULL, transfer_id text NOT NULL,
      src text NOT NULL, dst text NOT NULL, amount_minor bigint NOT NULL, currency text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

export async function seedAccount(pool: Pool, tenant: string, id: string, currency: string, balanceMinor: number) {
  await pool.query(
    'INSERT INTO accounts(id,tenant_id,currency,balance_minor,version) VALUES($1,$2,$3,$4,0)',
    [id, tenant, currency, balanceMinor]);
}

// FCS-AUTHZ-001: grant a principal a (debit) capability on an account within a tenant.
export async function seedGrant(pool: Pool, tenant: string, accountId: string, principal: string, canDebit = true) {
  await pool.query(
    `INSERT INTO account_grants(tenant_id,account_id,principal_id,can_debit) VALUES($1,$2,$3,$4)
     ON CONFLICT (tenant_id,account_id,principal_id) DO UPDATE SET can_debit=EXCLUDED.can_debit`,
    [tenant, accountId, principal, canDebit]);
}

// Canonical idempotency fingerprint (FCS-IDEMP-001): stable JSON of the scoped request.
function fingerprint(req: TransferReq): string {
  return JSON.stringify([req.src, req.dst, req.amount, req.currency]);
}

export async function transfer(
  pool: Pool, tenant: string, actor: string, operation: string, key: string, req: TransferReq,
): Promise<TransferResult> {
  // FCS-MONEY-001: validate amount up front; map MoneyError kind -> outcome.
  let amountMinor: number;
  try { amountMinor = toMinorUnits(req.amount, req.currency); }
  catch (e) {
    if (e instanceof MoneyError) {
      const map: Record<string, Outcome> = {
        unsupported_currency: 'unsupported_currency', over_precision: 'over_precision',
        overflow: 'overflow', non_positive: 'bad_amount', bad_amount: 'bad_amount',
      };
      return { outcome: map[e.kind] ?? 'bad_amount' };
    }
    throw e;
  }

  // R01: self-transfer contract. A transfer whose source and destination are the same
  // account is a no-op at best and, on an optimistic-version ledger, actively WRONG: the
  // debit bumps the row's version so the credit's WHERE version=old matches 0 rows, leaving
  // the balance debited and the credit lost. There is no correct "move money to yourself",
  // so we REFUSE it explicitly rather than post a half-write. Checked before idempotency so
  // a self-transfer never records an idempotency row or audit entry.
  if (req.src === req.dst) return { outcome: 'same_account' };

  const fp = fingerprint(req);

  const MAX_RETRY = 8;
  for (let attempt = 0; ; attempt++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // R02: OBJECT-LEVEL AUTHORIZATION comes BEFORE any idempotency replay can return a
      // result. Otherwise an unauthorized actor could present someone else's idempotency key
      // and learn the stored transfer_id/outcome (a result leak). Tenant membership is NOT
      // authorization: the actor must hold a can_debit grant on the SOURCE account, scoped to
      // this tenant. A missing source account in this tenant is 'not_found_in_tenant'; an
      // existing one the actor may not debit is 'forbidden'.
      const srcAcc = await c.query(
        'SELECT 1 FROM accounts WHERE tenant_id=$1 AND id=$2', [tenant, req.src]);
      if (!srcAcc.rowCount) { await c.query('ROLLBACK'); return { outcome: 'not_found_in_tenant' }; }
      const grant = await c.query(
        'SELECT 1 FROM account_grants WHERE tenant_id=$1 AND account_id=$2 AND principal_id=$3 AND can_debit=true',
        [tenant, req.src, actor]);
      if (!grant.rowCount) { await c.query('ROLLBACK'); return { outcome: 'forbidden' }; }

      // FCS-IDEMP-001: look up (tenant, operation, key) only AFTER authorization.
      const seen = await c.query(
        'SELECT payload_fingerprint, transfer_id FROM idempotency WHERE tenant_id=$1 AND operation=$2 AND key=$3',
        [tenant, operation, key]);
      if (seen.rowCount && seen.rows[0]) {
        await c.query('COMMIT');
        if (seen.rows[0].payload_fingerprint !== fp) return { outcome: 'conflict' };
        return { outcome: 'replayed', transferId: seen.rows[0].transfer_id };
      }

      // Both accounts must exist WITHIN this tenant (destination re-checked here under lock).
      const accs = await c.query(
        'SELECT id, currency, balance_minor, version FROM accounts WHERE tenant_id=$1 AND id = ANY($2) FOR UPDATE',
        [tenant, [req.src, req.dst]]);
      const byId = new Map(accs.rows.map((r: any) => [r.id, r]));
      const src = byId.get(req.src), dst = byId.get(req.dst);
      if (!src || !dst) { await c.query('ROLLBACK'); return { outcome: 'not_found_in_tenant' }; }
      if (src.currency !== req.currency || dst.currency !== req.currency) {
        await c.query('ROLLBACK'); return { outcome: 'currency_mismatch' };
      }
      if (Number(src.balance_minor) < amountMinor) { await c.query('ROLLBACK'); return { outcome: 'insufficient_funds' }; }

      const transferId = `${tenant}:${operation}:${key}`;
      // Debit + credit with optimistic version bump. R01: assert each UPDATE changed EXACTLY
      // the one row we expect. A rowCount other than 1 means the optimistic version no longer
      // matched (a concurrent writer, or a logic error like a self-transfer slipping through):
      // we must NOT proceed to COMMIT on a partial write — roll the whole transaction back.
      const deb = await c.query('UPDATE accounts SET balance_minor=balance_minor-$1, version=version+1 WHERE tenant_id=$2 AND id=$3 AND version=$4',
        [amountMinor, tenant, req.src, src.version]);
      if (deb.rowCount !== 1) { await c.query('ROLLBACK'); return { outcome: 'consistency_error' }; }
      const cre = await c.query('UPDATE accounts SET balance_minor=balance_minor+$1, version=version+1 WHERE tenant_id=$2 AND id=$3 AND version=$4',
        [amountMinor, tenant, req.dst, dst.version]);
      if (cre.rowCount !== 1) { await c.query('ROLLBACK'); return { outcome: 'consistency_error' }; }
      await c.query('INSERT INTO audit(tenant_id,transfer_id,src,dst,amount_minor,currency) VALUES($1,$2,$3,$4,$5,$6)',
        [tenant, transferId, req.src, req.dst, amountMinor, req.currency]);
      // idempotency row in the SAME transaction — unique PK is the real dedup guarantee.
      await c.query('INSERT INTO idempotency(tenant_id,operation,key,payload_fingerprint,transfer_id) VALUES($1,$2,$3,$4,$5)',
        [tenant, operation, key, fp, transferId]);

      if (Faults.afterWritesBeforeCommit) { const f = Faults.afterWritesBeforeCommit; Faults.afterWritesBeforeCommit = null; f(); }

      await c.query('COMMIT');

      if (Faults.afterCommitBeforeResponse) { const f = Faults.afterCommitBeforeResponse; Faults.afterCommitBeforeResponse = null; f(); }
      return { outcome: 'posted', transferId };
    } catch (e: any) {
      try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      // 40001 serialization_failure / 23505 unique_violation on the idempotency key -> retry.
      if ((e.code === '40001' || e.code === '23505') && attempt < MAX_RETRY) { continue; }
      if (e.code === '40001' || e.code === '23505') return { outcome: 'retry_exhausted' };
      throw e;
    } finally {
      c.release();
    }
  }
}

export async function balance(pool: Pool, tenant: string, id: string): Promise<number> {
  const r = await pool.query('SELECT balance_minor FROM accounts WHERE tenant_id=$1 AND id=$2', [tenant, id]);
  return r.rowCount ? Number(r.rows[0].balance_minor) : NaN;
}
export async function count(pool: Pool, table: string, where: string, params: any[]): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return r.rows[0].n;
}
