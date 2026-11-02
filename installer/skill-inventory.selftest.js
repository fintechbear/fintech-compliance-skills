'use strict';
// Pure (no-CLI, no install) content inventory checks.
// Run: node installer/skill-inventory.selftest.js
//
// AUD-20261102-F08: every topic skill must carry a usable description (not the "Purpose."
//   placeholder an old bold-text fallback produced) and must be listed in skills/INDEX.md.
// AUD-20261102-F02: in the C# good transfer example, the object-level debit authorization must
//   come BEFORE any idempotency replay. This is a STATIC ordering check on the teaching text; the
//   behavioural proof is the .NET real-PostgreSQL harness (Bank.cs, R02), run in CI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listSkillFiles, parseSkill } = require('./index');

const ROOT = path.join(__dirname, '..');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// Detector for the placeholder; exported shape kept local so it can be exercised directly.
const isPlaceholderDesc = (d) => { const t = String(d || '').trim(); return t.length < 20 || /^purpose\.?$/i.test(t); };
ok(isPlaceholderDesc('Purpose.') && isPlaceholderDesc('') && !isPlaceholderDesc('Write Python that is safe in a regulated system.'), 'placeholder detector works');

const index = fs.readFileSync(path.join(ROOT, 'skills', 'INDEX.md'), 'utf8');
const skills = listSkillFiles();
ok(skills.length >= 32, `expected >= 32 topic skills, got ${skills.length}`);
for (const s of skills) {
  const p = parseSkill(s.abs);
  ok(!isPlaceholderDesc(p.desc), `${s.group}/${s.name}: placeholder or empty description ${JSON.stringify(p.desc)}`);
  ok(index.includes(`(${s.group}/${s.file})`), `${s.group}/${s.file} is not linked from skills/INDEX.md`);
}

// F02 static ordering check on the C# good example.
const cs = fs.readFileSync(path.join(ROOT, 'skills', 'languages', 'csharp-dotnet.md'), 'utf8');
// Split into fenced blocks and take the one that implements the transfer endpoint.
const blocks = cs.split('```').filter((_, i) => i % 2 === 1);
const block = blocks.find((b) => b.includes('AccountGrants') && b.includes('IdempotencyRecords')) || '';
ok(block.length > 0, 'C# transfer example block found');
const authz = block.indexOf('AccountGrants');
const replayLookup = block.indexOf('IdempotencyRecords.AsNoTracking().FirstOrDefaultAsync');
const firstStoredReturn = block.indexOf('StoredResponse))');
ok(authz > 0 && replayLookup > 0 && firstStoredReturn > 0, 'authz, replay lookup and stored-response return all present');
ok(authz < replayLookup, 'F02: debit authorization precedes the idempotency replay lookup');
ok(authz < firstStoredReturn, 'F02: debit authorization precedes every stored-response return');

console.log(`skill-inventory self-test: ${n} checks passed`);
