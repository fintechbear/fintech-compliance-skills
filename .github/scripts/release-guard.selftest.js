'use strict';
// Pure test for the AUD-20261102-F16 publish guard. Run: node .github/scripts/release-guard.selftest.js
const assert = require('node:assert/strict');
const { decide } = require('./release-guard');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const SHA = 'b'.repeat(40);
const good = { event: 'push', ref: 'refs/tags/v1.0.0', sha: SHA, pkgVersion: '1.0.0', onMain: true, alreadyPublished: false, stampedCommit: SHA };

ok(decide(good).publish === true, 'tag push of an approved main commit publishes');
ok(decide({ ...good, ref: 'refs/heads/feature' }).publish === false, 'branch push cannot publish');
ok(decide({ ...good, ref: 'refs/tags/v1.0.1' }).publish === false, 'tag/version mismatch refused');
ok(decide({ ...good, ref: 'refs/tags/release-1' }).publish === false, 'non-semver tag refused');
ok(decide({ ...good, onMain: false }).publish === false, 'commit not on main refused');
ok(decide({ ...good, alreadyPublished: true }).publish === false, 'already-published version refused (no second publish)');
ok(decide({ ...good, stampedCommit: 'c'.repeat(40) }).publish === false, 'stamped source must equal the built commit');
ok(decide({ ...good, stampedCommit: '' }).publish === false, 'unpinned build cannot publish');

const d = { ...good, event: 'workflow_dispatch' };
ok(decide({ ...d, mode: 'pack-only' }).publish === false && !decide({ ...d, mode: 'pack-only' }).refused, 'dispatch defaults to pack-only (not an error)');
ok(decide({ ...d, mode: undefined }).publish === false, 'dispatch without mode is pack-only');
ok(decide({ ...d, mode: 'publish', expectedSha: SHA }).publish === true, 'dispatch on the tag with the approved sha publishes');
ok(decide({ ...d, mode: 'publish', expectedSha: '' }).publish === false, 'dispatch publish without expected_sha refused');
ok(decide({ ...d, mode: 'publish', expectedSha: SHA, ref: 'refs/heads/main' }).publish === false, 'dispatch publish from a branch refused');
ok(decide({ ...d, mode: 'publish', expectedSha: SHA, onMain: false }).publish === false, 'dispatch publish of an unmerged commit refused');
ok(decide({ ...good, event: 'pull_request' }).publish === false, 'other events never publish');

console.log(`release-guard self-test: ${n} checks passed`);
