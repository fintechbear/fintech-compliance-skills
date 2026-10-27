#!/usr/bin/env node
// Second-pass migration: the first pass only handled singular "refusal rule N".
// Many files also cite MULTIPLE rules in one phrase — "rules 1, 3", "rule 2/4",
// "rules 4, 7", "rules 1, 3, 4", "rule 8/10" — using the OLD (drifted) numbering.
// These are resolved to FCS id SETS by context pattern, ordered longest-first so
// "rules 1, 3, 4" is matched before "rules 1, 3". Idempotent: re-running changes 0.
'use strict';
const fs = require('fs');
const path = require('path');
const repoRoot = path.resolve(__dirname, '..');

// Context-verified: in the OLD numbering these files used,
//   1=PAN/CVV storage, 2=password plaintext, 3=logging, 4=broken crypto,
//   7=hardcoded key, 8=TLS/plaintext transport, 10=open/no-auth.
// Each phrase maps to the FCS id set its surrounding text is actually about.
// Replacement keeps the human "rule(s)" wording out and substitutes the ids.
const RULES = [
  // multi-rule prose with "&" or parenthetical glosses, longest/most-specific first
  { re: /\brules?\s+1\s*\(store[^)]*\)\s*,\s*2\s*\([^)]*\)[^.]*/gi, to: 'FCS-PAN-001/FCS-SAD-001 (store PAN/CVV), FCS-SECRET-001/FCS-CRYPTO-001 (broken password hash), FCS-SECRET-002 (hardcoded key), FCS-AUDIT-001 (no audit)' },
  { re: /\brules?\s+8\s*&\s*10\b/gi, to: 'FCS-TLS-001/FCS-AUTHZ-001' },
  { re: /\brules?\s+4\s*&\s*7\b/gi, to: 'FCS-CRYPTO-001/FCS-SECRET-002' },
  { re: /\brules?\s+2\s*&\s*4\b/gi, to: 'FCS-SECRET-001/FCS-CRYPTO-001' },
  { re: /\brules?\s+1\s*&\s*3\b/gi, to: 'FCS-PAN-001/FCS-SAD-001/FCS-LOG-001' },
  { re: /\brules?\s+1\s*&\s*4\b/gi, to: 'FCS-PAN-001/FCS-SAD-001' }, // sql-server: PAN cleartext + CVV stored
  { re: /\brules?\s+1\s+and\s+3\b/gi, to: 'FCS-PAN-001/FCS-SAD-001/FCS-LOG-001' }, // "dropped, never masked-then-logged"
  { re: /\brules?\s+2\s*,\s*3\b/gi, to: 'FCS-SECRET-001/FCS-LOG-001' }, // RACF: never store/compare passwords
  // most specific / longest number lists first
  { re: /\brules?\s+1\s*,\s*3\s*,\s*4\b/gi, to: 'FCS-PAN-001/FCS-SAD-001/FCS-LOG-001' }, // never-logged list (PAN/CVV + logging)
  { re: /\brules?\s+4\s*\/\s*7\s*\/\s*8\b/gi, to: 'FCS-SECRET-002/FCS-CRYPTO-001/FCS-TLS-001' },
  { re: /\brules?\s+1\s*,\s*3\b/gi, to: 'FCS-PAN-001/FCS-SAD-001/FCS-LOG-001' }, // storing/logging PAN & CVV
  { re: /\brules?\s+1\s*,\s*2\b/gi, to: 'FCS-PAN-001/FCS-SAD-001/FCS-SECRET-001' },
  { re: /\brules?\s+2\s*,\s*4\b/gi, to: 'FCS-SECRET-001/FCS-CRYPTO-001' },
  { re: /\brules?\s+2\s*\/\s*4\b/gi, to: 'FCS-SECRET-001/FCS-CRYPTO-001' },
  { re: /\brules?\s+4\s*,\s*7\b/gi, to: 'FCS-SECRET-002/FCS-CRYPTO-001' },
  { re: /\brules?\s+8\s*\/\s*10\b/gi, to: 'FCS-TLS-001/FCS-AUTHZ-001' },
  // singular comment/prose citations — meaning is fixed per number in the OLD numbering
  // these files used (verified against each line's surrounding text).
  // NOTE: rule 10 MUST come before rule 1 (prefix overlap).
  { re: /\brule\s+10\b/gi, to: 'FCS-AUTHZ-001' },          // open / no-auth / least-privilege
  { re: /\brule\s+1\b/gi, to: 'FCS-PAN-001/FCS-SAD-001' }, // raw PAN / CVV storage
  { re: /\brule\s+2\b/gi, to: 'FCS-SECRET-001' },          // plaintext/reversible password
  { re: /\brule\s+3\b/gi, to: 'FCS-LOG-001' },             // logging sensitive data
  { re: /\brule\s+4\b/gi, to: 'FCS-CRYPTO-001' },          // broken crypto / ECB
  { re: /\brule\s+6\b/gi, to: 'FCS-AUDIT-001' },           // money moved without audit
  { re: /\brule\s+7\b/gi, to: 'FCS-SECRET-002' },          // hardcoded key/credential
  { re: /\brule\s+8\b/gi, to: 'FCS-TLS-001' },             // TLS off / plaintext transport
];

const dryRun = process.argv.includes('--check');
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.md')) files.push(f); } })(path.join(repoRoot, 'skills'));

let changed = 0;
const perFile = {};
for (const f of files) {
  if (f.endsWith(path.join('refusal', 'refusal-policy.md'))) continue; // keep its worked example
  let text = fs.readFileSync(f, 'utf8');
  let n = 0;
  for (const r of RULES) { text = text.replace(r.re, () => { n++; return r.to; }); }
  if (n > 0) {
    if (!dryRun) fs.writeFileSync(f, text, 'utf8');
    changed += n;
    perFile[path.relative(repoRoot, f).replace(/\\/g, '/')] = n;
  }
}
console.log(JSON.stringify({ mode: dryRun ? 'check' : 'apply', changed, perFile }, null, 2));
// In --check mode, a non-zero 'changed' means drift remains -> fail.
process.exit(dryRun && changed > 0 ? 1 : 0);
