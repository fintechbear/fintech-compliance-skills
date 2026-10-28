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

  // =========================================================================
  // R07: doctor must NOT report OK on a broken/half install, and must discover
  // the default project-scoped Claude install, not only user scope.
  // =========================================================================
  const crypto2 = require('crypto');
  const sha16 = (s) => crypto2.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

  // R07a: managed block present but the whole Codex skill tree DELETED -> broken, exit != 0.
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-r07a-'));
    execFileSync(process.execPath, [INSTALLER, '--tool', 'codex', '--target', t], { stdio: 'pipe' });
    // sanity: a clean codex install reports healthy + exit 0
    let rc = node([DIAG, '--home', t, '--target', t, '--json']);
    const cj = JSON.parse(rc.out).installs.find((x) => x.tool === 'codex');
    ok(rc.code === 0 && cj.healthy, 'R07a pre: clean codex install is healthy, exit 0');
    // now delete the entire skill tree, leave AGENTS.md (with the managed block) intact
    fs.rmSync(path.join(t, '.fintech-compliance-skills'), { recursive: true, force: true });
    ok(fs.existsSync(path.join(t, 'AGENTS.md')), 'R07a: AGENTS.md (managed block) still present');
    const r2 = node([DIAG, '--home', t, '--target', t, '--json']);
    const j = JSON.parse(r2.out);
    const cx = j.installs.find((x) => x.tool === 'codex');
    ok(r2.code !== 0, 'R07a: deleted Codex tree with block still present -> exit NON-zero (was false OK)');
    ok(cx && cx.present && cx.healthy === false, 'R07a: codex reported present-but-NOT-healthy');
    ok(cx && cx.issues && cx.issues.some((s) => /tree is MISSING/.test(s)), 'R07a: names the missing tree');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // R07b: a single managed tree file deleted (manifest still lists it) -> broken, exit != 0.
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-r07b-'));
    execFileSync(process.execPath, [INSTALLER, '--tool', 'codex', '--target', t], { stdio: 'pipe' });
    const victim = path.join(t, '.fintech-compliance-skills', 'skills', 'core', 'secure-fintech-coding.md');
    ok(fs.existsSync(victim), 'R07b pre: managed file exists');
    fs.rmSync(victim, { force: true });
    const r2 = node([DIAG, '--home', t, '--target', t, '--json']);
    const cx = JSON.parse(r2.out).installs.find((x) => x.tool === 'codex');
    ok(r2.code !== 0, 'R07b: deleted managed file -> exit NON-zero');
    ok(cx && cx.issues.some((s) => /deleted: /.test(s)), 'R07b: names the deleted managed file');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // R07c: corrupt manifest -> cannot verify integrity -> broken, exit != 0.
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-r07c-'));
    execFileSync(process.execPath, [INSTALLER, '--tool', 'codex', '--target', t], { stdio: 'pipe' });
    fs.writeFileSync(path.join(t, '.fintech-compliance-skills', '.fcs-manifest.json'), '{ this is not json', 'utf8');
    const r2 = node([DIAG, '--home', t, '--target', t, '--json']);
    const cx = JSON.parse(r2.out).installs.find((x) => x.tool === 'codex');
    ok(r2.code !== 0, 'R07c: corrupt manifest -> exit NON-zero');
    ok(cx && cx.issues.some((s) => /manifest/i.test(s)), 'R07c: names the manifest problem');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // R07d: default project-scoped Claude install is discovered (not only user scope).
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-r07d-'));
    // install with the DEFAULT scope (project) -> lands under <target>/.claude/skills
    execFileSync(process.execPath, [INSTALLER, '--tool', 'claude', '--target', t, '--home', t], { stdio: 'pipe' });
    const r2 = node([DIAG, '--home', t, '--target', t, '--json']);
    const j = JSON.parse(r2.out);
    const proj = j.installs.find((x) => x.tool === 'claude' && x.scope === 'project');
    ok(proj && proj.present, 'R07d: project-scoped claude install is discovered');
    ok(proj && proj.tally.current === j.source.skills, 'R07d: project claude reports all skills current');
    ok(r2.code === 0, 'R07d: a clean project install is OK (exit 0)');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // R07e: a user-edited Codex file is PRESERVED/reported, never auto-repaired or failed.
  {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-r07e-'));
    execFileSync(process.execPath, [INSTALLER, '--tool', 'codex', '--target', t], { stdio: 'pipe' });
    const edit = path.join(t, '.fintech-compliance-skills', 'skills', 'refusal', 'refusal-policy.md');
    const before = fs.readFileSync(edit, 'utf8');
    fs.writeFileSync(edit, before + '\n<!-- my own note -->\n', 'utf8');
    // re-run installer so it records the edit as userEdited in the manifest (preserve contract)
    execFileSync(process.execPath, [INSTALLER, '--tool', 'codex', '--target', t], { stdio: 'pipe' });
    const after = fs.readFileSync(edit, 'utf8');
    ok(after.includes('my own note'), 'R07e: installer preserved the user edit');
    const r2 = node([DIAG, '--home', t, '--target', t, '--json']);
    const cx = JSON.parse(r2.out).installs.find((x) => x.tool === 'codex');
    ok(cx && cx.userEdited && cx.userEdited.length >= 1, 'R07e: doctor reports the edit as user-edited (preserved)');
    ok(r2.code === 0, 'R07e: a user edit alone is not a failure (exit 0)');
    // doctor must not have touched the file
    ok(fs.readFileSync(edit, 'utf8').includes('my own note'), 'R07e: doctor did NOT repair/remove the user edit');
    fs.rmSync(t, { recursive: true, force: true });
  }

  fs.rmSync(empty, { recursive: true, force: true });

  // =========================================================================
  // R03: the PACKAGED doctor (from a real tarball) must ship its resources and
  // not crash with a TypeError; a missing resource is a structured error + exit!=0.
  // This tests the TARBALL, not the source checkout (a source-only test is not enough).
  // =========================================================================
  {
    const isWin = process.platform === 'win32';
    const repoRoot = path.resolve(__dirname, '..');
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-r03-'));
    const packOut = execFileSync(isWin ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', t],
      { cwd: repoRoot, stdio: 'pipe', shell: isWin }).toString().trim();
    const tgz = path.join(t, packOut.split('\n').pop().trim());
    execFileSync('tar', ['-xzf', tgz, '-C', t], { stdio: 'pipe' });
    const pkg = path.join(t, 'package');
    const pkgDoctor = path.join(pkg, 'installer', 'diagnose.js');

    ok(fs.existsSync(path.join(pkg, 'controls', 'catalog.json')), 'R03: packaged tarball ships controls/catalog.json');
    ok(fs.existsSync(path.join(pkg, 'controls', 'schema', 'control.schema.json')), 'R03: tarball ships controls/schema/');
    ok(fs.existsSync(path.join(pkg, 'controls', 'profiles')), 'R03: tarball ships controls/profiles/');

    // packaged doctor runs (source-side check) without a TypeError, exit 0 on a clean empty target
    const empty = path.join(t, 'empty'); fs.mkdirSync(empty);
    let r = node([pkgDoctor, '--home', empty, '--target', empty, '--json']);
    ok(r.code === 0, 'R03: packaged doctor runs from the tarball (no TypeError), exit 0');
    let j; try { j = JSON.parse(r.out); } catch { j = null; }
    ok(j && j.source && j.source.controls > 0, 'R03: packaged doctor resolved its catalog (controls > 0)');

    // install from the tarball then doctor the install
    execFileSync(process.execPath, [path.join(pkg, 'installer', 'index.js'), '--tool', 'claude', '--target', path.join(t, 'proj'), '--home', path.join(t, 'proj')], { stdio: 'pipe' });
    r = node([pkgDoctor, '--home', path.join(t, 'proj'), '--target', path.join(t, 'proj'), '--json']);
    ok(r.code === 0, 'R03: tarball install + packaged doctor = exit 0');

    // a MISSING catalog is a STRUCTURED error (named + exit 2), not a raw stack trace
    fs.rmSync(path.join(pkg, 'controls', 'catalog.json'));
    r = node([pkgDoctor, '--home', path.join(t, 'proj'), '--target', path.join(t, 'proj'), '--json']);
    ok(r.code === 2, 'R03: missing catalog -> structured exit 2 (not a TypeError crash)');
    ok(/resource_error|required resource missing/.test(r.out), 'R03: missing catalog names a structured resource error');
    ok(!/TypeError|Cannot read properties/.test(r.out), 'R03: no raw TypeError/stack trace surfaced');
    fs.rmSync(t, { recursive: true, force: true });
  }

} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} diagnose smoke check(s) failed.`); process.exit(1); }
console.log('\nAll diagnose smoke checks passed.');
