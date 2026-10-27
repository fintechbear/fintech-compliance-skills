#!/usr/bin/env node
// Validate the FCS control catalog, profiles, and cross-references.
// Checks (P03 acceptance): schema shape, unknown FCS ids cited in skills,
// broken skill_refs/test_refs, duplicate/reused ids, profile conflicts,
// and review staleness. Exit non-zero on any error. Zero runtime deps.
'use strict';
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const errors = [];
const warnings = [];
function err(m) { errors.push(m); }
function warn(m) { warnings.push(m); }
function rel(p) { return path.join(repoRoot, p.replace(/\//g, path.sep)); }
function readJSON(p) { return JSON.parse(fs.readFileSync(rel(p), 'utf8')); }

// --- 1. Load + shape-check the catalog ---
const catalog = readJSON('controls/catalog.json');
const ids = new Set();
const ID_RE = /^FCS-[A-Z]+-[0-9]{3}$/;
const STATUS = new Set(['verified', 'needs_review', 'unverified']);
const TYPES = new Set(['refusal_red_line', 'preventive', 'detective', 'process', 'data_handling']);
const SRC_KINDS = new Set(['law', 'standard', 'project_policy', 'engineering_recommendation']);

for (const c of catalog.controls) {
  if (!ID_RE.test(c.id || '')) { err(`bad control id: ${c.id}`); continue; }
  if (ids.has(c.id)) err(`duplicate control id: ${c.id}`);
  ids.add(c.id);
  if (!c.statement || c.statement.length < 10) err(`${c.id}: statement too short`);
  if (!TYPES.has(c.control_type)) err(`${c.id}: bad control_type ${c.control_type}`);
  if (!STATUS.has(c.review_status)) err(`${c.id}: bad review_status ${c.review_status}`);
  if (!Array.isArray(c.source_refs) || c.source_refs.length < 1) err(`${c.id}: needs >=1 source_ref`);
  else for (const s of c.source_refs) {
    if (!SRC_KINDS.has(s.kind)) err(`${c.id}: bad source kind ${s.kind}`);
    if (!s.label) err(`${c.id}: source_ref missing label`);
  }
  if (!c.owner_role) err(`${c.id}: missing owner_role`);
  // staleness: a 'verified' claim with no reviewed_at is suspicious
  if (c.review_status === 'verified' && !c.reviewed_at) warn(`${c.id}: verified but reviewed_at is null`);
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
  // no legacy numbered citations should remain (except the policy file's own worked example)
  if (!f.endsWith(path.join('refusal', 'refusal-policy.md'))) {
    const legacy = text.match(/refusal\s+(policy\s+)?rule\s+\d/gi);
    if (legacy) err(`${path.relative(repoRoot, f)}: still has legacy numbered citation(s): ${legacy.join(', ')}`);
  }
}

// --- 3. Profiles: schema-ish + conflict surfacing ---
const profDir = rel('controls/profiles');
if (fs.existsSync(profDir)) {
  for (const pf of fs.readdirSync(profDir).filter((x) => x.endsWith('.json'))) {
    const p = readJSON(`controls/profiles/${pf}`);
    if (!p.profile_id) err(`${pf}: missing profile_id`);
    if (!p.entity_role || p.entity_role.declared !== true) err(`${pf}: entity_role must be explicitly declared (declared:true)`);
    if (!Array.isArray(p.jurisdictions) || p.jurisdictions.length < 1) err(`${pf}: needs >=1 jurisdiction`);
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
