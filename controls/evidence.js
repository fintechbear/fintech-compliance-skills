'use strict';
// AUD-20261102-F13: pure helpers that keep evidence honest.
//  - A Markdown/rubric file is DOCUMENT evidence; it is never counted as an executable test.
//  - reviewed_at must be a real ISO calendar date, not in the future; reviews older than the
//    declared policy age are reported as stale (visible warning, not silently "verified").

const EXECUTABLE_EXT = /\.(js|mjs|cjs|ts|cs|sh|py|sql)$/i;
const DOCUMENT_EXT = /\.(md|markdown|txt)$/i;

// Policy: a verified source claim should be re-reviewed at least once a year.
const REVIEW_MAX_AGE_DAYS = 365;

function evidenceKind(relPath) {
  const p = String(relPath || '').replace(/[\\/]+$/, '');
  if (DOCUMENT_EXT.test(p)) return 'document';
  if (EXECUTABLE_EXT.test(p)) return 'executable';
  if (/(^|\/)examples\/[^/]+$/.test(p)) return 'executable'; // a harness directory
  return 'unknown';
}

// Returns { ok, error?, ageDays? } for a reviewed_at value.
function checkReviewedAt(value, today = new Date()) {
  if (value === null || value === undefined) return { ok: true, never: true };
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, error: `reviewed_at '${value}' is not an ISO date (YYYY-MM-DD)` };
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { ok: false, error: `reviewed_at '${value}' is not a real calendar date` };
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const ageDays = Math.floor((todayUtc - dt.getTime()) / 86400000);
  if (ageDays < 0) return { ok: false, error: `reviewed_at '${value}' is in the future` };
  return { ok: true, ageDays, stale: ageDays > REVIEW_MAX_AGE_DAYS };
}

// Count evidence for a control without inflating it.
function summarizeEvidence(control) {
  const tests = (control.test_refs || []);
  const docs = (control.document_refs || []);
  return {
    executable_tests: tests.filter((t) => evidenceKind(t) === 'executable').length,
    document_evidence: docs.length + tests.filter((t) => evidenceKind(t) === 'document').length,
  };
}

module.exports = { evidenceKind, checkReviewedAt, summarizeEvidence, REVIEW_MAX_AGE_DAYS };
