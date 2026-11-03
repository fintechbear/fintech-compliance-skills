'use strict';
// Pure (no-CLI) test for AUD-20261102-F06(c): text outside the managed AGENTS.md block is user
// text and must survive install, re-install and uninstall byte-for-byte.
// Run: node installer/agents-block.selftest.js
const assert = require('node:assert/strict');
const { mergeCodexBlock, removeCodexBlock, BLOCK_START, BLOCK_END } = require('./index');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const text = (r) => (typeof r === 'string' ? r : r.text);
const S = BLOCK_START || '<!-- BEGIN fintech-compliance-skills (managed; do not edit inside) -->';
const E = BLOCK_END || '<!-- END fintech-compliance-skills -->';
const block = (v) => `${S}\nmanaged v${v}\n${E}`;

const prefix = 'My rules\r\nline A\n\n\n\nline B   \n\t\n';
// 1. first install appends: the whole user prefix stays at the start, byte-for-byte
const once = text(mergeCodexBlock(prefix, block(1)));
ok(once.startsWith(prefix), 'install: user prefix (CRLF, 4 newlines, trailing spaces/tab) unchanged');
ok(once.includes('line A\n\n\n\nline B'), 'install: run of 4 newlines not collapsed');

// 2. user adds a suffix AFTER our block; a re-install replaces the block in place
const suffix = '\n\n\n## after\r\nkeep   \n';
const withSuffix = once + suffix;
const twice = text(mergeCodexBlock(withSuffix, block(2)));
const blockAt = twice.indexOf(S);
ok(twice.slice(0, blockAt) === once.slice(0, once.indexOf(S)), 're-install: prefix bytes identical');
ok(twice.endsWith(suffix), 're-install: suffix bytes identical (not moved, not trimmed)');
ok(twice.includes('managed v2') && !twice.includes('managed v1'), 're-install: block content updated');
ok(text(mergeCodexBlock(twice, block(2))) === twice, 're-install is idempotent');

// 3. duplicate managed blocks: keep one, drop the duplicate span only
const dup = prefix + block(1) + '\nmiddle\n' + block(1) + '\n';
const dedup = text(mergeCodexBlock(dup, block(3)));
ok((dedup.match(new RegExp(S.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 1, 'duplicates collapsed to one managed block');
ok(dedup.startsWith(prefix) && dedup.includes('\nmiddle\n'), 'duplicates: user text around them kept');

// 4. uninstall removes only our span
const removed = removeCodexBlock(twice);
ok(!removed.includes(S) && !removed.includes(E), 'uninstall: managed span gone');
ok(removed.startsWith(prefix) && removed.endsWith(suffix), 'uninstall: user prefix and suffix intact');

// 5. Review O-6: a file WITHOUT a trailing newline round-trips byte-for-byte, also after re-installs.
for (const orig of ['line1   \r\nline2\r\n\r\n\r\n\r\nskills/core/x.md\r\nlastline no newline   ', 'one line', 'ends with one\n', 'ends with two\n\n', '']) {
  const i1 = text(mergeCodexBlock(orig, block(1)));
  const i2 = text(mergeCodexBlock(i1, block(2)));
  ok(i2.startsWith(orig), `re-install keeps user prefix: ${JSON.stringify(orig.slice(-12))}`);
  ok(removeCodexBlock(i1) === orig, `install->uninstall exact: ${JSON.stringify(orig.slice(-12))}`);
  ok(removeCodexBlock(i2) === orig, `install->reinstall->uninstall exact: ${JSON.stringify(orig.slice(-12))}`);
}

console.log(`agents-block self-test: ${n} checks passed`);
