'use strict';
// Pure (no-CLI, no-fs) self-test for the AUD-20261102-F01 applicability selector.
// Run: node installer/profile-selector.selftest.js
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { selectForProfile } = require('./profile-selector');

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'controls', 'catalog.json'), 'utf8'));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const status = (sel, id) =>
  sel.applicable.some((d) => d.id === id) ? 'applicable'
  : sel.not_applicable.some((d) => d.id === id) ? 'not_applicable'
  : sel.needs_declaration.some((d) => d.id === id) ? 'needs_declaration'
  : 'absent';

// 1. EU bookkeeping vendor, NO card data, declared non-obliged role.
const euVendor = {
  profile_id: 'eu-vendor', entity_role: { kind: 'vendor_to_obliged_entity', activity: 'SaaS', declared: true },
  jurisdictions: ['EU'], data_categories: ['pii_identity', 'transaction_records', 'support_logs', 'marketing_consent'],
  payment_providers: [], stack: { languages: ['javascript-typescript'], databases: ['postgresql'] },
};
let s = selectForProfile(euVendor, catalog);
ok(status(s, 'FCS-PAN-001') === 'not_applicable', 'EU vendor: PAN duty NOT applicable (no card data)');
ok(status(s, 'FCS-SAD-001') === 'not_applicable', 'EU vendor: SAD duty NOT applicable (no card data)');
ok(status(s, 'FCS-AML-001') === 'not_applicable', 'EU vendor: AML duty NOT applicable (declared non-obliged role)');
ok(status(s, 'FCS-RETAIN-001') === 'applicable', 'EU vendor: retention applies (pii/marketing/support/txn)');
ok(s.security_policy.some((p) => p.id === 'FCS-PAN-001'), 'EU vendor: PAN still listed as always-on security policy (separate axis)');
ok(s.obliged_role === false, 'EU vendor: not an obliged role');

// 2. TR PSP, card + KYC data, declared obliged role, stripe provider.
const trPsp = {
  profile_id: 'tr-psp', entity_role: { kind: 'obliged_entity', activity: 'PSP', declared: true },
  jurisdictions: ['TR'], data_categories: ['pan', 'pii_identity', 'kyc_records', 'transaction_records', 'auth_credentials'],
  payment_providers: ['stripe'], stack: { languages: ['csharp-dotnet'], databases: ['postgresql'] },
};
s = selectForProfile(trPsp, catalog);
ok(status(s, 'FCS-PAN-001') === 'applicable', 'TR PSP: PAN applicable (card data)');
ok(status(s, 'FCS-AML-001') === 'applicable', 'TR PSP: AML applicable (obliged role + kyc)');
ok(status(s, 'FCS-WEBHOOK-001') === 'applicable', 'TR PSP: webhook applicable (provider declared)');
ok(s.obliged_role === true, 'TR PSP: obliged role');

// 3. Unknown / undeclared role → role-gated duties are needs_declaration, never applied.
const unknownRole = {
  profile_id: 'unknown', entity_role: { kind: 'unknown', declared: false },
  jurisdictions: ['TR'], data_categories: ['kyc_records'], payment_providers: [],
};
s = selectForProfile(unknownRole, catalog);
ok(status(s, 'FCS-AML-001') === 'needs_declaration', 'Unknown role: AML needs_declaration (never auto-applied)');
ok(status(s, 'FCS-EVASION-001') === 'needs_declaration', 'Unknown role: evasion needs_declaration');
ok(s.obliged_role === false, 'Unknown role: not obliged');

// 4. SAD-only profile: SAD applies, PAN applies (sad implies card handling), AML not.
const sadOnly = {
  profile_id: 'sad-only', entity_role: { kind: 'processor', declared: true },
  jurisdictions: ['EU'], data_categories: ['sad'], payment_providers: [],
};
s = selectForProfile(sadOnly, catalog);
ok(status(s, 'FCS-SAD-001') === 'applicable', 'SAD-only: SAD applicable');
ok(status(s, 'FCS-AML-001') === 'not_applicable', 'SAD-only: AML not applicable (declared non-obliged, no kyc)');

// 5. Support/marketing-only: retention applies, PAN/SAD/AML/webhook do not.
const supportOnly = {
  profile_id: 'support-only', entity_role: { kind: 'vendor_to_obliged_entity', declared: true },
  jurisdictions: ['EU'], data_categories: ['support_logs', 'marketing_consent'], payment_providers: [],
};
s = selectForProfile(supportOnly, catalog);
ok(status(s, 'FCS-RETAIN-001') === 'applicable', 'support/marketing: retention applicable');
ok(status(s, 'FCS-PAN-001') === 'not_applicable', 'support/marketing: PAN not applicable');
ok(status(s, 'FCS-WEBHOOK-001') === 'not_applicable', 'support/marketing: webhook not applicable (no provider)');

// 6. Same stack, different jurisdiction/provider → provider gate flips, jurisdiction alone does not
//    invent obligations.
const noProvider = { ...trPsp, profile_id: 'tr-psp-noprov', payment_providers: [] };
s = selectForProfile(noProvider, catalog);
ok(status(s, 'FCS-WEBHOOK-001') === 'not_applicable', 'TR PSP w/o provider: webhook not applicable');
ok(status(s, 'FCS-PAN-001') === 'applicable', 'TR PSP w/o provider: PAN still applicable (card data unchanged)');

// 7. F01 round 3: internal retryable transfers need idempotency even with NO provider.
const { decideControl } = require('./profile-selector');
const ctl = (id) => catalog.controls.find((c) => c.id === id);
const internalApi = {
  profile_id: 'internal-transfer-api',
  entity_role: { kind: 'obliged_entity', declared: true, activity: 'PSP; internal transfers over retryable HTTP API' },
  jurisdictions: ['TR'], data_categories: ['transaction_records', 'auth_credentials'], payment_providers: [],
  stack: { languages: ['csharp-dotnet'], databases: ['postgresql'], detected: false },
};
let d = decideControl(ctl('FCS-IDEMP-001'), internalApi);
ok(d.status === 'needs_declaration', `internal API, operations undeclared: IDEMP needs_declaration (got ${d.status})`);
d = decideControl(ctl('FCS-IDEMP-001'), { ...internalApi, operations: ['internal_transfer'] });
ok(d.status === 'applicable', 'internal API + declared internal_transfer: IDEMP applicable without a provider');
d = decideControl(ctl('FCS-IDEMP-001'), { ...internalApi, operations: ['reporting_only'] });
ok(d.status === 'not_applicable', 'declared reporting_only + providers []: IDEMP not_applicable');
d = decideControl(ctl('FCS-IDEMP-001'), { ...internalApi, operations: ['reporting_only'], payment_providers: undefined });
ok(d.status === 'needs_declaration', 'reporting_only but providers undeclared: IDEMP needs_declaration');
ok(decideControl(ctl('FCS-IDEMP-001'), trPsp).status === 'applicable', 'TR PSP with provider: IDEMP applicable');
// free-text activity is never parsed into a decision
d = decideControl(ctl('FCS-IDEMP-001'), { ...internalApi, entity_role: { ...internalApi.entity_role, activity: 'reporting only, no money' } });
ok(d.status === 'needs_declaration', 'activity text does not change the IDEMP decision');

// 8. F01 round 3: an OMITTED optional field is not a declared-empty field.
const undeclared = { profile_id: 'undeclared-data', entity_role: { kind: 'vendor_to_obliged_entity', declared: true }, jurisdictions: ['EU'] };
ok(decideControl(ctl('FCS-PAN-001'), undeclared).status === 'needs_declaration', 'data_categories omitted: PAN needs_declaration');
ok(decideControl(ctl('FCS-PAN-001'), { ...undeclared, data_categories: [] }).status === 'not_applicable', 'data_categories []: PAN not_applicable');
ok(decideControl(ctl('FCS-WEBHOOK-001'), undeclared).status === 'needs_declaration', 'payment_providers omitted: webhook needs_declaration');
ok(decideControl(ctl('FCS-WEBHOOK-001'), { ...undeclared, payment_providers: [] }).status === 'not_applicable', 'payment_providers []: webhook not_applicable');
ok(decideControl(ctl('FCS-AML-001'), undeclared).status === 'not_applicable', 'declared vendor role: AML not_applicable regardless of data');
// same profile, different jurisdiction: a global engineering control does not flip
ok(decideControl(ctl('FCS-IDEMP-001'), { ...internalApi, jurisdictions: ['EU'] }).status === decideControl(ctl('FCS-IDEMP-001'), internalApi).status,
  'jurisdiction change alone does not invent a different IDEMP result');
// the new optional field is schema-valid; an unknown operation is rejected
const { validate } = require('../controls/jsonschema');
const pschema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'controls', 'schema', 'profile.schema.json'), 'utf8'));
ok(validate(undeclared, pschema).length === 0, 'undeclared-data profile is schema-valid');
ok(validate({ ...internalApi, operations: ['internal_transfer'] }, pschema).length === 0, 'operations field is schema-valid');
ok(validate({ ...internalApi, operations: ['teleport'] }, pschema).length > 0, 'unknown operation is rejected by the schema');

console.log(`profile-selector self-test: ${n} checks passed`);
