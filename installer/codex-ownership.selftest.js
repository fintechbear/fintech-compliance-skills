'use strict';
// Pure fixture tests for AUD-20261102-F05 (Codex ownership). Hashes are synthetic strings;
// no filesystem, no install, no CLI.  Run: node installer/codex-ownership.selftest.js
const assert = require('node:assert/strict');
const { planCodex, readManifest } = require('./codex-ownership');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const at = (plan, k) => plan.entries.find((e) => e.relKey === k);

const pkg = { 'skills/a.md': 'P_A', 'skills/b.md': 'P_B', 'skills/c.md': 'P_C', 'skills/d.md': 'P_D', 'skills/INDEX.md': 'P_I' };
const disk = {
  'skills/a.md': 'P_A',     // current (unchanged since install)
  'skills/b.md': 'OLD_B',   // stale: our previous baseline
  'skills/c.md': 'EDIT_C',  // user edited
  // d.md absent
  'skills/INDEX.md': 'P_I', // INDEX is a package file too
  'skills/mine.md': 'U_1',  // unknown: not a package path
};
const manifest = JSON.stringify({ version: 2, managed: { 'skills/a.md': 'P_A', 'skills/b.md': 'OLD_B', 'skills/c.md': 'P_C', 'skills/INDEX.md': 'P_I' }, userEdited: {} });

let p = planCodex({ disk, pkg, manifestRaw: manifest, mode: 'install' });
ok(at(p, 'skills/a.md').state === 'current' && at(p, 'skills/a.md').action === 'unchanged', 'current -> unchanged');
ok(at(p, 'skills/b.md').state === 'stale' && at(p, 'skills/b.md').action === 'update', 'stale -> update');
ok(at(p, 'skills/c.md').state === 'user_edited' && at(p, 'skills/c.md').action === 'preserve', 'user edit -> preserve');
ok(at(p, 'skills/d.md').state === 'absent' && at(p, 'skills/d.md').action === 'create', 'absent -> create');
ok(at(p, 'skills/mine.md').state === 'unknown' && at(p, 'skills/mine.md').action === 'preserve', 'unknown -> preserve');
ok(at(p, 'skills/INDEX.md').state === 'current', 'INDEX tracked like any managed file');

// --force overwrites user edits but NEVER unknown files
p = planCodex({ disk, pkg, manifestRaw: manifest, mode: 'install-force' });
ok(at(p, 'skills/c.md').action === 'overwrite' && at(p, 'skills/mine.md').action === 'preserve', 'force: edits overwritten, unknown kept');

// uninstall: only proven-owned unchanged files are removed
p = planCodex({ disk, pkg, manifestRaw: manifest, mode: 'uninstall' });
ok(at(p, 'skills/a.md').action === 'remove', 'uninstall removes unchanged managed file');
ok(at(p, 'skills/b.md').action === 'remove', 'uninstall removes our stale baseline');
ok(at(p, 'skills/INDEX.md').action === 'remove', 'uninstall removes managed INDEX');
ok(at(p, 'skills/c.md').action === 'preserve', 'uninstall keeps the user edit');
ok(at(p, 'skills/mine.md').action === 'preserve', 'uninstall keeps unknown content');

// a file equal to the package but NOT recorded in the manifest is not proven ours
p = planCodex({ disk: { 'skills/a.md': 'P_A' }, pkg, manifestRaw: JSON.stringify({ version: 2, managed: {}, userEdited: {} }), mode: 'uninstall' });
ok(at(p, 'skills/a.md').action === 'preserve', 'unrecorded file is not removed');

// legacy manifest-less install: a byte-exact known old file is ours; anything else is the user's
p = planCodex({ disk: { 'skills/a.md': 'OLDGEN', 'skills/b.md': 'X' }, pkg, manifestRaw: null, mode: 'install', isLegacyFor: (k) => k === 'skills/a.md' });
ok(at(p, 'skills/a.md').state === 'legacy' && at(p, 'skills/a.md').action === 'update', 'legacy -> update');
ok(at(p, 'skills/b.md').state === 'user_edited', 'non-legacy without manifest -> user');

// corrupt manifest: nothing differing from the package is treated as ours
for (const bad of ['{not json', '[]', JSON.stringify({ version: 3, managed: {} })]) {
  ok(readManifest(bad).status === 'corrupt', `corrupt manifest detected: ${bad}`);
  p = planCodex({ disk, pkg, manifestRaw: bad, mode: 'uninstall', isLegacyFor: () => true });
  ok(at(p, 'skills/b.md').state === 'unverifiable' && at(p, 'skills/b.md').action === 'preserve', 'corrupt: stale-looking file kept');
  ok(at(p, 'skills/a.md').action === 'preserve', 'corrupt: even package-identical file not removed on corrupt authority');
}

// legacy flat-map manifest with prefix-less keys is read through normKey
const norm = (k) => (k.startsWith('skills/') ? k : `skills/${k}`);
p = planCodex({ disk: { 'skills/b.md': 'OLD_B' }, pkg, manifestRaw: JSON.stringify({ 'b.md': 'OLD_B' }), normKey: norm, mode: 'install' });
ok(at(p, 'skills/b.md').state === 'stale', 'legacy flat manifest keys normalised');

// diff plan and uninstall plan agree on classification for the same state
const a = planCodex({ disk, pkg, manifestRaw: manifest, mode: 'install' });
const b = planCodex({ disk, pkg, manifestRaw: manifest, mode: 'uninstall' });
ok(a.entries.every((e, i) => e.state === b.entries[i].state), 'install/diff and uninstall share one classification');

console.log(`codex-ownership self-test: ${n} checks passed`);
