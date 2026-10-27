#!/usr/bin/env node
// Validate the FCS control catalog, profiles, and cross-references.
// Checks (P03 acceptance): schema shape, unknown FCS ids cited in skills,
// broken skill_refs/test_refs, duplicate/reused ids, profile conflicts,
// and review staleness. Exit non-zero on any error. Zero runtime deps.
'use strict';
const fs = require('fs');
const path = require('path');
const { validate } = require('./jsonschema.js');

const repoRoot = path.resolve(__dirname, '..');
const errors = [];
const warnings = [];
function err(m) { errors.push(m); }
function warn(m) { warnings.push(m); }
function rel(p) { return path.join(repoRoot, p.replace(/\//g, path.sep)); }
function readJSON(p) { return JSON.parse(fs.readFileSync(rel(p), 'utf8')); }

// --- schemas (R11: enforce the real JSON Schemas, not ad-hoc shape checks) ---
const CONTROL_SCHEMA = readJSON('controls/schema/control.schema.json');
const PROFILE_SCHEMA = readJSON('controls/schema/profile.schema.json');

// --- 1. Load + schema-validate the catalog ---
const catalog = readJSON('controls/catalog.json');
const ids = new Set();

for (const c of catalog.controls) {
  // Real schema validation first: enum, additionalProperties:false, $ref source_refs, etc.
  for (const e of validate(c, CONTROL_SCHEMA)) err(`control ${c.id || '(no id)'}${e}`);
  if (ids.has(c.id)) err(`duplicate control id: ${c.id}`);
  if (c.id) ids.add(c.id);
  // staleness: a 'verified' claim with no reviewed_at is an error (not just a warning):
  // a verified status asserts a human confirmed article+scope, which requires a review date.
  if (c.review_status === 'verified' && !c.reviewed_at) err(`${c.id}: review_status 'verified' requires a reviewed_at date`);
  // a source_ref marked verified:true while the control is not 'verified' is contradictory
  for (const s of (c.source_refs || [])) {
    if (s && s.verified === true && c.review_status !== 'verified') {
      warn(`${c.id}: source_ref '${s.label}' claims verified:true but control review_status is ${c.review_status}`);
    }
  }
  // broken skill_refs / test_refs
  for (const sk of (c.skill_refs || [])) if (!fs.existsSync(rel(sk))) err(`${c.id}: skill_ref not found: ${sk}`);
  for (const tr of (c.test_refs || [])) {
    const p = rel(tr);
    if (!fs.existsSync(p) && !fs.existsSync(p.replace(/[\\/]$/, ''))) err(`${c.id}: test_ref not found: ${tr}`);
  }
}

// --- 2. Unknown FCS ids cited anywhere in skills/ ---
function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}
const skillFiles = walk(rel('skills'), []);
const citeRe = /FCS-[A-Z]+-[0-9]{3}/g;
for (const f of skillFiles) {
  const text = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = citeRe.exec(text))) {
    if (!ids.has(m[0])) err(`${path.relative(repoRoot, f)}: cites unknown control id ${m[0]}`);
  }
  // no legacy numbered citations should remain (except the policy file's own worked example).
  // Catch singular, comma/slash/ampersand/"and" lists, with or without the word "refusal".
  if (!f.endsWith(path.join('refusal', 'refusal-policy.md'))) {
    const legacy = text.match(/\brules?\s+\d/gi);
    if (legacy) err(`${path.relative(repoRoot, f)}: still has legacy numbered citation(s): ${legacy.join(', ')}`);
  }
}

// --- 3. Profiles: real schema validation + conflict surfacing ---
const profDir = rel('controls/profiles');
if (fs.existsSync(profDir)) {
  for (const pf of fs.readdirSync(profDir).filter((x) => x.endsWith('.json'))) {
    const p = readJSON(`controls/profiles/${pf}`);
    for (const e of validate(p, PROFILE_SCHEMA)) err(`profile ${pf}${e}`);
    // declared must be true (schema allows the boolean; the project rule is it must be true)
    if (p.entity_role && p.entity_role.declared !== true) err(`${pf}: entity_role.declared must be true (legal role is declared, never inferred)`);
    // conflict: a vendor profile that also claims to run AML screening is surfaced, not auto-resolved
    if (p.entity_role && p.entity_role.kind === 'vendor_to_obliged_entity') {
      const txt = JSON.stringify(p).toLowerCase();
      if (/\bperforms? (kyc|aml) screening\b/.test(txt)) warn(`${pf}: vendor profile asserts it performs screening — surface this conflict for review`);
    }
  }
}

// --- report ---
console.log(JSON.stringify({ controls: ids.size, skill_files: skillFiles.length, errors, warnings }, null, 2));
if (errors.length) { console.error(`\nFAIL: ${errors.length} error(s)`); process.exit(1); }
console.log(`\nOK: catalog + ${skillFiles.length} skills + profiles valid (${warnings.length} warning(s))`);
