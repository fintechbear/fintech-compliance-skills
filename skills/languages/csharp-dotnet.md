# Skill: C# / .NET for Regulated Fintech

**Write regulation-compliant financial code on .NET (ASP.NET Core, EF Core) using the right first-party crypto, Identity, logging, and persistence primitives.** Load this skill whenever the task touches C#/.NET services that handle payments, transfers, onboarding/KYC, authentication, PII, or audit trails. Always also load [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) and [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md); add the relevant regional skill for the user's jurisdiction.

## When to use

- Building ASP.NET Core APIs/services for banking, payments, lending, or wallets.
- Storing credentials, PII, PAN/IBAN/national-ID, or any card data on .NET.
- Implementing money movement (transfer, charge, payout, ledger posting) with EF Core.
- Adding structured logging to a financial service and needing to guarantee PII never reaches a sink.
- Choosing between `System.Security.Cryptography`, ASP.NET Core Identity, and the Data Protection API — a common source of dangerous misuse.

Do **not** use this skill as a substitute for a security review or for jurisdiction-specific legal advice; it encodes engineering defaults, not sign-off.

---

## Logging — what goes where

Financial services on .NET standardize on `Microsoft.Extensions.Logging` (`ILogger<T>`) as the façade, backed by **Serilog** for structured sinks. The non-negotiable rule: **the log pipeline is an untrusted boundary** — assume anything written can leak to a file, a log-aggregation SaaS, or a screen share.

### Which events, which sink, which level

| Event | Level | Sink | Notes |
|-------|-------|------|-------|
| Auth success/failure, lockout, MFA step-up | `Information` / `Warning` | Security/audit sink (append-only) | Never log the password or the token value |
| Money movement (transfer/charge/payout posted) | `Information` | **Audit store** (DB table or WORM sink), *separate from* app logs | Correlate with idempotency key + actor id |
| Authorization denials, privilege use | `Warning` | Security sink | Who, what resource, outcome |
| Validation / business-rule rejection | `Information` | App sink | No raw request body if it carries PII |
| Unhandled exception | `Error` | App sink + alert | Scrub message/stack for embedded PII |
| Config/startup, dependency health | `Information` | App sink | |

Use `BeginScope`/`LogContext.PushProperty` to attach a **correlation id** and **actor id** to every entry so an auditor can reconstruct a transaction.

### What is MASKED before it hits any sink

PAN, CVV, password, bearer/refresh tokens, API keys, full national ID, IBAN, and full DOB must be **masked or dropped at the point of capture**, not filtered downstream. In .NET, enforce this structurally rather than trusting each call site:

- **`Destructurama.Attributed`** — annotate DTO/entity properties so Serilog masks them during destructuring:
  - `[LogMasked(ShowLast = 4)]` on a PAN field → logs `************1234`.
  - `[NotLogged]` on CVV/password/token fields → the property is never emitted.
  - Enable with `.Destructure.UsingAttributes()` in the Serilog config.
- **`Serilog.Enrichers.Sensitive`** — a `LogEvent` enricher that regex-masks values (e-mail, IBAN) in rendered message templates as a defense-in-depth backstop for free-text messages.
- Prefer passing **structured properties** (`logger.LogInformation("Transfer {@Transfer}", dto)`) over interpolated strings, so the masking attributes actually apply. Interpolated `$"...{pan}..."` bypasses destructuring entirely — ban it for anything that could carry sensitive data.

### What is NEVER logged (even masked)

CVV/CVC, full track data, PIN, plaintext passwords, private keys, and raw session/refresh tokens. These are refusal-policy red lines (rules 1, 3), not "mask-then-log" cases — drop them before they enter a `LogEvent`.

### Structured lib, redaction mechanism, log integrity

- **Structured logging:** Serilog (JSON via `Serilog.Formatting.Compact.CompactJsonFormatter`), surfaced through `ILogger<T>`.
- **Redaction mechanism:** `Destructurama.Attributed` attributes + `Destructure.UsingAttributes()`; optionally `Microsoft.Extensions.Compliance.Redaction` (data-classification redactors) on .NET 8+ for a framework-native classification model.
- **Log integrity:** the money-movement audit trail must be **append-only**. Options: a dedicated audit table with no `UPDATE`/`DELETE` grant for the app principal; a **hash-chained** audit record (each row stores `SHA-256(prev_hash || payload)` so tampering is detectable — SHA-256 for *integrity*, never SHA-1/MD5, FCS-CRYPTO-001); or a WORM/immutable sink (e.g. append-only object storage with object lock). Ship logs off-host promptly so a compromised host cannot rewrite history.

---

## Workflow — payment / transfer / onboarding

### Step order (a funds transfer)

1. **AuthN + AuthZ** — authenticated principal; policy check (`[Authorize(Policy="transfers.create")]`) that the actor may move funds from the source account.
2. **Validate** — amount is positive, currency matches, source/destination valid; money as `decimal` (see Hashing & encryption / money note below).
3. **Idempotency gate** — require a client `Idempotency-Key`. Look it up first; if seen, return the stored response and do nothing. Persist the key atomically with the effect.
4. **Sanctions/AML screening** — for onboarding and for cross-party transfers where required; never skip (FCS-AML-001). Record the screening decision.
5. **Begin transaction** (see concurrency model below).
6. **Apply** — debit source, credit destination, write the **ledger/audit record inside the same transaction** so money movement and its audit entry commit or roll back together (FCS-AUDIT-001: never post funds without an audit record).
7. **Commit**; emit `Information` audit log keyed by idempotency key + actor.
8. **On conflict** — catch `DbUpdateConcurrencyException`, re-read, and retry or surface a 409; never silently overwrite.

**Approval gates:** high-value or high-risk transfers enter a `PendingApproval` state (maker-checker); a second authorized principal with a distinct policy approves before step 6 executes. The approval and approver are themselves audit records.

**Where idempotency lives:** a unique constraint on `IdempotencyKey` in the DB is the real guarantee — an in-memory check races. Insert the key row in the same transaction as the effect; the unique-index violation is your dedup under concurrency.

### Concurrency / locking model (EF Core)

Default to **optimistic concurrency** with a concurrency token; reach for pessimistic locking only for genuine hotspots.

- **Optimistic (default):** add a `rowversion` concurrency token.

  ```csharp
  public class Account
  {
      public Guid Id { get; set; }
      public long BalanceMinorUnits { get; set; }   // store money as integer minor units or decimal — never double/float

      [Timestamp]                                     // SQL Server rowversion; or .IsRowVersion() via Fluent API
      public byte[] RowVersion { get; set; } = null!;
  }
  ```

  EF Core adds `WHERE Id = @id AND RowVersion = @original` to every `UPDATE`/`DELETE`. If another transaction changed the row, zero rows match and `SaveChanges()` throws `DbUpdateConcurrencyException`. Resolve explicitly — **store-wins**, **client-wins**, or **merge** — per business rule; for balances, re-read and re-evaluate (never blind client-wins, which silently loses a concurrent debit).

- **Pessimistic (hotspots):** wrap the read-modify-write in an explicit transaction and take a row lock (`SELECT ... FOR UPDATE` / SQL Server `UPDLOCK, ROWLOCK` via raw SQL or `FromSqlInterpolated`). Use sparingly — it serializes and can deadlock.

- **Transactions:** EF Core wraps a single `SaveChanges()` in an implicit transaction. For multi-step units (debit + credit + audit across calls) use an explicit `await using var tx = await db.Database.BeginTransactionAsync();` … `await tx.CommitAsync();`. Choose an isolation level deliberately (`Serializable`/`Snapshot` for ledger-critical paths) rather than taking the provider default.

---

## Hashing & encryption

> **Money-type note (refusal-adjacent):** represent monetary amounts as `decimal` or integer minor units — never `double`/`float`. Binary floats introduce rounding errors in financial math.

### Converting a `decimal` amount to integer minor units (correctly)

`(long)(amount * 100m)` is **wrong** and appears in the Bad example for a reason: it hardcodes 2 decimal places (breaks JPY=0 and KWD=3), it *truncates* over-precise input silently (`1.009 → 100` cents, money vanishes), it can *round* unexpectedly for other scales, and the `(long)` cast is unchecked (overflow wraps). A correct conversion is driven by the currency's **ISO 4217 minor-unit exponent** and rejects anything it cannot represent exactly.

Rules the converter must enforce:
- **Look up the exponent** (ISO 4217): e.g. `JPY=0`, `USD=EUR=GBP=2`, `KWD=BHD=OMR=JOD=3`. Keep a vetted table (or a maintained library such as `NodaMoney`); do not assume 2.
- **Reject unsupported currencies** — an unknown code is an error, not "default to 2".
- **Reject over-precision instead of truncating/rounding** — `req.Amount` with more decimal places than the currency allows is a client bug; return 400, don't silently drop sub-units.
- **Use explicit `MidpointRounding` only where rounding is legitimately required and documented** (e.g. interest, FX) — never as a silent fix for bad input.
- **Use `checked` arithmetic** so overflow throws instead of wrapping.
- **Verify source AND destination account currency match** the request currency — never move 500 of one currency into an account denominated in another.

```csharp
// Illustrative — currency table abbreviated; prove against a vetted ISO 4217 source before shipping.
public static class Money
{
    // ISO 4217 minor-unit exponents (number of decimal places). Extend from the official list.
    private static readonly IReadOnlyDictionary<string, int> Exponents = new Dictionary<string, int>
    {
        ["JPY"] = 0, ["KRW"] = 0, ["VND"] = 0,          // 0-decimal
        ["USD"] = 2, ["EUR"] = 2, ["GBP"] = 2,          // 2-decimal (the common case)
        ["KWD"] = 3, ["BHD"] = 3, ["OMR"] = 3, ["JOD"] = 3, // 3-decimal
    };

    /// <summary>Exact decimal → integer minor units for the given ISO 4217 currency.</summary>
    /// <exception cref="ArgumentException">Unsupported currency.</exception>
    /// <exception cref="ArgumentException">Amount has more precision than the currency allows.</exception>
    /// <exception cref="OverflowException">Value does not fit in Int64.</exception>
    public static long ToMinorUnits(decimal amount, string currency)
    {
        if (!Exponents.TryGetValue(currency, out int exponent))
            throw new ArgumentException($"unsupported currency '{currency}'", nameof(currency));

        // Reject over-precision: scale must not exceed the currency exponent. No silent truncation.
        if (decimal.Round(amount, exponent) != amount)
            throw new ArgumentException(
                $"amount {amount} has more than {exponent} decimal places for {currency}", nameof(amount));

        decimal scaled = amount * Pow10(exponent);     // exact: amount already fits in `exponent` places
        checked { return (long)scaled; }               // overflow throws, never wraps
    }

    private static decimal Pow10(int e) => e switch { 0 => 1m, 1 => 10m, 2 => 100m, 3 => 1000m, _ =>
        throw new ArgumentOutOfRangeException(nameof(e)) };
}
```

**Worked examples:**
- **JPY (exponent 0):** `ToMinorUnits(1500m, "JPY") == 1500`. `ToMinorUnits(1500.5m, "JPY")` → **rejected** (0 decimals allowed).
- **USD (exponent 2):** `ToMinorUnits(19.99m, "USD") == 1999`. `ToMinorUnits(19.999m, "USD")` → **rejected** (over-precision; the old `(long)(x*100m)` would have silently truncated to `1999`).
- **KWD (exponent 3):** `ToMinorUnits(2.500m, "KWD") == 2500`. `ToMinorUnits(2.5m, "KWD") == 2500` (2.5 rounds to itself at 3 places, allowed). `ToMinorUnits(2.5001m, "KWD")` → **rejected**.

**Test outline (write these):**
- *zero:* `ToMinorUnits(0m, "USD") == 0`.
- *negative:* `ToMinorUnits(-19.99m, "USD") == -1999` (sign preserved; the business layer, not this converter, decides whether a negative amount is legal for the operation).
- *upper-bound:* a value just over `long.MaxValue` minor units throws `OverflowException` (checked), not a wrapped negative.
- *over-precision:* `19.999 USD`, `1500.5 JPY`, `2.5001 KWD` each throw `ArgumentException`.
- *unsupported currency:* `"XYZ"` throws `ArgumentException`.
- *currency match:* a transfer whose source/destination account currency differs from `req.Currency` is rejected before any debit.

### Hashed one-way — passwords

Use **ASP.NET Core Identity's `PasswordHasher<TUser>`** (`Microsoft.AspNetCore.Identity`). **Bind the work factor to the framework version — it is not a universal constant.** As of **.NET 8 (v8.0.0)** the Identity **v3** format is **PBKDF2 with HMAC-SHA512, a 128-bit random salt, a 256-bit subkey, and 100,000 iterations** (`PasswordHasherCompatibilityMode.IdentityV3`, format marker byte `0x01`; the PRF, iteration count and salt length are stored in the hash itself). This changed in .NET 7: builds **through .NET 6** used **HMAC-SHA256 at 10,000 iterations**, so a hash's real parameters are whatever the hashing build wrote, not a fixed claim. On verify, v8 returns `SuccessRehashNeeded` when the stored iteration count is below the configured one **or** the stored PRF is the older SHA1/SHA256, so the hasher **transparently re-hashes on next login** as you raise the work factor or move versions forward. Tune via `PasswordHasherOptions.IterationCount` (default **100,000** on .NET 8). Do not re-implement password hashing by hand, and do not hardcode "SHA256/100k" as a timeless fact — pin it to the ASP.NET Core version you ship.

- **Preferred / stronger:** OWASP's primary recommendation is **Argon2id**. On .NET, use the **`Konscious.Security.Cryptography.Argon2`** library (there is no first-party Argon2 in the BCL). OWASP's current minimum configuration is **19 MiB memory, 2 iterations, 1 degree of parallelism** (tune upward to your latency budget). Store the algorithm + parameters alongside the hash so you can migrate.
- **PBKDF2** remains acceptable and is the pragmatic default via `PasswordHasher<TUser>`; it is also the choice when **FIPS 140** validation is a hard requirement (Argon2 is not FIPS-approved). If you call PBKDF2 directly, use `Rfc2898DeriveBytes` / `KeyDerivation.Pbkdf2` with `HashAlgorithmName.SHA512` (matching Identity v3 on .NET 8) and an iteration count at or above the framework default (≥100,000 on .NET 8), and raise it over time.
- **Forbidden (refusal rules 2, 4):** MD5, SHA1, plain SHA-256 "with a salt", any reversible encryption of a password, or a hardcoded/global salt.

### Encrypted two-way — PAN, IBAN, national ID

Use **AES-256-GCM** (authenticated encryption) via `System.Security.Cryptography.AesGcm`, with keys from a **KMS/HSM envelope scheme** — never a key baked into config or source.

```csharp
using System.Security.Cryptography;

// key: 32 bytes (AES-256), obtained per-use from a data-encryption key unwrapped by KMS/HSM.
public static (byte[] nonce, byte[] ciphertext, byte[] tag) Encrypt(
    ReadOnlySpan<byte> plaintext, byte[] key, byte[]? associatedData = null)
{
    byte[] nonce = RandomNumberGenerator.GetBytes(AesGcm.NonceByteSizes.MaxSize); // 12 bytes
    byte[] ciphertext = new byte[plaintext.Length];
    byte[] tag = new byte[AesGcm.TagByteSizes.MaxSize];                           // 16 bytes

    using var aes = new AesGcm(key, tagSizeInBytes: 16); // .NET 8+: tag size is REQUIRED (SYSLIB0053)
    aes.Encrypt(nonce, plaintext, ciphertext, tag, associatedData);
    return (nonce, ciphertext, tag);
}
```

Key points:
- **Unique 12-byte nonce per message** from `RandomNumberGenerator` (a CSPRNG) — never a counter you might reset, never reused with the same key. GCM nonce reuse is catastrophic.
- **16-byte (128-bit) tag.** On .NET 8+ the tag size is declared in the constructor (`tagSizeInBytes`); the old parameterless-tag constructor is obsolete (`SYSLIB0053`), and macOS supports only 16-byte tags. Store `nonce || tag || ciphertext` together.
- **`associatedData` (AAD):** bind ciphertext to context (e.g. the account id / record id) so a blob cannot be transplanted between records.
- **Key management & rotation:** data-encryption keys (DEKs) are generated per-record or per-tenant and wrapped by a **key-encryption key (KEK)** held in AWS KMS / Azure Key Vault / an HSM. Rotate the KEK on schedule; re-wrap DEKs, no plaintext re-encryption needed. Keep a key id/version with each ciphertext for rotation and crypto-shredding (delete a tenant's DEK to render their data unrecoverable).
- **FORBIDDEN (FCS-CRYPTO-001):** static/hardcoded keys or IVs, ECB mode, CBC without a separate MAC, home-rolled crypto, and reusing a GCM nonce.

### The Data Protection API is NOT general-purpose data-at-rest encryption

A frequent and dangerous mistake: using **`IDataProtector`** (`Microsoft.AspNetCore.DataProtection`) to encrypt PII at rest. Microsoft is explicit that **keys are never removed from the key ring**, and the API is designed for **transient, short-lived payloads** — antiforgery tokens, auth cookies, short-lived/`ITimeLimitedDataProtector` tokens — with automatic key rotation on a ~90-day default. Use it for those. For **long-lived PII/PAN at rest, use AES-GCM + KMS envelope (above)**, where you control key lifecycle, rotation, and destruction. If you do use Data Protection, persist and **protect the key ring** (Key Vault / DPAPI-NG / X.509) and account for the deployment-slot-swap pitfall where a swapped slot loses access to the key ring.

---

## Country differences (how the same code changes)

The engineering primitives are the same; what changes is **what you must record, where data may live, which consents/authentication gates apply, and retention**.

- **EU — GDPR, PSD2 SCA, DORA.** GDPR: lawful basis, data-subject erasure (crypto-shredding via per-subject DEK makes this tractable), data-minimization in logs. **PSD2 Strong Customer Authentication**: two independent factors on login and on payment initiation — wire an MFA/step-up gate into the auth and transfer workflows above. **DORA**: ICT resilience, incident reporting timelines, and testing — your audit/append-only logging and retention must satisfy regulator inspection.
- **US — SOX, GLBA, CCPA.** **SOX**: change control and audit integrity over financial-reporting systems — immutable audit trail and segregation of duties (maker-checker) matter here. **GLBA Safeguards Rule**: encryption of customer financial data at rest/in transit, access control. **CCPA/CPRA**: consumer deletion/opt-out — same crypto-shredding + data-inventory story as GDPR.
- **Turkey — KVKK, BDDK, MASAK.** **KVKK** mirrors GDPR consent/erasure duties. **BDDK** imposes **data-localization**: banking customer/transaction data for Turkish operations must be stored and processed on infrastructure in Turkey — this changes your data residency and region config, not your code's crypto. **MASAK**: AML/suspicious-transaction reporting — the sanctions/AML screening step is mandatory and its decisions must be retained and reportable.
- **UK — FCA, UK GDPR.** **UK GDPR** tracks EU GDPR post-Brexit (watch for divergence). **FCA** rules on operational resilience, customer-data handling, and SCA (UK-RTS) broadly parallel PSD2 — keep the SCA/MFA gate.

Encode jurisdiction as **configuration/policy** (residency region, retention windows, SCA on/off, which screening lists), not as forked business logic, so one audited code path serves all regions. Defer to the loaded regional skill for the authoritative control list.

---

## Good example

Idiomatic, authenticated, idempotent, audited transfer with AES-GCM-encrypted PII at rest and masked logging.

> **Status: illustrative, not verified-compilable.** This sketch omits the surrounding project (DbContext, entities, `User.GetUserId()`/`GetTenantId()`, DI) and has not been compiled. Treat it as a correct-shape reference, not drop-in production code; the red lines it demonstrates (idempotency scoping, object authorization, currency match, checked money math, atomic audit) are the point.

```csharp
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Destructurama.Attributed;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

public sealed record TransferRequest(
    Guid FromAccountId,
    Guid ToAccountId,
    decimal Amount,                     // decimal money — never double
    string Currency,
    [property: NotLogged] string? Memo);// memo may carry PII → never logged

[ApiController]
[Route("transfers")]
public sealed class TransferController(AppDbContext db, ILogger<TransferController> log) : ControllerBase
{
    [HttpPost]
    [Authorize(Policy = "transfers.create")]                 // endpoint permission — NECESSARY, NOT SUFFICIENT
    public async Task<IActionResult> Post(
        [FromHeader(Name = "Idempotency-Key")] string idemKey,
        [FromBody] TransferRequest req,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(idemKey)) return BadRequest("Idempotency-Key required");
        if (req.Amount <= 0) return BadRequest("amount must be positive");

        var tenantId = User.GetTenantId();   // every record and the idempotency key are scoped by tenant
        var actorId  = User.GetUserId();

        // Payload fingerprint: same key + same payload is a safe replay; same key + different payload is a conflict.
        var fingerprint = Fingerprint(req);

        // Idempotency key is scoped by (tenant, operation, key) — a DB unique constraint on that TRIPLE is the
        // real guarantee (an in-memory check races). Two tenants reusing the same client key never collide.
        var prior = await db.IdempotencyRecords.AsNoTracking().FirstOrDefaultAsync(
            r => r.TenantId == tenantId && r.Operation == "transfers.create" && r.Key == idemKey, ct);
        if (prior is not null)
        {
            if (prior.PayloadFingerprint != fingerprint)
                return Conflict("Idempotency-Key reused with a different payload");  // explicit 409, not a silent replay
            return Ok(JsonSerializer.Deserialize<object>(prior.StoredResponse));     // replay the stored result verbatim
        }

        await using var tx = await db.Database.BeginTransactionAsync(
            System.Data.IsolationLevel.Serializable, ct);
        try
        {
            // Object-level authorization + tenant scoping: load the accounts WITHIN this tenant, and prove the
            // actor may act on the SOURCE account — endpoint policy alone does not say "this actor owns THIS account".
            var from = await db.Accounts.FirstOrDefaultAsync(
                a => a.Id == req.FromAccountId && a.TenantId == tenantId, ct);
            var to   = await db.Accounts.FirstOrDefaultAsync(
                a => a.Id == req.ToAccountId && a.TenantId == tenantId, ct);
            if (from is null || to is null) return NotFound("account not found in tenant");
            if (!await db.AccountGrants.AnyAsync(
                    g => g.AccountId == from.Id && g.PrincipalId == actorId && g.CanDebit, ct))
                return Forbid();   // actor is not authorized over THIS source account (object, not just endpoint)

            // Currency must match the request AND both accounts; convert with the ISO 4217-aware converter.
            if (from.Currency != req.Currency || to.Currency != req.Currency)
                return BadRequest("account currency mismatch");
            long minor = Money.ToMinorUnits(req.Amount, req.Currency);   // rejects over-precision / unsupported; checked

            if (from.BalanceMinorUnits < minor) return BadRequest("insufficient funds");

            from.BalanceMinorUnits -= minor;     // RowVersion token guards against lost updates
            to.BalanceMinorUnits   += minor;

            var transferId = Guid.NewGuid();
            db.Transfers.Add(new Transfer { Id = transferId, TenantId = tenantId, IdempotencyKey = idemKey,
                FromAccountId = from.Id, ToAccountId = to.Id, AmountMinorUnits = minor,
                Currency = req.Currency, Status = "posted", ActorId = actorId });

            db.AuditEvents.Add(AuditEvent.Transfer(actorId, from.Id, to.Id, minor, idemKey));

            var response = new { id = transferId, status = "posted" };
            // Persist the idempotency record (unique on tenant+operation+key) IN THE SAME TRANSACTION as the effect,
            // storing the response so a later replay returns it without re-executing.
            db.IdempotencyRecords.Add(new IdempotencyRecord {
                TenantId = tenantId, Operation = "transfers.create", Key = idemKey,
                PayloadFingerprint = fingerprint, StoredResponse = JsonSerializer.Serialize(response) });

            await db.SaveChangesAsync(ct);       // debit + credit + audit + idempotency commit atomically (FCS-AUDIT-001)
            await tx.CommitAsync(ct);

            // structured + masked: attributes handle masking; no interpolation, no PAN/memo in the line
            log.LogInformation("Transfer posted {IdemKey} {Amount} {Currency} by {ActorId}",
                idemKey, req.Amount, req.Currency, actorId);
            return Ok(response);
        }
        catch (DbUpdateException ex) when (IsUniqueViolation(ex))
        {
            // Lost the response-write race: a concurrent identical request already committed under this key.
            // The unique index on (tenant, operation, key) is the real dedup — re-read and return the stored result.
            await tx.RollbackAsync(ct);
            var winner = await db.IdempotencyRecords.AsNoTracking().FirstAsync(
                r => r.TenantId == tenantId && r.Operation == "transfers.create" && r.Key == idemKey, ct);
            return winner.PayloadFingerprint == fingerprint
                ? Ok(JsonSerializer.Deserialize<object>(winner.StoredResponse))
                : Conflict("Idempotency-Key reused with a different payload");
        }
        catch (DbUpdateConcurrencyException)
        {
            await tx.RollbackAsync(ct);
            return Conflict("account changed concurrently; retry");   // never blind-overwrite
        }
    }

    // Stable fingerprint of the idempotent payload (order-fixed fields; excludes volatile/non-semantic data).
    private static string Fingerprint(TransferRequest r) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{r.FromAccountId}|{r.ToAccountId}|{r.Amount}|{r.Currency}")));

    private static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is Microsoft.Data.SqlClient.SqlException { Number: 2601 or 2627 };
}

// Passwords via Identity's PasswordHasher (.NET 8: PBKDF2-HMAC-SHA512, 100k iters, auto re-hash).
// PAN encrypted with AES-256-GCM + KMS-wrapped DEK, not IDataProtector.
```

**Idempotency, retries, and the limits of a local transaction:**
- **Response-loss retry (the case the key exists for):** the server commits, then the response is lost to a network drop before the client sees it. The client retries with the *same* `Idempotency-Key`; the stored record is found and the saved response is replayed — no double-spend. This is why the response is persisted inside the transaction, not reconstructed.
- **Same key, different payload → conflict (409), always.** A key identifies one logical operation. Reusing it with a changed amount or destination is a client bug; returning the first result would hide it, and executing the new payload would violate the key's promise. The stored payload fingerprint is what lets the server tell the two apart.
- **Object-level authorization, not just endpoint permission.** `[Authorize(Policy="transfers.create")]` says the caller may *call this endpoint*; it does not say the caller may debit *this* account. Re-check ownership/grant on the specific resource inside the handler, scoped to the caller's tenant, so one tenant can never name another tenant's account id.
- **Local DB transaction ≠ external provider side effect.** The atomic debit+credit+audit+idempotency commit only guarantees *your* database is consistent. A call to an external card network / payment rail / bank API is **not** inside that transaction — it can succeed on the provider while your commit rolls back, or vice versa. For those, pass the idempotency key the provider supports on the outbound call and reconcile via an outbox / saga / provider webhook; do not assume your `CommitAsync` or rollback undid their side effect.

## Bad example

The realistic mistake — and the red lines it crosses.

```csharp
public async Task Transfer(string pan, string cvv, decimal amount, string password)
{
    // ❌ plaintext password / reversible or broken hash — FCS-SECRET-001, FCS-CRYPTO-001
    user.PasswordHash = Convert.ToHexString(MD5.HashData(Encoding.UTF8.GetBytes(password)));

    // ❌ storing + logging PAN, storing CVV — refusal rules 1 & 3 (PCI-DSS)
    _db.Cards.Add(new Card { Pan = pan, Cvv = cvv });
    _log.LogInformation($"charging card {pan} cvv {cvv} for {amount}"); // interpolated → no masking

    // ❌ hardcoded key + ECB + home-rolled crypto — FCS-CRYPTO-001
    using var aes = Aes.Create();
    aes.Mode = CipherMode.ECB;
    aes.Key = Encoding.UTF8.GetBytes("my-super-secret-key-1234");

    // ❌ double money math — rounding errors in financial amounts
    double total = 19.99 * qty;

    // ❌ no idempotency, no audit record, no concurrency token — FCS-AUDIT-001
    from.Balance -= amount;
    to.Balance   += amount;
    await _db.SaveChangesAsync();   // a retry double-spends; a concurrent debit is silently lost
}
```

Each commented line maps to a hard limit in [`refusal/refusal-policy.md`](../refusal/refusal-policy.md): storing/logging card data (1, 3), plaintext/broken password hashing (2), broken crypto and hardcoded keys (4), and removing audit logging on money movement (6). Any one of them is a refusal, not a "fix later" — refuse, name the rule, and offer the compliant pattern from the Good example.
