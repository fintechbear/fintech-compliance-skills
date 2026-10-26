#!/usr/bin/env node
/*
 * Structural verification for the installer. Exits non-zero on any failure.
 * Run locally or in CI:  node installer/verify.js
 *
 * Checks (the P0 guarantees from the roadmap):
 *   1. Codex install copies the whole tree; every path AGENTS.md references exists.
 *   2. Re-running Codex leaves exactly one managed block (idempotent).
 *   3. Claude/Kiro install rewrites cross-links so each target resolves.
 *   4. Every generated SKILL.md frontmatter is valid (key: value, quoted scalars).
 *   5. Overwrite protection: an edited SKILL.md is skipped without --force.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const INSTALLER = path.join(__dirname, 'index.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-verify-'));
let failures = 0;
const ok = (c, m) => { if (!c) { failures++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };
const run = (args) => execFileSync(process.execPath, [INSTALLER, ...args], { stdio: 'pipe' });

try {
  // ---- Codex ----
  const cx = path.join(tmp, 'codex');
  fs.mkdirSync(cx, { recursive: true });
  run(['--tool', 'codex', '--target', cx]);
  const agents = fs.readFileSync(path.join(cx, 'AGENTS.md'), 'utf8');
  const refs = [...agents.matchAll(/`(\.fintech-compliance-skills\/skills\/[^`]+\.md)`/g)].map((m) => m[1]);
  ok(refs.length > 0, `Codex AGENTS.md references ${refs.length} rule files`);
  const missing = refs.filter((r) => !fs.existsSync(path.join(cx, r)));
  ok(missing.length === 0, `all ${refs.length} referenced files exist (missing: ${missing.length})`);
  run(['--tool', 'codex', '--target', cx]); // second run
  const blocks = (fs.readFileSync(path.join(cx, 'AGENTS.md'), 'utf8').match(/BEGIN fintech-compliance-skills/g) || []).length;
  ok(blocks === 1, `re-run leaves one managed block (found ${blocks})`);

  // ---- Claude ----
  const cl = path.join(tmp, 'claude');
  fs.mkdirSync(cl, { recursive: true });
  run(['--tool', 'claude', '--target', cl]);
  const base = path.join(cl, '.claude', 'skills');
  const dirs = fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory());
  ok(dirs.length >= 20, `installed ${dirs.length} skills`);

  // cross-links resolve + frontmatter valid
  let badLinks = 0, badYaml = 0;
  for (const d of dirs) {
    const f = path.join(base, d, 'SKILL.md');
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/\]\((\.\.\/[^)]+)\)/g)) {
      const target = path.resolve(path.dirname(f), m[1]);
      if (!fs.existsSync(target)) { badLinks++; console.error('    broken link', d, '->', m[1]); }
    }
    // minimal frontmatter validation: starts with ---, three quoted keys, closing ---
    const fm = t.startsWith('---') ? t.split('\n---', 1)[0] : '';
    const keysOk = /name:\s*".*"/.test(fm) && /description:\s*".*"/.test(fm) && /triggers:\s*".*"/.test(fm);
    if (!keysOk) { badYaml++; console.error('    bad frontmatter', d); }
  }
  ok(badLinks === 0, `all cross-links resolve (broken: ${badLinks})`);
  ok(badYaml === 0, `all frontmatters well-formed (bad: ${badYaml})`);

  // ---- overwrite protection ----
  const javaFile = path.join(base, 'java', 'SKILL.md');
  fs.appendFileSync(javaFile, '\nUSER EDIT\n');
  const out = run(['--tool', 'claude', '--target', cl]).toString();
  ok(/skipped 1 /.test(out) && /java/.test(out), 'edited SKILL.md is skipped without --force');
  ok(fs.readFileSync(javaFile, 'utf8').includes('USER EDIT'), 'user edit preserved');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll installer checks passed.');
