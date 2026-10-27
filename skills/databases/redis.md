# Skill: Redis for Regulated Fintech

**Use Redis as a cache / session / rate-limit / queue store that never becomes an unencrypted copy of your regulated data.** Load this skill whenever the task puts Redis (Redis Open Source, Redis Software/Enterprise, Redis Cloud, AWS ElastiCache, Azure Managed Redis, GCP Memorystore) in front of payment, auth, PII, or KYC flows and the result must satisfy PCI-DSS v4.0.1, GDPR/PSD2/DORA, SOX/GLBA, FCA, or KVKK/BDDK/MASAK. Always also load [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) and [`core/secure-fintech-coding.md`](../core/secure-fintech-coding.md).

## When to use

- Redis is the cache, session store, rate limiter, lock, or queue in front of a regulated system of record.
- You are deciding **what is allowed to be written into Redis at all** — the single most important decision for this engine.
- You are configuring authentication (ACLs), transport (TLS/mTLS), persistence (RDB/AOF), eviction/expiry, or audit for a Redis deployment that touches money or PII.
- You are reviewing existing Redis usage for compliance red lines: secrets or PAN written to keys, plaintext (`port 6379` with no auth), `KEYS *` in a request path, persistence files (`dump.rdb`, `appendonly.aof`) left unencrypted on disk, or session tokens that never expire.

**The defining risk of this engine.** Redis is **in-memory first**. Its primary store is process RAM, and *neither* Redis Open Source *nor* the managed tiers encrypt data **in memory** — Azure Managed Redis states this explicitly and recommends application-level encryption or caching only non-sensitive data ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/redis/secure-azure-managed-redis)). "Encryption at rest" in Redis means the **persistence files and backups on disk**, not the live dataset. Therefore the storage-side control that matters most is **not storing the sensitive thing in Redis in the first place**, and when you must, encrypting it in the application before `SET`. Everything below is secondary to that rule.

## Logging — what goes where

Redis has two distinct log surfaces, and fintech teams conflate them at their peril:

1. **The Redis server log** (`logfile`, `loglevel`) — operational: startup, config, replication, persistence, slowlog, client disconnects. It is **not** a data-access audit trail and must never be relied on as one.
2. **A connection/command audit trail** — *who connected, when, as which ACL user, and what they ran*. In Redis Open Source this is approximated by the `ACL LOG` (records denied auth/command/key events) plus `SLOWLOG`; a true audit stream is a **Redis Enterprise** feature (see below).

**Levels and sinks.**

| Event | Where | Sink |
|---|---|---|
| Server start/stop, config change, failover, persistence (RDB save / AOF rewrite) | `loglevel notice` server log | app/ops log aggregation |
| Auth failure, ACL denial, blocked command, key-pattern violation | `ACL LOG` (+ `loglevel notice`) | SIEM / audit store + alert |
| Connection open/close, authenticated ACL user, duration | **Redis Enterprise database auditing** (connection + command auditing, 6.2.18+) | append-only audit store |
| Slow command (potential `KEYS`/`SORT` in prod) | `SLOWLOG` + `loglevel` | ops log + alert |
| Any value stored under a key (PAN, token, session blob) | **never logged** | — |

**What is MASKED before anything reaches a sink.** If you ever log a key or payload for debugging, mask it: session token / JWT (never — not even masked), PAN (first-6/last-4 at most, and it should not be in Redis to begin with), national ID, email, API keys. Prefer logging a **key *name* pattern** (`session:{userId}`) over the key's *value*.

**What is NEVER logged, at any level.** CVV/CVC (never stored, never logged — FCS-LOG-001), the plaintext session token or refresh token, the `requirepass`/ACL password, a TLS private key, the application encryption key, or the raw value of any key holding PII. (Refusal FCS-PAN-001/FCS-SAD-001/FCS-LOG-001.)

**Mechanism.** Set `loglevel notice` (not `debug`, which can surface command arguments) and ship the server log + `ACL LOG GET` + `SLOWLOG GET` output to your SIEM. Never log command *arguments* on data paths. For a defensible access trail, use Redis Enterprise **database auditing** (connection auditing shipping to an external, append-only collector) rather than the OSS server log.

**Log integrity.** The OSS server logfile is a mutable text file — it does **not** satisfy SOX/DORA audit-integrity expectations on its own. Forward audit-relevant events to an append-only / WORM store (S3 Object Lock, a hash-chained log, or Redis Enterprise's audit stream into such a sink) where the Redis node itself has no delete grant.

## Workflow — payment / transfer / onboarding (the Redis role)

Redis is almost never the **system of record** for money. In a compliant flow it is a *supporting* store; the authoritative debit/credit and the audit record live in the ACID database (see the language skills' Workflow sections). Redis's jobs are:

1. **Session store.** After authentication, store a **server-side session** keyed by an opaque random id (`session:{opaqueId}` → serialized session), set a TTL, and hand the client only the opaque id (cookie, `HttpOnly; Secure; SameSite`). Never put the raw password, PAN, or a long-lived secret in the session blob. See "Session token handling" below.
2. **Idempotency keys.** `SET idem:{key} <result> NX EX <ttl>` — atomic "insert-if-absent" so a retried payment request returns the stored result instead of double-charging. `NX` makes the check-and-set a single round trip (no race).
3. **Distributed locks / rate limiting.** `SET lock:{resource} {token} NX EX {ttl}` for a maker-checker or hot-row guard; `INCR` + `EXPIRE` for per-user transfer-attempt throttling and SCA-step-up back-off. The lock is an *optimization*, never the source of truth — the database transaction is authoritative (a lost lock after a crash must not corrupt the ledger).
4. **Cache of non-sensitive, derived data.** FX rates, feature flags, non-PII reference data. Cache **tokens and masked values**, not PAN or national IDs.

**Concurrency model.** Redis command execution is **single-threaded** (one command at a time per shard), so individual commands are atomic. Compose multi-step atomicity with:
- **`MULTI`/`EXEC` transactions** (+ `WATCH` for optimistic concurrency — abort if a watched key changed).
- **Lua scripts** (`EVAL`/`EVALSHA`) for read-modify-write that must be atomic server-side (e.g. "decrement a quota only if ≥ amount"). A script runs to completion with no interleaving.
- **Atomic primitives**: `SET ... NX`, `INCR`, `INCRBYFLOAT` (never for money — use integer minor units), `GETDEL`.

Do **not** use Redis as the locking authority for a balance. The ledger's SQL transaction (`SELECT ... FOR UPDATE`) is the authority; a Redis lock only reduces contention.

## Hashing & encryption

**The core storage-side control: encrypt sensitive values in the application before they enter Redis.** Because the in-memory dataset is never encrypted by the engine, the only way sensitive data is protected in RAM, in `MONITOR`/`DEBUG` output, in a core dump, in a swap file, and in a leaked RDB/AOF is **client-side (application-level) encryption**.

**Hashed one-way — passwords & secrets are NOT a Redis job.** Redis stores sessions, not credentials. Password hashing (Argon2id, bcrypt fallback) belongs in the application + its ACID store (see the language skills). If you must key by a secret-derived value (e.g. a lookup by API key), store a **salted SHA-256/HMAC** of the key as the Redis key, never the raw secret. Redis's own ACL passwords are stored by Redis as **SHA-256** internally — so still use a long random password, and prefer TLS client-certificate auth.

**Encrypted two-way — PAN / IBAN / national ID / session payloads.** If a sensitive field genuinely must be cached, encrypt it in the application with **AES-256-GCM** using a **KMS envelope data key** (AWS KMS / Azure Key Vault / GCP KMS / HSM), with a fresh 96-bit nonce per value, and `SET` only the ciphertext. Bind the key name as GCM additional authenticated data so ciphertext can't be replayed under a different key. Decrypt on read in the app. This is the same primitive the language skills use; Redis just holds the opaque blob.

```python
# Application-side: Redis stores ONLY ciphertext. redis-py + cryptography (AESGCM).
import os, redis
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

r = redis.Redis(host="redis.internal", port=6379, ssl=True,
                ssl_cert_reqs="required", ssl_ca_certs="/etc/redis/ca.crt",
                username="app-cache", password=os.environ["REDIS_ACL_PASSWORD"])

def cache_sensitive(key: str, plaintext: bytes, data_key: bytes, ttl: int) -> None:
    nonce = os.urandom(12)                                   # fresh per value
    ct = AESGCM(data_key).encrypt(nonce, plaintext, key.encode())  # AAD = key name
    r.set(key, nonce + ct, ex=ttl)                           # ALWAYS with a TTL
```

**At-rest encryption (persistence files & backups).** Redis's "encryption at rest" protects `dump.rdb`, `appendonly.aof`, and backups — *not* RAM:
- **Redis Cloud on Google Cloud** encrypts all data written to disk by default, no action needed ([Encryption at rest](https://redis.io/docs/latest/operate/rc/security/encryption-at-rest/)).
- **Redis Enterprise Software / self-managed**: there is no built-in page-level dataset encryption — rely on **OS/volume encryption** (LUKS, AWS EBS encryption, Azure disk encryption) for the directory holding RDB/AOF and swap, plus application-level encryption for the values themselves.
- **ElastiCache / Azure Managed Redis / Memorystore** offer at-rest (disk/backup) and in-transit encryption toggles — enable both; they still do **not** encrypt RAM.

**No persistence of secrets — the key control for sensitive-data instances.** If a Redis instance holds anything sensitive, decide deliberately whether it may persist. For a pure cache/session tier holding transient or encrypted data, **disable persistence** so the plaintext (or even ciphertext) is never written to an unencrypted disk file:

```conf
# redis.conf — cache/session instance: no RDB, no AOF, nothing hits disk
save ""            # disable RDB snapshotting (empty = no save points)
appendonly no      # disable the Append Only File
```

Then also disable backups on the managed tier. If you *do* need persistence for availability, you MUST pair it with volume encryption **and** application-level value encryption, because the RDB/AOF is a full, re-loadable copy of the dataset. Verify no stray `SAVE`/`BGSAVE` cron and no debug `dump.rdb` is left world-readable.

**Key management & rotation.** Application data keys come from a KMS under envelope encryption and never live in `redis.conf` or source. Rotate the KMS master key on schedule; because cached data is short-lived (TTL), re-encryption usually happens naturally on cache miss. Rotate ACL passwords and TLS certificates on schedule; store a key id with longer-lived ciphertext so it survives rotation.

**Forbidden (refusal red lines):** writing PAN/CVV/PIN into any Redis key (FCS-PAN-001); storing a password or reversible secret as a Redis value (FCS-SECRET-001); `requirepass`/ACL off and `protected-mode no` on a sensitive instance; plaintext transport (no TLS) for regulated data (FCS-TLS-001); a hardcoded ACL password or TLS key in source/config committed to git (FCS-SECRET-002); `MD5`/custom crypto for the application-side encryption (FCS-CRYPTO-001); and leaving persistence on + unencrypted disk for an instance holding sensitive values.

## Transport, access control & dangerous commands (storage-side hardening)

**TLS / mTLS (in transit).** Regulated data must never cross the wire in plaintext. Redis requires an X.509 cert, private key, and a CA bundle, and uses **mutual TLS by default** (clients must present a valid cert) ([Redis TLS docs](https://redis.io/docs/latest/operate/oss_and_stack/management/security/encryption/)):

```conf
port 0                                  # disable the plaintext port entirely
tls-port 6379
tls-cert-file /etc/redis/redis.crt
tls-key-file  /etc/redis/redis.key
tls-ca-cert-file /etc/redis/ca.crt
tls-auth-clients yes                    # require client certs (mTLS) — the default
tls-replication yes                     # TLS on replica→master links
tls-cluster yes                         # TLS on the cluster bus
```

`port 0` + `tls-port` means **no cleartext listener exists**. Keep `protected-mode yes` and `bind` to private interfaces; never expose Redis to the public internet.

**ACLs — least privilege per client (Redis 6+).** Replace the single `requirepass` god-password with per-service ACL users scoped to the exact commands and key patterns they need. A compromised cache client must not be able to `FLUSHALL` or read another service's keys:

```conf
# A session service: read/write only its own key namespace, no admin/dangerous cmds
user app-session on >$STRONG_RANDOM_PASSWORD ~session:* ~idem:* \
     +@read +@write +@string +@connection -@dangerous -@admin \
     -flushall -flushdb -keys -config -debug -shutdown

user default off                         # disable the unrestricted default user
```

`~session:*` restricts key access to that prefix; `+@read +@write` grant command categories; `-@dangerous -@admin` and the explicit `-flushall -keys -config -debug` deny the destructive/introspection commands. In **Redis Enterprise / Cloud**, ACLs are assigned to **roles** (RBAC), optionally backed by LDAP ([Configure ACLs](https://redis.io/docs/latest/operate/rc/security/access-control/data-access-control/configure-acls/)). Use `ACL LOG` to review denials.

**Avoid `KEYS` in production — this is both a performance and a compliance issue.** `KEYS pattern` scans the **entire keyspace** and, being single-threaded, **blocks every other client** for the duration — on a large fintech cache this is a self-inflicted outage and a DORA operational-resilience failure. Use `SCAN` (cursor-based, non-blocking) instead, and **deny `KEYS` via ACL** (`-keys`) in production. The same applies to `FLUSHALL`/`FLUSHDB` (deny on non-admin users) and `MONITOR`/`DEBUG` (can expose plaintext values — restrict to break-glass admin and audit their use).

```text
# ❌ KEYS session:*        -> blocks the server, scans everything
# ✅ SCAN 0 MATCH session:* COUNT 100   -> incremental, non-blocking
```

**Key expiry — mandatory for sessions and cached PII.** Everything sensitive gets a TTL; data minimization (GDPR/KVKK) and PCI retention limits are enforced by expiry, not by hoping something deletes it. `SET key val EX <seconds>` on write; never a sensitive key with no TTL. Set `maxmemory` + a deliberate `maxmemory-policy` (e.g. `volatile-lru` so only keys *with* a TTL are evicted, never a lock/idempotency key you needed). Use `GETDEL` / `DEL` to proactively drop a session on logout rather than waiting for TTL.

**Session token handling.**
- The client holds an **opaque random id** (≥128 bits from a CSPRNG), never a JWT containing PII and never the session payload itself.
- The server session blob (`session:{id}`) carries only what's needed; encrypt it app-side if it contains anything sensitive.
- TTL = idle timeout (e.g. 15–30 min for fintech); **rotate the id on privilege change / re-auth** (defeats fixation); `GETDEL` on logout; cap absolute lifetime.
- Cookie flags: `HttpOnly; Secure; SameSite=Strict|Lax`. The token never appears in a log, URL, or `MONITOR` output.

**Audit via Redis Enterprise.** For a defensible access trail, Redis Enterprise Software (6.2.18+) provides **database connection auditing** — who connected, as which user, when, for how long, and the authentication events — shipped to an external collector ([RS 6.2.18 release](https://redis.io/blog/redis-enterprise-software-6-2-18/)). Combine with `ACL LOG` for denied-access forensics and forward both to an append-only SIEM. OSS Redis alone cannot produce a complete per-command audit trail — treat that gap as a reason to choose Enterprise (or confine OSS Redis to non-sensitive caching).

## Country differences (how the same setup changes)

- **EU — GDPR, PSD2 SCA, DORA.** Cached PII must be erasable and minimized: short TTLs crypto-shred by expiry; deleting the KMS data key crypto-shreds encrypted blobs. **Data residency** — pin the Redis region/zone and backups in-region. PSD2 SCA: use Redis `INCR`+`EXPIRE` for step-up/back-off counters and store the SCA-decision reference (not the factor) with a TTL. DORA: TLS everywhere, Enterprise audit to WORM, no `KEYS` in prod (resilience), tested failover.
- **US — SOX, GLBA, CCPA.** SOX: audit trail on access to financially relevant data → Enterprise auditing to an immutable sink; Redis is a cache, so the *authoritative* audit stays in the ledger DB. GLBA Safeguards: TLS + ACL least privilege + encryption-at-rest + no-plaintext-secrets are the technical safeguards. CCPA/CPRA delete requests: short TTL + `DEL`/`GETDEL` + crypto-shred.
- **UK — FCA, UK GDPR.** Mirrors EU: SCA under UK PSRs, operational-resilience expectations map to the DORA controls above, UK GDPR for residency and minimization.
- **Turkey — KVKK, BDDK, MASAK.** **KVKK**: TC Kimlik No is sensitive — never cached in plaintext, encrypt app-side if cached at all, never logged. **BDDK localization**: Turkish customers' financial data (and therefore any Redis instance caching it, plus its backups and audit sink) must stay **in Turkey** — pin the region; do not point an offshore managed Redis or an offshore log/audit collector at it. **MASAK**: AML throttling/holds may use Redis counters, but the reportable AML record lives in the authoritative store.

Express residency, TTLs, and SCA thresholds as injected config in one auditable place, not as scattered conditionals.

## Good example

```python
# ✅ Good — opaque session id, TLS+ACL, app-side encryption of a sensitive cache,
#    mandatory TTL, SCAN not KEYS, no persistence of plaintext.
import os, secrets, json, redis
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

r = redis.Redis(
    host="redis.internal", port=6379,
    ssl=True, ssl_cert_reqs="required", ssl_ca_certs="/etc/redis/ca.crt",
    ssl_certfile="/etc/redis/client.crt", ssl_keyfile="/etc/redis/client.key",  # mTLS
    username="app-session", password=os.environ["REDIS_ACL_PASSWORD"],
)

def create_session(user_id: str, claims: dict, data_key: bytes) -> str:
    sid = secrets.token_urlsafe(32)                 # 256-bit opaque id
    blob = json.dumps({"uid": user_id, **claims}).encode()
    nonce = os.urandom(12)
    ct = AESGCM(data_key).encrypt(nonce, blob, b"session")  # app-side AES-256-GCM
    r.set(f"session:{sid}", nonce + ct, ex=1800)    # 30-min TTL, encrypted value
    return sid                                       # client gets only the opaque id

def logout(sid: str) -> None:
    r.delete(f"session:{sid}")                       # proactive revoke, don't wait for TTL

def find_user_sessions(uid: str):                    # SCAN, never KEYS
    cur = 0
    while True:
        cur, batch = r.scan(cur, match="session:*", count=100)
        yield from batch
        if cur == 0:
            break
```

```conf
# server config for this cache/session instance
port 0
tls-port 6379
tls-auth-clients yes
protected-mode yes
save ""            # no RDB  — nothing sensitive hits disk
appendonly no      # no AOF
maxmemory-policy volatile-lru
user default off
```

## Bad example

```python
# ❌ Bad — multiple red lines; an agent must REFUSE to write this.
import redis
r = redis.Redis(host="0.0.0.0", port=6379)           # plaintext, bound to the world, no auth (FCS-TLS-001/FCS-AUTHZ-001)
r.set("card:" + user_id, pan + ":" + cvv)             # stores PAN *and* CVV, no TTL (FCS-PAN-001/FCS-SAD-001)
r.set("session:" + user_id, password)                 # password as a session value (FCS-SECRET-001)
print(r.keys("session:*"))                            # KEYS in prod — blocks the server
# redis.conf: requirepass "" , save 900 1 , appendonly yes
#   -> plaintext PAN/CVV persisted to an unencrypted dump.rdb on disk
```

**Why refuse:** this crosses refusal-policy rules **1** (store PAN + CVV), **2** (store a password as a reversible value), **8** (plaintext transport, no TLS), and **10** (no auth / bound to all interfaces), and compounds them by persisting the plaintext to disk (`save`/`appendonly` on an unencrypted volume) and blocking the server with `KEYS` in production. The compliant rewrite is the Good example: **don't store PAN/CVV in Redis at all** (tokenize at the gateway, keep only a token); opaque session ids with a TTL, not passwords; TLS+mTLS+ACL least privilege; application-side AES-256-GCM for any sensitive cached value; `SCAN` not `KEYS`; and `save ""`/`appendonly no` so no plaintext reaches disk.

---

**References:** Redis TLS/encryption ([redis.io/docs .../security/encryption](https://redis.io/docs/latest/operate/oss_and_stack/management/security/encryption/)); Redis ACL ([redis.io/docs .../security/acl](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/)); Redis Cloud encryption at rest ([redis.io/docs/.../rc/security/encryption-at-rest](https://redis.io/docs/latest/operate/rc/security/encryption-at-rest/)); Redis Enterprise compliance & database auditing ([Securing Redis for Compliance](https://redis.io/blog/securing-redis-with-redis-enterprise-for-compliance-requirements/), [RS 6.2.18](https://redis.io/blog/redis-enterprise-software-6-2-18/)); Azure Managed Redis — RAM is not encrypted ([Microsoft Learn](https://learn.microsoft.com/en-us/azure/redis/secure-azure-managed-redis)); Configure ACLs in Redis Cloud ([redis.io/docs/.../rc/security/access-control](https://redis.io/docs/latest/operate/rc/security/access-control/data-access-control/configure-acls/)); PCI-DSS v4.0.1; GDPR/PSD2/DORA, SOX/GLBA/CCPA, FCA/UK GDPR, KVKK/BDDK/MASAK. See [`refusal/refusal-policy.md`](../refusal/refusal-policy.md) for the full red lines.
