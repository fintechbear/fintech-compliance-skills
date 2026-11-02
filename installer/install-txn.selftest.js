'use strict';
// Pure fault-injection test for AUD-20261102-F06(a)(b). An in-memory fake filesystem is injected;
// no real install, no CLI. Every write/rename/remove step is made to fail in turn.
// Run: node installer/install-txn.selftest.js
const assert = require('node:assert/strict');
const { commitFlatInstall, commitTreeSwap } = require('./index');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// Fake fs: a Map path -> content. Directories are implicit. `failAt` makes the k-th call of a
// given op throw (0-based), so each step can be failed deterministically.
function fakeFs(initial, failOp, failIndex) {
  const files = new Map(Object.entries(initial));
  const counts = {};
  const step = (op) => { counts[op] = (counts[op] || 0); const i = counts[op]++; if (op === failOp && i === failIndex) throw new Error(`injected ${op} #${i} failure`); };
  const moveTree = (a, b) => { // rename a file or a "directory" prefix
    const hits = [...files.keys()].filter((k) => k === a || k.startsWith(a + '/'));
    if (!hits.length) throw new Error(`ENOENT ${a}`);
    // like a real fs: renaming a directory onto an existing non-empty directory fails
    if ([...files.keys()].some((k) => k.startsWith(b + '/'))) throw new Error(`ENOTEMPTY ${b}`);
    for (const k of hits) { const v = files.get(k); files.delete(k); files.set(b + k.slice(a.length), v); }
  };
  return {
    files, counts,
    ops: {
      exists: (p) => [...files.keys()].some((k) => k === p || k.startsWith(p + '/')),
      mkdirp: () => { step('mkdirp'); },
      writeFile: (p, d) => { step('writeFile'); files.set(p, d); },
      copyFile: (a, b) => { step('copyFile'); files.set(b, files.get(a)); },
      rename: (a, b) => { step('rename'); moveTree(a, b); },
      rm: (p) => { step('rm'); for (const k of [...files.keys()]) if (k === p || k.startsWith(p + '/')) files.delete(k); },
    },
  };
}

// ---- (a) flat install: old v1 files must be fully restored on any failure ----
const OLD = { '/s/a/SKILL.md': 'A1', '/s/b/SKILL.md': 'B1', '/s/c/SKILL.md': 'C1' };
const staged = ['a', 'b', 'c'].map((x) => ({ dir: `/s/${x}`, dest: `/s/${x}/SKILL.md`, data: `${x.toUpperCase()}2`, migrate: false }));
const active = (f) => ['a', 'b', 'c'].map((x) => f.files.get(`/s/${x}/SKILL.md`)).join(',');

// success
let f = fakeFs(OLD); commitFlatInstall(staged, f.ops);
ok(active(f) === 'A2,B2,C2', 'flat: success installs all new versions');
ok(![...f.files.keys()].some((k) => /fcs-(tmp|prev)/.test(k)), 'flat: success leaves no temp/journal files');

// fail each writeFile and each rename in turn: never a mixed old/new active set
for (const [op, max] of [['writeFile', 3], ['rename', 6]]) {
  for (let i = 0; i < max; i++) {
    f = fakeFs(OLD, op, i);
    let threw = false; try { commitFlatInstall(staged, f.ops); } catch { threw = true; }
    ok(threw, `flat: ${op}#${i} failure is reported`);
    ok(active(f) === 'A1,B1,C1', `flat: ${op}#${i} failure restores the full old set (got ${active(f)})`);
  }
}

// ---- (b) codex tree swap: the backup survives unless the restore is proven ----
const TREE = { '/t/tree/skills/x.md': 'OLD', '/t/stage/skills/x.md': 'NEW', '/t/AGENTS.md.tmp': 'AG2', '/t/AGENTS.md': 'AG1' };
const args = { treeDst: '/t/tree', stage: '/t/stage', agentsTmp: '/t/AGENTS.md.tmp', dest: '/t/AGENTS.md', backupName: '/t/tree.bak' };

f = fakeFs(TREE); commitTreeSwap(args, f.ops);
ok(f.files.get('/t/tree/skills/x.md') === 'NEW' && f.files.get('/t/AGENTS.md') === 'AG2', 'swap: success commits tree + AGENTS');
ok(!f.ops.exists('/t/tree.bak'), 'swap: success removes the backup');

// AGENTS rename fails (rename #2) -> old tree restored, backup gone only because restore proven
f = fakeFs(TREE, 'rename', 2);
assert.throws(() => commitTreeSwap(args, f.ops)); n++;
ok(f.files.get('/t/tree/skills/x.md') === 'OLD', 'swap: AGENTS failure restores the old tree');
ok(!f.ops.exists('/t/tree.bak'), 'swap: backup consumed by a proven restore');

// The original bug: the swap fails, so rollback runs, AND removing the new tree throws.
f = fakeFs(TREE);
let err = null;
let renames = 0; const r0 = f.ops.rename; f.ops.rename = (a, b) => { if (++renames === 3) throw new Error('injected AGENTS rename failure'); return r0(a, b); };
const rm0 = f.ops.rm; f.ops.rm = (p) => { if (p === '/t/tree') throw new Error('injected rm(treeDst) failure'); return rm0(p); };
err = null; try { commitTreeSwap(args, f.ops); } catch (e) { err = e; }
ok(err && /injected AGENTS rename failure/.test(err.message), 'swap: first error kept');
ok(err && /rm\(treeDst\)/.test(err.message), 'swap: rollback error kept too');
ok(f.ops.exists('/t/tree.bak') && f.files.get('/t/tree.bak/skills/x.md') === 'OLD', 'swap: backup (only recovery copy) is NOT deleted when restore cannot be proven');
ok(err.recovery && err.recovery.includes('/t/tree.bak'), 'swap: error names the recovery copy');

// restore rename itself fails -> backup kept
f = fakeFs(TREE);
renames = 0; const r1 = f.ops.rename; f.ops.rename = (a, b) => { renames++; if (renames === 3 || renames === 4) throw new Error(`injected rename #${renames}`); return r1(a, b); };
err = null; try { commitTreeSwap(args, f.ops); } catch (e) { err = e; }
ok(f.files.get('/t/tree.bak/skills/x.md') === 'OLD', 'swap: failed restore keeps the backup');

console.log(`install-txn self-test: ${n} checks passed`);
