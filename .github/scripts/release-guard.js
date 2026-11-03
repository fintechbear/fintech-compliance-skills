'use strict';
// AUD-20261102-F16: pure publish-subject guard. Decides whether a run may PUBLISH or must stay
// PACK-ONLY, from plain facts the workflow gathers. No network, no git calls inside decide().
//
// Rules:
//  - Publishing requires a release tag ref (refs/tags/vX.Y.Z) — for BOTH a tag push and a manual
//    dispatch. A dispatch on a branch is pack-only, always.
//  - The tag must equal "v" + package.json version.
//  - The tagged commit must already be on main (approved, merged source), proven by ancestry.
//  - A dispatch that asks to publish must name the exact approved commit (expected_sha) and it
//    must equal the commit being built.
//  - The version must not already be on the registry (no second publish from tag + dispatch).
//  - The stamped source identity (installer/source.generated.json) must equal the built commit.
const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function decide(f) {
  const reasons = [];
  const wantsPublish = f.event === 'push' || (f.event === 'workflow_dispatch' && f.mode === 'publish');
  const tag = f.ref && f.ref.startsWith('refs/tags/') ? f.ref.slice('refs/tags/'.length) : null;
  if (!wantsPublish) return { publish: false, reasons: ['pack-only run (dispatch default)'] };
  if (!['push', 'workflow_dispatch'].includes(f.event)) reasons.push(`event '${f.event}' cannot publish`);
  if (!tag) reasons.push(`ref '${f.ref}' is not a release tag`);
  else if (!SEMVER_TAG.test(tag)) reasons.push(`tag '${tag}' is not vMAJOR.MINOR.PATCH`);
  else if (tag !== `v${f.pkgVersion}`) reasons.push(`tag '${tag}' does not match package.json v${f.pkgVersion}`);
  if (f.onMain !== true) reasons.push(`commit ${f.sha} is not on main (approved source)`);
  if (f.event === 'workflow_dispatch' && f.expectedSha !== f.sha) reasons.push(`dispatch expected_sha '${f.expectedSha || ''}' does not equal the built commit ${f.sha}`);
  if (f.alreadyPublished === true) reasons.push(`version ${f.pkgVersion} is already on the registry`);
  if (f.stampedCommit !== f.sha) reasons.push(`stamped source commit '${f.stampedCommit}' does not equal the built commit ${f.sha}`);
  return reasons.length ? { publish: false, refused: true, reasons } : { publish: true, reasons: ['all publish conditions met'] };
}

module.exports = { decide, SEMVER_TAG };

// CLI entry used by the workflow: reads facts from env, prints the decision, writes GITHUB_OUTPUT.
if (require.main === module) {
  const e = process.env;
  const facts = {
    event: e.FCS_EVENT, ref: e.FCS_REF, sha: e.FCS_SHA, mode: e.FCS_MODE || 'pack-only',
    expectedSha: e.FCS_EXPECTED_SHA || '', pkgVersion: e.FCS_PKG_VERSION,
    onMain: e.FCS_ON_MAIN === 'true', alreadyPublished: e.FCS_ALREADY_PUBLISHED === 'true',
    stampedCommit: e.FCS_STAMPED_COMMIT || '',
  };
  const d = decide(facts);
  console.log(JSON.stringify({ facts, decision: d }, null, 2));
  if (e.GITHUB_OUTPUT) require('fs').appendFileSync(e.GITHUB_OUTPUT, `publish=${d.publish}\n`);
  // A run that ASKED to publish and was refused fails loudly; a pack-only run succeeds.
  process.exit(d.refused ? 1 : 0);
}
