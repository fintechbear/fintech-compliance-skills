'use strict';
// Pure test for AUD-20261102-F13 evidence rules. Run: node controls/evidence.selftest.js
const assert = require('node:assert/strict');
const { evidenceKind, checkReviewedAt, summarizeEvidence, REVIEW_MAX_AGE_DAYS } = require('./evidence');
const catalog = require('./catalog.json');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

ok(evidenceKind('skills/core/fintech-pr-review.md') === 'document', '.md is document evidence');
ok(evidenceKind('examples/ts-postgres-harness/refund.ts') === 'executable', '.ts is executable');
ok(evidenceKind('examples/dotnet-postgres-harness/') === 'executable', 'harness dir is executable');

const today = new Date(Date.UTC(2026, 10, 2));
ok(checkReviewedAt('2026-10-28', today).ok, 'valid recent date');
ok(!checkReviewedAt('2026-02-30', today).ok, 'impossible date rejected');
ok(!checkReviewedAt('28/10/2026', today).ok, 'non-ISO rejected');
ok(!checkReviewedAt('2027-01-01', today).ok, 'future date rejected');
ok(checkReviewedAt('2024-01-01', today).stale === true, `older than ${REVIEW_MAX_AGE_DAYS} days is stale`);
ok(checkReviewedAt(null, today).never === true, 'null = never reviewed');

// A control whose only "tests" are Markdown has zero executable tests.
ok(summarizeEvidence({ test_refs: ['skills/x.md'] }).executable_tests === 0, 'Markdown-only test_refs -> 0 executable tests');
// The real catalog: the two Markdown-evidenced controls are not counted as tested.
for (const id of ['FCS-SECRET-002', 'FCS-PRREVIEW-001']) {
  const c = catalog.controls.find((x) => x.id === id);
  const ev = summarizeEvidence(c);
  ok(ev.executable_tests === 0 && ev.document_evidence > 0, `${id}: document evidence only`);
}
// Combined/jurisdiction-specific legal claims are not marked verified without confirmation.
for (const id of ['FCS-EVASION-001', 'FCS-RETAIN-001']) {
  const c = catalog.controls.find((x) => x.id === id);
  ok(c.review_status !== 'verified', `${id}: not verified while law sources are unconfirmed`);
  ok(c.source_refs.filter((s) => s.kind === 'law').every((s) => s.verified === false), `${id}: law refs unverified`);
  ok(!c.source_refs.some((s) => s.kind === 'law' && /fatf-gafi\.org/.test(s.url || '')), `${id}: FATF not labelled as law`);
}
const retain = catalog.controls.find((x) => x.id === 'FCS-RETAIN-001');
ok(retain.source_refs.length >= 3 && retain.source_refs.some((s) => /KVKK/.test(s.label)) && retain.source_refs.some((s) => /2016\/679/.test(s.label)), 'FCS-RETAIN-001: EU and TR are separate sources');

console.log(`evidence self-test: ${n} checks passed`);
