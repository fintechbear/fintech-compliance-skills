'use strict';
// Pure content checks for AUD-20261102-F09 (AML match handling + Turkey scope). Reads skills only.
// Run: node installer/content-consistency.selftest.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listSkillFiles } = require('./index');
const { selectForProfile } = require('./profile-selector');
const catalog = require('../controls/catalog.json');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const skills = listSkillFiles().map((s) => ({ ...s, text: fs.readFileSync(s.abs, 'utf8') }));

// 1. No skill still teaches "every hit -> hold/decline".
const BAD_AML = [/\ba hit (is|holds)\b/i, /sanctions\.hit\(/i, /\bsanctions\/AML(\/MASAK)? holds?\b/i];
for (const s of skills) for (const re of BAD_AML) ok(!re.test(s.text), `${s.file}: still says ${re}`);

// 2. The AML good example maps distinct screening states to distinct outcomes.
const aml = skills.find((s) => s.file === 'aml-kyc.md').text;
const good = aml.slice(aml.indexOf('## Good example'), aml.indexOf('## Bad example'));
for (const [state, outcome] of [['confirmed_sanctions_match', 'block('], ['candidate_match', 'pending_review('], ['pep', 'require_enhanced_due_diligence(']]) {
  const i = good.indexOf(`"${state}"`);
  ok(i > 0 && good.indexOf(outcome, i) > i && good.indexOf(outcome, i) - i < 160, `aml-kyc good example: ${state} -> ${outcome}`);
}

// 3. Every Turkey country summary is scoped by role, not by customer nationality.
const NATIONALITY = [/of Turkish customers/i, /Turkish customers.{0,3}financial data/i, /Turkish banking data must/i];
let turkeyBullets = 0;
for (const s of skills) {
  const m = s.text.match(/- \*\*Turkey [\u2014-] KVKK, BDDK, MASAK\.\*\*[^\n]*(\n {2,}[^\n]*)*/g) || [];
  for (const b of m) {
    turkeyBullets++;
    ok(/Scope first:/.test(b), `${s.file}: Turkey summary states the role scope`);
    for (const re of NATIONALITY) ok(!re.test(b), `${s.file}: Turkey summary derives duty from nationality (${re})`);
  }
}
ok(turkeyBullets >= 15, `found ${turkeyBullets} Turkey summaries`);

// 4. Role decides the AML duty: TR bank and TR PSP are obliged, a TR software vendor is not.
const base = { jurisdictions: ['TR'], data_categories: ['kyc_records', 'transaction_records'], payment_providers: [] };
const aml1 = (kind) => [...selectForProfile({ ...base, profile_id: kind, entity_role: { kind, declared: true } }, catalog).applicable].some((d) => d.id === 'FCS-AML-001');
ok(aml1('bank') === true, 'TR bank: AML applicable');
ok(aml1('payment_institution') === true, 'TR PSP: AML applicable');
ok(aml1('vendor_to_obliged_entity') === false, 'TR software vendor: AML not applicable to the vendor');

// 5. Regional skill keeps transfer and localization distinct.
const tr = skills.find((s) => s.file === 'turkey-kvkk-bddk-masak.md').text;
ok(/Cross-border transfer/i.test(tr) && /Data localization/i.test(tr) && /DISTINCT/.test(tr), 'regional TR skill separates transfer from localization');

console.log(`content-consistency self-test: ${n} checks passed`);
