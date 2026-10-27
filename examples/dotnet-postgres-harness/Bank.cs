// fcs-harness â€” executable PostgreSQL-backed test of the compliance rules the repo's
// csharp-dotnet.md "good example" demonstrates. The doc sketch targets SQL Server
// (SqlException 2601/2627, rowversion); this harness implements the SAME RULES against
// a REAL PostgreSQL 16 driver (Npgsql) with the PROVIDER-CORRECT mechanisms:
//   - unique violation = SQLSTATE 23505 (not SQL Server 2601/2627)
//   - concurrency guard = an explicit integer `version` column + optimistic check
//     (PostgreSQL has no SQL Server `rowversion`; xmin is an alternative but we use an
//      explicit, portable version column), plus SERIALIZABLE + 40001 retry.
// Rules exercised: ISO 4217 minor-unit money (reject over-precision/unsupported,
// checked overflow), idempotency scoped to (tenant, operation, key) + payload
// fingerprint, object-level authorization, tenant isolation, atomic
// debit+credit+audit+idempotency, concurrent single-effect, insufficient-funds race,
// response-loss safe retry, rollback.
//
// NOT a product SDK. It tests the rules, not the doc's exact SQL-Server code.

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Npgsql;

namespace FcsHarness;

// ---------- Money: ISO 4217 minor-unit conversion (mirrors the doc's Money.ToMinorUnits) ----------
public static class Money
{
    // Minimal vetted subset; exponents per ISO 4217. Extend from the official list in production.
    private static readonly IReadOnlyDictionary<string, int> Exponents = new Dictionary<string, int>
    {
        ["JPY"] = 0, ["KRW"] = 0,
        ["USD"] = 2, ["EUR"] = 2, ["GBP"] = 2,
        ["KWD"] = 3, ["BHD"] = 3, ["OMR"] = 3,
    };

    public static bool TryExponent(string currency, out int exponent) =>
        Exponents.TryGetValue(currency, out exponent);

    public static long ToMinorUnits(decimal amount, string currency)
    {
        if (!Exponents.TryGetValue(currency, out int exponent))
            throw new ArgumentException($"unsupported currency {currency}");
        // reject anything that cannot be represented exactly at this currency's scale (no silent truncation/rounding)
        if (decimal.Round(amount, exponent) != amount)
            throw new ArgumentException($"amount {amount} has more precision than {currency} (exponent {exponent}) allows");
        decimal scaled = amount * (decimal)Math.Pow(10, exponent);
        checked { return (long)scaled; } // overflow throws instead of wrapping
    }
}

public sealed record TransferRequest(Guid FromAccountId, Guid ToAccountId, decimal Amount, string Currency);

public enum Outcome { Posted, Replayed, Conflict, Forbid, NotFound, InsufficientFunds, CurrencyMismatch, BadAmount, UnsupportedCurrency, ConcurrencyRetryExhausted }

public sealed record TransferResult(Outcome Outcome, Guid? TransferId = null, string? Note = null);

public sealed class Bank(string connString)
{
    public static string Fingerprint(TransferRequest r) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{r.FromAccountId}|{r.ToAccountId}|{r.Amount.ToString(CultureInfo.InvariantCulture)}|{r.Currency}")));

    public async Task<TransferResult> Transfer(Guid tenantId, Guid actorId, string idemKey, TransferRequest req, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(idemKey)) return new(Outcome.BadAmount, Note: "idempotency key required");
        if (req.Amount <= 0) return new(Outcome.BadAmount, Note: "amount must be positive");
        if (!Money.TryExponent(req.Currency, out _)) return new(Outcome.UnsupportedCurrency);

        long minor;
        try { minor = Money.ToMinorUnits(req.Amount, req.Currency); }
        catch (ArgumentException ex) when (ex.Message.Contains("unsupported")) { return new(Outcome.UnsupportedCurrency); }
        catch (ArgumentException ex) when (ex.Message.Contains("precision")) { return new(Outcome.BadAmount, Note: "over-precision"); }

        var fingerprint = Fingerprint(req);

        // retry loop for SERIALIZABLE serialization failures (SQLSTATE 40001)
        for (int attempt = 0; attempt < 5; attempt++)
        {
            await using var conn = new NpgsqlConnection(connString);
            await conn.OpenAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(System.Data.IsolationLevel.Serializable, ct);
            try
            {
                // idempotency pre-check within the tx
                var prior = await ReadIdem(conn, tx, tenantId, idemKey, ct);
                if (prior is not null)
                {
                    await tx.RollbackAsync(ct);
                    return prior.Value.fp != fingerprint ? new(Outcome.Conflict) : new(Outcome.Replayed, prior.Value.transferId);
                }

                // load accounts scoped to tenant (object-level + tenant isolation)
                var from = await ReadAccount(conn, tx, tenantId, req.FromAccountId, ct);
                var to = await ReadAccount(conn, tx, tenantId, req.ToAccountId, ct);
                if (from is null || to is null) { await tx.RollbackAsync(ct); return new(Outcome.NotFound); }

                // object-level authorization: actor must hold a debit grant on the SOURCE account
                if (!await HasDebitGrant(conn, tx, from.Value.id, actorId, ct)) { await tx.RollbackAsync(ct); return new(Outcome.Forbid); }

                if (from.Value.currency != req.Currency || to.Value.currency != req.Currency) { await tx.RollbackAsync(ct); return new(Outcome.CurrencyMismatch); }
                if (from.Value.balance < minor) { await tx.RollbackAsync(ct); return new(Outcome.InsufficientFunds); }

                // optimistic version guard (PostgreSQL-correct substitute for SQL Server rowversion)
                var okFrom = await UpdateBalance(conn, tx, from.Value.id, -minor, from.Value.version, ct);
                var okTo = await UpdateBalance(conn, tx, to.Value.id, +minor, to.Value.version, ct);
                if (!okFrom || !okTo) { await tx.RollbackAsync(ct); return new(Outcome.ConcurrencyRetryExhausted, Note: "version conflict"); }

                var transferId = Guid.NewGuid();
                await Exec(conn, tx, "INSERT INTO transfers(id,tenant_id,idem_key,from_id,to_id,minor,currency,status,actor_id) VALUES(@id,@t,@k,@f,@to,@m,@c,'posted',@a)", ct,
                    ("id", transferId), ("t", tenantId), ("k", idemKey), ("f", from.Value.id), ("to", to.Value.id), ("m", minor), ("c", req.Currency), ("a", actorId));
                await Exec(conn, tx, "INSERT INTO audit_events(id,tenant_id,actor_id,from_id,to_id,minor,idem_key) VALUES(@id,@t,@a,@f,@to,@m,@k)", ct,
                    ("id", Guid.NewGuid()), ("t", tenantId), ("a", actorId), ("f", from.Value.id), ("to", to.Value.id), ("m", minor), ("k", idemKey));
                // idempotency record, unique on (tenant, operation, key) â€” committed in the SAME tx as the effect
                await Exec(conn, tx, "INSERT INTO idempotency(tenant_id,operation,key,fingerprint,transfer_id) VALUES(@t,'transfers.create',@k,@fp,@tr)", ct,
                    ("t", tenantId), ("k", idemKey), ("fp", fingerprint), ("tr", transferId));

                // TEST-SURFACE fault injection: fail AFTER the debit/credit/audit/idempotency writes
                // but BEFORE commit, to prove the whole unit rolls back together (nothing persists).
                if (FaultHooks.AfterWritesBeforeCommit is not null) FaultHooks.AfterWritesBeforeCommit();

                await tx.CommitAsync(ct);

                // TEST-SURFACE fault injection: simulate the response being lost AFTER a durable commit,
                // so a retry with the same key must replay the stored result (one financial effect).
                if (FaultHooks.AfterCommitBeforeResponse is not null) FaultHooks.AfterCommitBeforeResponse();
                return new(Outcome.Posted, transferId);
            }
            catch (PostgresException pg) when (pg.SqlState == "23505") // unique violation â€” PostgreSQL, not SQL Server 2601/2627
            {
                await SafeRollback(tx, ct);
                var winner = await ReadIdemNewConn(tenantId, idemKey, ct);
                if (winner is not null)
                    return winner.Value.fp == fingerprint ? new(Outcome.Replayed, winner.Value.transferId) : new(Outcome.Conflict);
                // unique violation on something else â€” rethrow
                throw;
            }
            catch (PostgresException pg) when (pg.SqlState == "40001") // serialization_failure â€” retry
            {
                await SafeRollback(tx, ct);
                if (attempt == 4) return new(Outcome.ConcurrencyRetryExhausted);
                await Task.Delay(10 * (attempt + 1), ct);
            }
        }
        return new(Outcome.ConcurrencyRetryExhausted);
    }

    private static async Task SafeRollback(NpgsqlTransaction tx, CancellationToken ct)
    { try { await tx.RollbackAsync(ct); } catch { /* already aborted */ } }

    private async Task<(string fp, Guid transferId)?> ReadIdem(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tenant, string key, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("SELECT fingerprint, transfer_id FROM idempotency WHERE tenant_id=@t AND operation='transfers.create' AND key=@k", conn, tx);
        cmd.Parameters.AddWithValue("t", tenant); cmd.Parameters.AddWithValue("k", key);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? (r.GetString(0), r.GetGuid(1)) : null;
    }
    private async Task<(string fp, Guid transferId)?> ReadIdemNewConn(Guid tenant, string key, CancellationToken ct)
    {
        await using var conn = new NpgsqlConnection(connString); await conn.OpenAsync(ct);
        await using var cmd = new NpgsqlCommand("SELECT fingerprint, transfer_id FROM idempotency WHERE tenant_id=@t AND operation='transfers.create' AND key=@k", conn);
        cmd.Parameters.AddWithValue("t", tenant); cmd.Parameters.AddWithValue("k", key);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? (r.GetString(0), r.GetGuid(1)) : null;
    }
    private async Task<(Guid id, long balance, string currency, int version)?> ReadAccount(NpgsqlConnection conn, NpgsqlTransaction tx, Guid tenant, Guid id, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("SELECT id,balance_minor,currency,version FROM accounts WHERE id=@id AND tenant_id=@t", conn, tx);
        cmd.Parameters.AddWithValue("id", id); cmd.Parameters.AddWithValue("t", tenant);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? (r.GetGuid(0), r.GetInt64(1), r.GetString(2), r.GetInt32(3)) : null;
    }
    private async Task<bool> HasDebitGrant(NpgsqlConnection conn, NpgsqlTransaction tx, Guid accountId, Guid principal, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("SELECT 1 FROM account_grants WHERE account_id=@a AND principal_id=@p AND can_debit=true", conn, tx);
        cmd.Parameters.AddWithValue("a", accountId); cmd.Parameters.AddWithValue("p", principal);
        return await cmd.ExecuteScalarAsync(ct) is not null;
    }
    private async Task<bool> UpdateBalance(NpgsqlConnection conn, NpgsqlTransaction tx, Guid id, long delta, int expectedVersion, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand(
            "UPDATE accounts SET balance_minor = balance_minor + @d, version = version + 1 WHERE id=@id AND version=@v AND balance_minor + @d >= 0", conn, tx);
        cmd.Parameters.AddWithValue("d", delta); cmd.Parameters.AddWithValue("id", id); cmd.Parameters.AddWithValue("v", expectedVersion);
        return await cmd.ExecuteNonQueryAsync(ct) == 1;
    }
    private static async Task Exec(NpgsqlConnection conn, NpgsqlTransaction tx, string sql, CancellationToken ct, params (string, object)[] ps)
    {
        await using var cmd = new NpgsqlCommand(sql, conn, tx);
        foreach (var (n, v) in ps) cmd.Parameters.AddWithValue(n, v);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<long> Balance(Guid tenant, Guid id)
    {
        await using var conn = new NpgsqlConnection(connString); await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT balance_minor FROM accounts WHERE id=@id AND tenant_id=@t", conn);
        cmd.Parameters.AddWithValue("id", id); cmd.Parameters.AddWithValue("t", tenant);
        return (long)(await cmd.ExecuteScalarAsync())!;
    }
    public async Task<int> CountTransfers(Guid tenant, string idemKey)
    {
        await using var conn = new NpgsqlConnection(connString); await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT count(*) FROM transfers WHERE tenant_id=@t AND idem_key=@k", conn);
        cmd.Parameters.AddWithValue("t", tenant); cmd.Parameters.AddWithValue("k", idemKey);
        return (int)(long)(await cmd.ExecuteScalarAsync())!;
    }
}

// TEST-SURFACE ONLY fault-injection hooks. Null in normal runs. The harness sets these to
// force a failure at a precise point (after writes/before commit; after commit/before
// response) to prove rollback atomicity and post-commit retry safety on a REAL database.
// They live on the test surface, not in any production path.
public static class FaultHooks
{
    public static Action? AfterWritesBeforeCommit;
    public static Action? AfterCommitBeforeResponse;
    public static void Reset() { AfterWritesBeforeCommit = null; AfterCommitBeforeResponse = null; }
}
