'use strict';
/*
 * Installer test suite (node:test). Runtime stays dependency-free; tests use
 * js-yaml (devDependency) for REAL YAML parsing and a --home/--target sandbox so
 * nothing touches the user's real home.
 *
 * Covers the WP2 matrix: clean installs (claude/codex/kiro/kiro-crew), idempotency,
 * user-edit preservation, --force, migration from the previous installer
 * (unedited + edited), legacy Codex section migration (incl. duplicates), unknown
 * user-file preservation, ./ ../ anchor links, real YAML + negative fixtures,
 * bad CLI args, mid-update failure recovery, and install from the packed npm artifact.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const INSTALLER = path.resolve(__dirname, 'index.js');
const REPO_ROOT = path.resolve(__dirname, '..');
const api = require('./index.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-t-')); }
function run(args, opts = {}) {
  return execFileSync(process.execPath, [INSTALLER, ...args], { stdio: 'pipe', ...opts }).toString();
}
function walkFiles(dir, rel = '', out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(path.join(dir, e.name), r, out);
    else out.push(r);
  }
  return out;
}
const sourceSkillNames = api.listSkillFiles().map((s) => s.name);

// 1. clean Claude install
test('clean Claude install: full inventory + resolvable links + valid YAML', () => {
  const t = tmp();
  run(['--tool', 'claude', '--target', t, '--home', t]);
  const base = path.join(t, '.claude', 'skills');
  const got = fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory()).sort();
  assert.deepEqual(got, [...sourceSkillNames].sort(), 'installed inventory equals source inventory');
  for (const name of got) {
    const f = path.join(base, name, 'SKILL.md');
    const txt = fs.readFileSync(f, 'utf8');
    // real YAML parse of the frontmatter
    assert.ok(txt.startsWith('---'), `${name} has frontmatter`);
    const fm = txt.slice(3, txt.indexOf('\n---', 3));
    const meta = yaml.load(fm);
    assert.equal(typeof meta.name, 'string');
    assert.equal(typeof meta.description, 'string');
    // every ./ ../ link resolves from the installed location
    for (const m of txt.matchAll(/\]\((\.\.?\/[^)]+)\)/g)) {
      const target = path.resolve(path.dirname(f), m[1].split('#')[0]);
      assert.ok(fs.existsSync(target), `${name}: link ${m[1]} resolves`);
    }
  }
  fs.rmSync(t, { recursive: true, force: true });
});

// 2. clean Codex install: referenced files exist, one managed block
test('clean Codex install: refs resolve + single managed block', () => {
  const t = tmp();
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const agents = fs.readFileSync(path.join(t, 'AGENTS.md'), 'utf8');
  const refs = [...agents.matchAll(/`(\.fintech-compliance-skills\/skills\/[^`]+\.md)`/g)].map((m) => m[1]);
  assert.ok(refs.length >= sourceSkillNames.length, 'references at least every skill');
  for (const r of refs) assert.ok(fs.existsSync(path.join(t, r)), `ref ${r} exists`);
  assert.equal((agents.match(/BEGIN fintech-compliance-skills/g) || []).length, 1);
  fs.rmSync(t, { recursive: true, force: true });
});

// 3. Kiro targets resolve to the official paths (no real-home writes)
test('Kiro CLI/IDE + Crew resolve to documented paths', () => {
  assert.equal(api.resolveBase('kiro', undefined, '/proj', '/home'), path.join('/home', '.kiro', 'skills'));
  assert.equal(api.resolveBase('kiro', 'workspace', '/proj', '/home'), path.join('/proj', '.kiro', 'skills'));
  assert.equal(api.resolveBase('kiro-crew', undefined, '/proj', '/home'), path.join('/home', '.kiro', 'crew', 'skills'));
  const t = tmp();
  run(['--tool', 'kiro', '--home', t]);
  assert.ok(fs.existsSync(path.join(t, '.kiro', 'skills', 'java', 'SKILL.md')));
  run(['--tool', 'kiro-crew', '--home', t]);
  assert.ok(fs.existsSync(path.join(t, '.kiro', 'crew', 'skills', 'java', 'SKILL.md')));
  fs.rmSync(t, { recursive: true, force: true });
});

// 4. re-install is idempotent
test('re-install produces identical content (idempotent)', () => {
  const t = tmp();
  run(['--tool', 'claude', '--target', t, '--home', t]);
  const base = path.join(t, '.claude', 'skills');
  const snap = walkFiles(base).sort().map((f) => [f, fs.readFileSync(path.join(base, f), 'utf8')]);
  const out = run(['--tool', 'claude', '--target', t, '--home', t]);
  assert.match(out, /0 new, 0 migrated/);
  const snap2 = walkFiles(base).sort().map((f) => [f, fs.readFileSync(path.join(base, f), 'utf8')]);
  assert.deepEqual(snap2, snap, 'byte-identical after re-run');
  fs.rmSync(t, { recursive: true, force: true });
});

// 5 + 6. user edit preserved; --force overwrites
test('user edit preserved without --force, overwritten with --force', () => {
  const t = tmp();
  run(['--tool', 'claude', '--target', t, '--home', t]);
  const f = path.join(t, '.claude', 'skills', 'java', 'SKILL.md');
  fs.appendFileSync(f, '\nUSER EDIT MARKER\n');
  const out = run(['--tool', 'claude', '--target', t, '--home', t]);
  assert.match(out, /skipped 1 user-edited/);
  assert.ok(fs.readFileSync(f, 'utf8').includes('USER EDIT MARKER'), 'edit kept');
  run(['--tool', 'claude', '--target', t, '--home', t, '--force']);
  assert.ok(!fs.readFileSync(f, 'utf8').includes('USER EDIT MARKER'), 'edit gone after --force');
  fs.rmSync(t, { recursive: true, force: true });
});

// helper: write the exact previous-installer output for a skill
function writeLegacySkill(base, skill) {
  const dir = path.join(base, skill.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), api.legacyOutputs(skill)[0], 'utf8');
}

// 7. migrate an unedited previous-installer install
test('migration: unedited legacy file is recognised and upgraded (with backup)', () => {
  const t = tmp();
  const base = path.join(t, '.claude', 'skills');
  const skills = api.listSkillFiles();
  for (const s of skills) writeLegacySkill(base, s);
  const out = run(['--tool', 'claude', '--target', t, '--home', t]);
  assert.match(out, /migrated/);
  // all migrated, none skipped
  assert.ok(!/skipped \d+ user-edited/.test(out), 'no legacy file treated as a user edit');
  const java = path.join(base, 'java', 'SKILL.md');
  assert.ok(fs.existsSync(java + '.bak'), 'backup written');
  assert.ok(fs.readFileSync(java, 'utf8').includes('fcs-managed-hash:'), 'now in new format');
  // links now resolve
  const txt = fs.readFileSync(java, 'utf8');
  for (const m of txt.matchAll(/\]\((\.\.?\/[^)]+)\)/g)) {
    assert.ok(fs.existsSync(path.resolve(path.dirname(java), m[1].split('#')[0])), `link ${m[1]} resolves`);
  }
  fs.rmSync(t, { recursive: true, force: true });
});

// 8. migrate when the user edited a legacy file -> must be preserved, not clobbered
test('migration: an EDITED legacy file is preserved, not overwritten', () => {
  const t = tmp();
  const base = path.join(t, '.claude', 'skills');
  const skills = api.listSkillFiles();
  const java = skills.find((s) => s.name === 'java');
  writeLegacySkill(base, java);
  const f = path.join(base, 'java', 'SKILL.md');
  fs.appendFileSync(f, '\nHAND EDIT\n'); // now it no longer matches legacy output
  const out = run(['--tool', 'claude', '--target', t, '--home', t]);
  assert.match(out, /skipped/);
  assert.ok(fs.readFileSync(f, 'utf8').includes('HAND EDIT'), 'user edit on a legacy file preserved');
  fs.rmSync(t, { recursive: true, force: true });
});

// 9. legacy Codex sections (incl. duplicates) migrated to a single managed block
test('Codex migration: legacy + duplicate legacy sections collapse to one managed block', () => {
  const t = tmp();
  const legacy = `# My project notes\n\nKeep this.\n\n` +
    `<!-- fintech-compliance-skills -->\n# AGENTS.md — Fintech Compliance Rules\n\n- \`skills/core/secure-fintech-coding.md\` — baseline\n` +
    `\n<!-- fintech-compliance-skills -->\n# AGENTS.md — Fintech Compliance Rules\n\n- \`skills/refusal/refusal-policy.md\` — limits\n`;
  fs.writeFileSync(path.join(t, 'AGENTS.md'), legacy, 'utf8');
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const after = fs.readFileSync(path.join(t, 'AGENTS.md'), 'utf8');
  assert.ok(after.includes('Keep this.'), 'user text before legacy block preserved');
  assert.equal((after.match(/BEGIN fintech-compliance-skills/g) || []).length, 1, 'one managed block');
  assert.ok(!/`skills\/core\/secure-fintech-coding\.md`/.test(after), 'old broken skills/ refs removed');
  assert.ok(!after.includes('<!-- fintech-compliance-skills -->'), 'legacy marker gone');
  fs.rmSync(t, { recursive: true, force: true });
});

// 10. independent user instructions in AGENTS.md preserved
test('Codex: user instructions outside the block are preserved on re-run', () => {
  const t = tmp();
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const p = path.join(t, 'AGENTS.md');
  fs.writeFileSync(p, 'MY TEAM RULE: always run tests.\n\n' + fs.readFileSync(p, 'utf8'));
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const after = fs.readFileSync(p, 'utf8');
  assert.ok(after.includes('MY TEAM RULE: always run tests.'));
  assert.equal((after.match(/BEGIN fintech-compliance-skills/g) || []).length, 1);
  fs.rmSync(t, { recursive: true, force: true });
});

// 11. unknown user files under the Codex dir are preserved
test('Codex: unknown user file under rule dir is preserved across re-install', () => {
  const t = tmp();
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const userFile = path.join(t, '.fintech-compliance-skills', 'my-notes.md');
  fs.writeFileSync(userFile, 'personal notes', 'utf8');
  run(['--tool', 'codex', '--target', t, '--home', t]);
  assert.ok(fs.existsSync(userFile) && fs.readFileSync(userFile, 'utf8') === 'personal notes');
  fs.rmSync(t, { recursive: true, force: true });
});

// 12. ./ ../ + anchor links handled (scala ./java.md is the regression case)
test('local links: ./sibling.md rewritten and resolves; external URLs untouched', () => {
  const rewritten = api.rewriteRelativeLinks('see [java](./java.md) and [core](../core/secure-fintech-coding.md) and [web](https://example.com/x.md)');
  assert.ok(rewritten.includes('](../java/SKILL.md)'), './sibling rewritten');
  assert.ok(rewritten.includes('](../secure-fintech-coding/SKILL.md)'), '../group/file rewritten');
  assert.ok(rewritten.includes('https://example.com/x.md'), 'external URL left alone');
  // and prove it on the actually installed scala file if present
  const t = tmp();
  run(['--tool', 'claude', '--target', t, '--home', t]);
  const scala = path.join(t, '.claude', 'skills', 'scala', 'SKILL.md');
  if (fs.existsSync(scala)) {
    const txt = fs.readFileSync(scala, 'utf8');
    for (const m of txt.matchAll(/\]\((\.\.?\/[^)]+)\)/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(scala), m[1].split('#')[0])), `scala link ${m[1]} resolves`);
    }
  }
  fs.rmSync(t, { recursive: true, force: true });
});

// 13. real YAML negative fixture: a colon-bearing description must still parse
test('YAML: a description with colon/quote/backslash/unicode parses (negative fixture)', () => {
  // emulate what the generator produces for a tricky description
  const tricky = 'Config: "quoted", path C:\\x, unicode é — and: colons';
  const fm = `name: "x"\ndescription: ${JSON.stringify(tricky)}\ntriggers: "a, b"\n`;
  const meta = yaml.load(fm);
  assert.equal(meta.description, tricky);
  // and a deliberately BROKEN frontmatter must throw (proves the test can fail)
  assert.throws(() => yaml.load('description: "unterminated\nname: x'), /./);
});

// 14. bad CLI args
test('CLI: unknown --tool and --scope exit non-zero with a message', () => {
  assert.throws(() => run(['--tool', 'nope']), (e) => /Unknown --tool/.test(e.stderr.toString()));
  assert.throws(() => run(['--tool', 'kiro', '--scope', 'bogus']), (e) => /Unknown --scope/.test(e.stderr.toString()));
});

// 15. mid-update failure preserves the previous working install
test('atomicity: a failed Codex update leaves the previous install intact', () => {
  const t = tmp();
  run(['--tool', 'codex', '--target', t, '--home', t]); // v1 installed
  const before = fs.readFileSync(path.join(t, '.fintech-compliance-skills', 'skills', 'core', 'secure-fintech-coding.md'), 'utf8');
  // Make AGENTS.md a directory so writing it throws AFTER the tree would swap — simulate failure.
  // Instead, make the staging swap fail by locking: emulate by pre-creating an unwritable AGENTS.md path as a dir.
  const agents = path.join(t, 'AGENTS.md');
  fs.rmSync(agents, { force: true });
  fs.mkdirSync(agents); // now writeFileSync(AGENTS.md) will throw EISDIR
  assert.throws(() => run(['--tool', 'codex', '--target', t, '--home', t]));
  // tree must still be the previous good one
  assert.ok(fs.existsSync(path.join(t, '.fintech-compliance-skills', 'skills', 'core', 'secure-fintech-coding.md')));
  assert.equal(fs.readFileSync(path.join(t, '.fintech-compliance-skills', 'skills', 'core', 'secure-fintech-coding.md'), 'utf8'), before);
  fs.rmSync(t, { recursive: true, force: true });
});

// 16. install from the packed npm artifact
test('packed artifact: npm pack tarball installs correctly', () => {
  const t = tmp();
  const isWin = process.platform === 'win32';
  const packOut = execFileSync(isWin ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', t], { cwd: REPO_ROOT, stdio: 'pipe', shell: isWin }).toString().trim();
  const tgz = path.join(t, packOut.split('\n').pop().trim());
  assert.ok(fs.existsSync(tgz), 'tarball created');
  execFileSync('tar', ['-xzf', tgz, '-C', t], { stdio: 'pipe' });
  const pkgInstaller = path.join(t, 'package', 'installer', 'index.js');
  assert.ok(fs.existsSync(pkgInstaller), 'installer is in the package');
  const dest = path.join(t, 'proj');
  fs.mkdirSync(dest);
  execFileSync(process.execPath, [pkgInstaller, '--tool', 'claude', '--target', dest, '--home', dest], { stdio: 'pipe' });
  const base = path.join(dest, '.claude', 'skills');
  const got = fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory());
  assert.equal(got.length, sourceSkillNames.length, 'all skills installed from the tarball');
  fs.rmSync(t, { recursive: true, force: true });
});
