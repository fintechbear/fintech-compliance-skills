'use strict';
// AUD-20261102-F01: pure, versioned, auditable profile applicability selector.
//
// It separates TWO independent axes that the old cmdExplain conflated:
//
//   1. security_policy  — the secure-coding / refusal policy that is ALWAYS loaded regardless of
//      profile (it never ships dangerous code). This is NOT a legal obligation imposed on the
//      entity; it is a property of how code is written.
//
//   2. legal_applicability — whether a control's underlying obligation applies to THIS declared
//      entity, decided from the profile's DECLARED role, jurisdictions, data categories and
//      payment providers. Each control gets one of:
//        'applicable'        — a declared input triggers it (with the concrete reason)
//        'not_applicable'    — a required input is declared ABSENT (e.g. no card data → no PAN duty)
//        'needs_declaration' — applicability depends on a role/input the profile did not declare
//
// An unknown / undeclared role is NEVER treated as an obliged entity. The profile's declaration is
// used as given; the entity's role is never inferred from its stack or from "has Turkish users".
//
// This module is pure (no fs, no process): it takes a parsed profile + parsed catalog and returns
// a structured decision per control. It is unit-testable without any CLI or install.

const SELECTOR_VERSION = '1.0.0';

// Explicit, documented applicability requirements per control id. A control is a legal/regulatory
// obligation only when its REQUIRED declared inputs are present. Kept here (selector-owned) rather
// than in the catalog so this does not change catalog content (that is the content owner's axis).
//
// requires.anyDataCategory: applicable iff the profile declares ANY of these data categories.
// requires.role:            applicable only if the entity declared an obliged role (AML duties).
// requires.anyProvider:     applicable iff the profile declares a payment provider.
// alwaysSecurityPolicy:     this control is also part of the always-loaded secure-coding policy.
const APPLICABILITY = {
  'FCS-PAN-001':      { anyDataCategory: ['pan'], alwaysSecurityPolicy: true },
  'FCS-SAD-001':      { anyDataCategory: ['pan', 'sad'], alwaysSecurityPolicy: true },
  'FCS-SECRET-001':   { anyDataCategory: ['auth_credentials'], alwaysSecurityPolicy: true },
  'FCS-SECRET-002':   { anyDataCategory: ['auth_credentials'], alwaysSecurityPolicy: true },
  'FCS-LOG-001':      { alwaysSecurityPolicy: true }, // logging hygiene applies to any component
  'FCS-TLS-001':      { alwaysSecurityPolicy: true }, // transport security applies to any component
  'FCS-CRYPTO-001':   { alwaysSecurityPolicy: true },
  'FCS-AML-001':      { role: 'obliged', anyDataCategory: ['kyc_records'] },
  'FCS-EVASION-001':  { role: 'obliged' },
  'FCS-AUDIT-001':    { anyDataCategory: ['transaction_records'] },
  'FCS-RETAIN-001':   { anyDataCategory: ['pii_identity', 'marketing_consent', 'support_logs', 'kyc_records', 'transaction_records'] },
  'FCS-MONEY-001':    { anyDataCategory: ['transaction_records'] },
  'FCS-WEBHOOK-001':  { anyProvider: true },
  'FCS-OUTCOME-001':  { anyProvider: true },
  'FCS-IDEMP-001':    { anyProvider: true },
  'FCS-AUTHZ-001':    { anyDataCategory: ['transaction_records', 'pii_identity'] },
  'FCS-PRREVIEW-001': { alwaysSecurityPolicy: true },
  'FCS-OUTBOX-001':      { anyProvider: true },
  'FCS-REFUND-001':      { anyProvider: true },
  'FCS-REFUNDTERM-001':  { anyProvider: true },
  'FCS-RECON-001':       { anyProvider: true },
  'FCS-LEDGER-001':      { anyDataCategory: ['transaction_records'] },
  'FCS-ERASE-001':       { anyDataCategory: ['pii_identity', 'kyc_records', 'marketing_consent', 'support_logs', 'transaction_records'] },
};

// Roles we recognise as "obliged" (carry AML/sanctions duties). Anything else — including an
// undeclared role — is NOT obliged.
const OBLIGED_ROLES = new Set(['obliged_entity', 'financial_institution', 'payment_institution', 'emi', 'bank']);

function isObligedRole(profile) {
  const er = profile.entity_role;
  return !!(er && er.declared === true && OBLIGED_ROLES.has(er.kind));
}

// Decide legal applicability for one control given the declared profile.
function decideControl(control, profile) {
  const req = APPLICABILITY[control.id] || {};
  const declaredCats = new Set(profile.data_categories || []);
  const declaredProviders = (profile.payment_providers || []);
  const roleDeclared = !!(profile.entity_role && profile.entity_role.declared === true);

  const reasons = [];
  // Role-gated obligations (AML, evasion): need a DECLARED obliged role.
  if (req.role === 'obliged') {
    if (!roleDeclared) return { status: 'needs_declaration', reason: 'obligation depends on the entity role, which the profile did not declare' };
    if (!isObligedRole(profile)) return { status: 'not_applicable', reason: `declared role '${profile.entity_role.kind}' is not an obliged entity` };
    reasons.push(`declared obliged role '${profile.entity_role.kind}'`);
  }
  // Data-category-gated obligations.
  if (req.anyDataCategory) {
    const hits = req.anyDataCategory.filter((c) => declaredCats.has(c));
    if (!hits.length) return { status: 'not_applicable', reason: `no declared data category in {${req.anyDataCategory.join(', ')}}` };
    reasons.push(`data category ${hits.join('/')}`);
  }
  // Provider-gated obligations.
  if (req.anyProvider) {
    if (!declaredProviders.length) return { status: 'not_applicable', reason: 'no payment provider declared' };
    reasons.push(`payment provider ${declaredProviders.join('/')}`);
  }
  // No gating requirement listed → it is a baseline obligation that applies once the profile
  // exists (e.g. logging hygiene), unless the control id is unknown to this selector.
  if (!APPLICABILITY[control.id]) {
    return { status: 'needs_declaration', reason: 'control not mapped by the selector; declare applicability inputs or review manually' };
  }
  if (!reasons.length) reasons.push('baseline obligation (applies to any component in scope)');
  return { status: 'applicable', reason: reasons.join('; ') };
}

// Produce the full decision for a profile against a catalog.
function selectForProfile(profile, catalog) {
  const decisions = [];
  const securityPolicy = [];
  for (const c of catalog.controls) {
    const req = APPLICABILITY[c.id] || {};
    if (req.alwaysSecurityPolicy) {
      securityPolicy.push({ id: c.id, note: 'always loaded as secure-coding/refusal policy, independent of this profile' });
    }
    const d = decideControl(c, profile);
    decisions.push({ id: c.id, control_type: c.control_type, review_status: c.review_status, ...d });
  }
  return {
    selector_version: SELECTOR_VERSION,
    profile: profile.profile_id,
    role_declared: !!(profile.entity_role && profile.entity_role.declared === true),
    obliged_role: isObligedRole(profile),
    jurisdictions: profile.jurisdictions || [],
    // The always-on security policy is reported SEPARATELY so it is never presented as a
    // profile-specific legal obligation.
    security_policy: securityPolicy,
    applicable: decisions.filter((d) => d.status === 'applicable'),
    not_applicable: decisions.filter((d) => d.status === 'not_applicable'),
    needs_declaration: decisions.filter((d) => d.status === 'needs_declaration'),
  };
}

module.exports = { selectForProfile, decideControl, isObligedRole, SELECTOR_VERSION, APPLICABILITY, OBLIGED_ROLES };
