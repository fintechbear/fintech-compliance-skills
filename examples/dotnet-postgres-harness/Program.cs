using FcsHarness;
using Npgsql;

// Connection comes from env (set by the runner to the loopback-only test container).
string cs = Environment.GetEnvironmentVariable("PGCONN")
    ?? "Host=127.0.0.1;Port=55432;Username=fcs;Password=fcs;Database=fcs";

int pass = 0, fail = 0;
var failures = new List<string>();
async Task Check(string name, Func<Task<bool>> body)
{
    try { if (await body()) { pass++; Console.WriteLine($"ok   - {name}"); } else { fail++; failures.Add(name); Console.WriteLine($"FAIL - {name}"); } }
    catch (Exception ex) { fail++; failures.Add($"{name}: {ex.GetType().Name} {ex.Message}"); Console.WriteLine($"FAIL - {name} :: {ex.GetType().Name}: {ex.Message}"); }
}

await InitSchema(cs);
var bank = new Bank(cs);

var T1 = Guid.NewGuid();      // tenant 1
var T2 = Guid.NewGuid();      // tenant 2
var actor = Guid.NewGuid();   // principal with grants
var outsider = Guid.NewGuid(); // principal without grants

// seed accounts: A,B in T1 (USD); J (JPY); K (KWD); X in T2 (USD, same ids reused across tenants is impossible â€” ids are unique, tenant scoping tested via lookups)
var A = await Seed(cs, T1, "USD", 100_00, actor, canDebit: true);
var B = await Seed(cs, T1, "USD", 0, actor, canDebit: true);
var Jp = await Seed(cs, T1, "JPY", 1000, actor, canDebit: true);
var Jp2 = await Seed(cs, T1, "JPY", 0, actor, canDebit: true);
var Noauth = await Seed(cs, T1, "USD", 50_00, actor, canDebit: false); // actor has NO debit grant here
var T2acc = await Seed(cs, T2, "USD", 100_00, actor, canDebit: true);

// ---- Money unit rules ----
await Check("money: zero rejected (amount must be positive)", async () => (await bank.Transfer(T1, actor, k(), new(A, B, 0m, "USD"))).Outcome == Outcome.BadAmount);
await Check("money: negative rejected", async () => (await bank.Transfer(T1, actor, k(), new(A, B, -5m, "USD"))).Outcome == Outcome.BadAmount);
await Check("money: over-precision rejected (USD 1.005)", async () => (await bank.Transfer(T1, actor, k(), new(A, B, 1.005m, "USD"))).Outcome == Outcome.BadAmount);
await Check("money: unsupported currency rejected (XTS)", async () => (await bank.Transfer(T1, actor, k(), new(A, B, 1m, "XTS"))).Outcome == Outcome.UnsupportedCurrency);
await Check("money: overflow throws (not wraps)", () => { try { Money.ToMinorUnits(decimal.MaxValue, "USD"); return Task.FromResult(false); } catch (OverflowException) { return Task.FromResult(true); } catch { return Task.FromResult(false); } });
await Check("money: JPY (0-decimal) exact", () => Task.FromResult(Money.ToMinorUnits(100m, "JPY") == 100));
await Check("money: USD (2-decimal) exact", () => Task.FromResult(Money.ToMinorUnits(1.23m, "USD") == 123));
await Check("money: KWD (3-decimal) exact", () => Task.FromResult(Money.ToMinorUnits(1.234m, "KWD") == 1234));
await Check("money: JPY with decimals rejected (1.5 JPY)", () => { try { Money.ToMinorUnits(1.5m, "JPY"); return Task.FromResult(false); } catch (ArgumentException) { return Task.FromResult(true); } });

// ---- currency mismatch (source/dest) ----
await Check("currency mismatch: USD req into JPY account", async () => (await bank.Transfer(T1, actor, k(), new(A, Jp, 1m, "USD"))).Outcome == Outcome.CurrencyMismatch);

// ---- authorization / tenant isolation ----
await Check("object authz: actor without debit grant is forbidden", async () => (await bank.Transfer(T1, actor, k(), new(Noauth, B, 1m, "USD"))).Outcome == Outcome.Forbid);
await Check("object authz: outsider principal forbidden", async () => (await bank.Transfer(T1, outsider, k(), new(A, B, 1m, "USD"))).Outcome == Outcome.Forbid);
await Check("tenant isolation: T2 actor cannot name a T1 account (not found in tenant)", async () => (await bank.Transfer(T2, actor, k(), new(A, T2acc, 1m, "USD"))).Outcome == Outcome.NotFound);

// ---- idempotency ----
var ik = k();
await Check("idempotency: first call posts", async () => (await bank.Transfer(T1, actor, ik, new(A, B, 1m, "USD"))).Outcome == Outcome.Posted);
await Check("idempotency: same key + same payload replays (not double-spend)", async () => (await bank.Transfer(T1, actor, ik, new(A, B, 1m, "USD"))).Outcome == Outcome.Replayed);
await Check("idempotency: same key + DIFFERENT payload => conflict", async () => (await bank.Transfer(T1, actor, ik, new(A, B, 2m, "USD"))).Outcome == Outcome.Conflict);
await Check("idempotency: same key single transfer row", async () => await bank.CountTransfers(T1, ik) == 1);
// different tenants, same key string: isolated
var sharedKey = "shared-key-xyz";
await Check("idempotency: T1 uses shared key", async () => (await bank.Transfer(T1, actor, sharedKey, new(A, B, 1m, "USD"))).Outcome == Outcome.Posted);
await Check("idempotency: T2 same key string is independent (its own account)", async () => {
    var B2 = await Seed(cs, T2, "USD", 0, actor, canDebit: true);
    return (await bank.Transfer(T2, actor, sharedKey, new(T2acc, B2, 1m, "USD"))).Outcome == Outcome.Posted;
});

// ---- concurrency: N identical requests, SAME idem key -> exactly ONE financial effect ----
await Check("concurrency: 20 identical same-key requests => one posted, rest replay, single debit", async () => {
    var cA = await Seed(cs, T1, "USD", 100_00, actor, canDebit: true);
    var cB = await Seed(cs, T1, "USD", 0, actor, canDebit: true);
    var ckey = k();
    var req = new TransferRequest(cA, cB, 5m, "USD");
    var tasks = Enumerable.Range(0, 20).Select(_ => bank.Transfer(T1, actor, ckey, req)).ToArray();
    var results = await Task.WhenAll(tasks);
    int posted = results.Count(r => r.Outcome == Outcome.Posted);
    int effect = await bank.CountTransfers(T1, ckey);
    long balA = await bank.Balance(T1, cA);
    // exactly one financial effect regardless of how the race resolved
    return effect == 1 && balA == 100_00 - 5_00 && results.All(r => r.Outcome is Outcome.Posted or Outcome.Replayed);
});

// ---- concurrency: balance race, DIFFERENT keys, insufficient funds must not go negative ----
await Check("concurrency: competing debits never overdraw AND at least one succeeds", async () => {
    var rA = await Seed(cs, T1, "USD", 10_00, actor, canDebit: true); // only 10.00 available
    var sinks = new List<Guid>();
    for (int i = 0; i < 15; i++) sinks.Add(await Seed(cs, T1, "USD", 0, actor, canDebit: true));
    // 15 concurrent debits of 1.00 each, distinct keys; at most 10 can succeed
    var tasks = sinks.Select(s => bank.Transfer(T1, actor, k(), new TransferRequest(rA, s, 1m, "USD"))).ToArray();
    var results = await Task.WhenAll(tasks);
    int posted = results.Count(r => r.Outcome == Outcome.Posted);
    long bal = await bank.Balance(T1, rA);
    long credited = 0; foreach (var s in sinks) credited += await bank.Balance(T1, s);
    // REQUIRED: progress was made (posted>=1 — a run of all-failures is a FAIL, not a pass);
    // money conserved (source debited == sinks credited); never negative; ceiling respected.
    return posted >= 1 && posted <= 10 && bal >= 0
        && bal == 10_00 - posted * 1_00 && credited == posted * 1_00;
});

// ---- insufficient funds (simple) ----
await Check("insufficient funds rejected", async () => {
    var p = await Seed(cs, T1, "USD", 1_00, actor, canDebit: true);
    var q = await Seed(cs, T1, "USD", 0, actor, canDebit: true);
    return (await bank.Transfer(T1, actor, k(), new(p, q, 5m, "USD"))).Outcome == Outcome.InsufficientFunds;
});

// ---- atomicity: a posted transfer wrote transfer+audit+idempotency together ----
await Check("atomicity: posted transfer has matching audit + idempotency rows", async () => {
    var p = await Seed(cs, T1, "USD", 10_00, actor, canDebit: true);
    var q = await Seed(cs, T1, "USD", 0, actor, canDebit: true);
    var akey = k();
    var res = await bank.Transfer(T1, actor, akey, new(p, q, 3m, "USD"));
    if (res.Outcome != Outcome.Posted) return false;
    await using var conn = new NpgsqlConnection(cs); await conn.OpenAsync();
    long audits = (long)(await Count(conn, "audit_events", "idem_key", akey))!;
    long idem = (long)(await Count(conn, "idempotency", "key", akey))!;
    return audits == 1 && idem == 1 && await bank.Balance(T1, q) == 3_00;
});

// ---- P01-C: rollback atomicity — a failure AFTER the writes but BEFORE commit must leave NOTHING ----
await Check("rollback: fault after writes/before commit leaves no transfer/audit/idempotency and balances unchanged", async () => {
    var p = await Seed(cs, T1, "USD", 10_00, actor, canDebit: true);
    var q = await Seed(cs, T1, "USD", 0, actor, canDebit: true);
    var rkey = k();
    FcsHarness.FaultHooks.AfterWritesBeforeCommit = () => throw new Exception("INJECTED pre-commit fault");
    bool threw = false;
    try { await bank.Transfer(T1, actor, rkey, new(p, q, 4m, "USD")); }
    catch (Exception ex) when (ex.Message.Contains("INJECTED")) { threw = true; }
    finally { FcsHarness.FaultHooks.Reset(); }
    if (!threw) return false;
    await using var conn = new NpgsqlConnection(cs); await conn.OpenAsync();
    long t = (long)(await Count(conn, "transfers", "idem_key", rkey))!;
    long a = (long)(await Count(conn, "audit_events", "idem_key", rkey))!;
    long i = (long)(await Count(conn, "idempotency", "key", rkey))!;
    // nothing persisted, and both balances are exactly as seeded (debit rolled back too)
    return t == 0 && a == 0 && i == 0 && await bank.Balance(T1, p) == 10_00 && await bank.Balance(T1, q) == 0;
});

// ---- P01-6: post-commit response loss — retry with same key replays, single financial effect ----
await Check("post-commit retry: response lost after commit; same-key retry replays; one effect", async () => {
    var p = await Seed(cs, T1, "USD", 10_00, actor, canDebit: true);
    var q = await Seed(cs, T1, "USD", 0, actor, canDebit: true);
    var pkey = k();
    // first call commits durably, then the "response is lost" (fault after commit)
    FcsHarness.FaultHooks.AfterCommitBeforeResponse = () => throw new Exception("INJECTED response-loss");
    bool lost = false;
    try { await bank.Transfer(T1, actor, pkey, new(p, q, 2m, "USD")); }
    catch (Exception ex) when (ex.Message.Contains("INJECTED")) { lost = true; }
    finally { FcsHarness.FaultHooks.Reset(); }
    if (!lost) return false;
    // the effect is already durable: balance moved, one transfer row exists
    bool durable = await bank.Balance(T1, q) == 2_00 && await bank.CountTransfers(T1, pkey) == 1;
    // client retries with the SAME key -> must replay, not double-spend
    var retry = await bank.Transfer(T1, actor, pkey, new(p, q, 2m, "USD"));
    bool replayed = retry.Outcome == Outcome.Replayed;
    bool oneEffect = await bank.CountTransfers(T1, pkey) == 1 && await bank.Balance(T1, q) == 2_00;
    return durable && replayed && oneEffect;
});

Console.WriteLine($"\n=== HARNESS SUMMARY: pass={pass} fail={fail} ===");
if (fail > 0) { Console.WriteLine("FAILURES:"); foreach (var f in failures) Console.WriteLine("  - " + f); Environment.Exit(1); }
Environment.Exit(0);

// ---------- helpers ----------
static string k() => Guid.NewGuid().ToString("N");

static async Task<object> Count(NpgsqlConnection conn, string table, string col, string val)
{
    // table/col are literals from test code (not user input); val is parameterized.
    await using var cmd = new NpgsqlCommand($"SELECT count(*) FROM {table} WHERE {col}=@v", conn);
    cmd.Parameters.AddWithValue("v", val);
    return (await cmd.ExecuteScalarAsync())!;
}

static async Task<Guid> Seed(string cs, Guid tenant, string ccy, long balMinor, Guid grantPrincipal, bool canDebit)
{
    var id = Guid.NewGuid();
    await using var conn = new NpgsqlConnection(cs); await conn.OpenAsync();
    await using (var c = new NpgsqlCommand("INSERT INTO accounts(id,tenant_id,currency,balance_minor,version) VALUES(@id,@t,@c,@b,0)", conn))
    { c.Parameters.AddWithValue("id", id); c.Parameters.AddWithValue("t", tenant); c.Parameters.AddWithValue("c", ccy); c.Parameters.AddWithValue("b", balMinor); await c.ExecuteNonQueryAsync(); }
    if (canDebit)
    { await using var g = new NpgsqlCommand("INSERT INTO account_grants(account_id,principal_id,can_debit) VALUES(@a,@p,true)", conn);
      g.Parameters.AddWithValue("a", id); g.Parameters.AddWithValue("p", grantPrincipal); await g.ExecuteNonQueryAsync(); }
    return id;
}

static async Task InitSchema(string cs)
{
    await using var conn = new NpgsqlConnection(cs); await conn.OpenAsync();
    var ddl = @"
DROP TABLE IF EXISTS idempotency, audit_events, transfers, account_grants, accounts CASCADE;
CREATE TABLE accounts(
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, currency text NOT NULL,
  balance_minor bigint NOT NULL CHECK (balance_minor >= 0), version int NOT NULL DEFAULT 0);
CREATE TABLE account_grants(
  account_id uuid NOT NULL, principal_id uuid NOT NULL, can_debit boolean NOT NULL DEFAULT false,
  PRIMARY KEY(account_id, principal_id));
CREATE TABLE transfers(
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, idem_key text NOT NULL,
  from_id uuid NOT NULL, to_id uuid NOT NULL, minor bigint NOT NULL, currency text NOT NULL,
  status text NOT NULL, actor_id uuid NOT NULL);
CREATE TABLE audit_events(
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, actor_id uuid NOT NULL,
  from_id uuid NOT NULL, to_id uuid NOT NULL, minor bigint NOT NULL, idem_key text NOT NULL);
CREATE TABLE idempotency(
  tenant_id uuid NOT NULL, operation text NOT NULL, key text NOT NULL,
  fingerprint text NOT NULL, transfer_id uuid NOT NULL,
  PRIMARY KEY(tenant_id, operation, key));  -- the real dedup guarantee";
    await using var c = new NpgsqlCommand(ddl, conn);
    await c.ExecuteNonQueryAsync();
}
