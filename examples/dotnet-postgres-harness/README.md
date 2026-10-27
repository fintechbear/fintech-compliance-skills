# .NET + PostgreSQL executable rule harness

This is an **executable, independently-runnable** test of the compliance *rules* that
`skills/languages/csharp-dotnet.md`'s "Good example" demonstrates. That doc sketch is
explicitly **illustrative and not compilable**, and it targets **SQL Server**
(`SqlException` 2601/2627, `rowversion`). This harness re-implements the **same rules**
against a **real PostgreSQL 16** database using the **provider-correct** mechanisms:

| Rule in the doc sketch | SQL Server form (doc) | PostgreSQL form (this harness) |
|---|---|---|
| Idempotency dedup | unique index + `SqlException 2601/2627` | `PRIMARY KEY(tenant, operation, key)` + `PostgresException.SqlState == "23505"` |
| Lost-update guard | `rowversion` token | explicit `version int` column + optimistic `WHERE version = @v` |
| Serializable retry | retry on deadlock | retry on `40001` (`serialization_failure`) |
| ISO 4217 money | `Money.ToMinorUnits` | same logic (`Money.ToMinorUnits`) |
| Object-level authz | `AccountGrants` check | `account_grants` row check |

It is **not** a product SDK and does **not** validate the doc's exact SQL-Server code —
it proves the rules hold against a real relational engine with real transactions,
constraints and concurrency.

## Run it

Requires Docker + a .NET 10 SDK.

```bash
bash run.sh
```

`run.sh` starts a **loopback-only, task-scoped** PostgreSQL 16 container
(`127.0.0.1:55432`), builds and runs the harness via `dotnet run -c Release`, then
removes the container (trap on exit). The harness prints one line per scenario and a
`pass=/fail=` summary, exiting non-zero on any failure.

## Scenarios

money: zero / negative / over-precision / unsupported currency / overflow / 0-,2-,3-decimal
exact / JPY-with-decimals rejected; currency mismatch; object-level authz (no grant,
outsider); tenant isolation; idempotency (first post, same-payload replay,
different-payload conflict, single effect, cross-tenant key independence); concurrency
(20 identical same-key → one effect; competing debits never overdraw); insufficient
funds; debit+credit+audit+idempotency atomicity.
