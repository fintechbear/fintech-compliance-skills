#!/usr/bin/env node
/*
 * Smoke test for installer/diagnose.js — cross-platform, zero deps, deterministic.
 * Proves: (1) a clean install reports every managed skill CURRENT and exits 0;
 *         (2) a drifted (ours-stale) file is detected and exits non-zero;
 *         (3) the source-side checks (FCS ids resolve, no legacy citations) pass.
 * Run:  node installer/test-diagnose.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIAG = path.join(__dirname, 'diagnose.js');
const INSTALLER = path.join(__dirname, 'index.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-diag-'));
let failures = 0;
const ok = (c, m) => { if (!c) { failures++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };
const node = (args, expectZero) => {
  try { const out = execFileSync(process.execPath, args, { stdio: 'pipe' }).toString(); return { code: 0, out }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '').toString() + (e.stderr || '').toString() }; }
};

try {
  // 1. clean install (claude user + codex), then diagnose --json
  execFileSync(process.execPath, [INSTALLER, '--tool', 'claude', '--scope', 'user', '--home', tmp, '--target', tmp], { stdio: 'pipe' });
  execFileSync(process.execPath, [INSTALLER, '--tool', 'codex', '--target', tmp], { stdio: 'pipe' });
  let r = node([DIAG, '--home', tmp, '--target', tmp, '--json']);
  ok(r.code === 0, 'clean install: diagnose exits 0');
  const j = JSON.parse(r.out);
  ok(j.source.unresolved.length === 0, `source: all FCS ids resolve (unresolved ${j.source.unresolved.length})`);
  ok(j.source.legacyCitations.length === 0, `source: no legacy citations (${j.source.legacyCitations.length})`);
  const claude = j.installs.find((t) => t.tool === 'claude');
  ok(claude && claude.present && claude.tally.current === j.source.skills && claude.tally['ours-stale'] === 0,
    `clean install: all ${j.source.skills} claude skills current, 0 stale`);
  const codex = j.installs.find((t) => t.tool === 'codex');
  ok(codex && codex.present, 'clean install: codex managed block present');

  // 2. drift one installed file into an ours-stale state (valid stamp, body != source)
  const go = path.join(tmp, '.claude', 'skills', 'go', 'SKILL.md');
  const cur = fs.readFileSync(go, 'utf8');
  const body = cur.replace(/\n\n<!-- fcs-managed-hash:[0-9a-f]+ -->\n?$/, '') + '\n<!-- drift -->\n';
  const h = crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
  fs.writeFileSync(go, body + `\n\n<!-- fcs-managed-hash:${h} -->\n`);
  r = node([DIAG, '--home', tmp, '--target', tmp, '--json']);
  ok(r.code !== 0, 'drifted install: diagnose exits non-zero');
  const j2 = JSON.parse(r.out);
  const claude2 = j2.installs.find((t) => t.tool === 'claude');
  ok(claude2 && claude2.tally['ours-stale'] === 1, 'drifted install: exactly one ours-stale detected');

  // 3. a not-installed target is reported, not an error, when source+installs are otherwise clean
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-empty-'));
  r = node([DIAG, '--home', empty, '--target', empty, '--json']);
  const j3 = JSON.parse(r.out);
  ok(j3.installs.every((t) => !t.present), 'empty home: every target reported not-installed');
  ok(r.code === 0, 'empty home with clean source: exit 0 (missing install is not an error)');
  fs.rmSync(empty, { recursive: true, force: true });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} diagnose smoke check(s) failed.`); process.exit(1); }
console.log('\nAll diagnose smoke checks passed.');
