'use strict';
/*
 * Installer test suite (node:test). Runtime stays dependency-free; tests use
 * js-yaml (devDependency) for REAL YAML parsing and a --home/--target sandbox so
 * nothing touches the user's real home.
 *
 * Historical fixtures (installer/fixtures/) were captured by running the REAL old
 * installers from git history (b742e893 = PR#5, 19b4f33 = PR#6) — see FIXTURES.json.
 * Tests load them from disk; they are NEVER regenerated from the current code.
 *
 * Covers F01-F07 as named regressions plus the broader matrix.
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
const FIX = path.join(__dirname, 'fixtures');
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

// Load a historical claude fixture SKILL.md (exact bytes the old installer wrote).
function legacyFixture(version, skillName) {
  const f = path.join(FIX, version, 'claude', `${skillName}.SKILL.md`);
  return fs.readFileSync(f, 'utf8');
}
function haveFixtures() {
  try { return fs.existsSync(path.join(FIX, 'pr5', 'claude', 'java.SKILL.md')); } catch { return false; }
}
// Skill names that EXIST in a historical fixture set. New skills added after that
// fixture was captured are intentionally absent — a legacy install never contained
// them, so an upgrade test must not expect them from the old bytes. This replaces
// hard-coded "26" counts with a meaningful, fixture-derived inventory.
function legacyFixtureNames(version) {
  const dir = path.join(FIX, version, 'claude');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.SKILL.md'))
    .map((f) => f.replace(/\.SKILL\.md$/, ''))
    .sort();
}

// ---------------------------------------------------------------------------
// clean installs
// ---------------------------------------------------------------------------

test('1. clean Claude install: full inventory + resolvable links (anchors too) + valid YAML', () => {
  const t = tmp();
  run(['--tool', 'claude', '--target', t, '--home', t]);
  const base = path.join(t, '.claude', 'skills');
  const got = fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory()).sort();
  assert.deepEqual(got, [...sourceSkillNames].sort(), 'installed inventory equals source inventory');
  for (const name of got) {
    const f = path.join(base, name, 'SKILL.md');
    const txt = fs.readFileSync(f, 'utf8');
    assert.ok(txt.startsWith('---'), `${name} has frontmatter`);
    const fm = txt.slice(3, txt.indexOf('\n---', 3));
    const meta = yaml.load(fm);
    assert.equal(typeof meta.name, 'string');
    assert.equal(typeof meta.description, 'string');
    for (const m of txt.matchAll(/\]\((\.\.?\/[^)]+)\)/g)) {
      const [file, anchor] = m[1].split('#');
      assert.ok(fs.existsSync(path.resolve(path.dirname(f), file)), `${name}: link ${m[1]} file resolves`);
      if (anchor) assert.ok(/^[a-z0-9-]+$/i.test(anchor), `${name}: anchor ${anchor} preserved`);
    }
  }
  fs.rmSync(t, { recursive: true, force: true });
});

test('2. clean Codex install: refs resolve + single managed block', () => {
  const t = tmp();
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const agents = fs.readFileSync(path.join(t, 'AGENTS.md'), 'utf8');
  const refs = [...agents.matchAll(/`(\.fintech-compliance-skills\/skills\/[^`]+\.md)`/g)].map((m) => m[1]);
  assert.ok(refs.length >= sourceSkillNames.length, 'references at least every skill');
  for (const r of refs) assert.ok(fs.existsSync(path.join(t, r)), `ref ${r} exists`);
  assert.equal((agents.match(/BEGIN fintech-compliance-skills/g) || []).length, 1);
  fs.rmSync(t, { recursive: true, force: true });
});

test('3. Kiro CLI/IDE + Crew resolve to the official paths (no real-home writes)', () => {
  assert.equal(api.resolveBase('kiro', undefined, '/proj', '/home'), path.join('/home', '.kiro', 'skills'));
  assert.equal(api.resolveBase('kiro', 'workspace', '/proj', '/home'), path.join('/proj', '.kiro', 'skills'));
  assert.equal(api.resolveBase('kiro-crew', undefined, '/proj', '/home'), path.join('/home', '.kiro', 'crew', 'skills'));
  const t = tmp();
  run(['--tool', 'kiro', '--home', t]);
  assert.ok(fs.existsSync(path.join(t, '.kiro', 'skills', 'java', 'SKILL.md')));
  run(['--tool', 'kiro', '--scope', 'workspace', '--target', t, '--home', t]);
  assert.ok(fs.existsSync(path.join(t, '.kiro', 'skills', 'java', 'SKILL.md')));
  run(['--tool', 'kiro-crew', '--home', t]);
  assert.ok(fs.existsSync(path.join(t, '.kiro', 'crew', 'skills', 'java', 'SKILL.md')));
  fs.rmSync(t, { recursive: true, force: true });
});

test('4. re-install is byte-idempotent', () => {
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

test('5+6. user edit preserved without --force; overwritten with --force', () => {
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

// ---------------------------------------------------------------------------
// F04: real historical Claude migration (fixtures from old code)
// ---------------------------------------------------------------------------

test('F04. unedited PR#5 install: ALL legacy files upgrade, incl. the content-changed ones, none skipped', { skip: haveFixtures() ? false : 'no fixtures' }, () => {
  const t = tmp();
  const base = path.join(t, '.claude', 'skills');
  const legacyNames = legacyFixtureNames('pr5');
  // lay down the EXACT bytes the old PR#5 installer wrote (only the files it actually had)
  for (const name of legacyNames) {
    const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), legacyFixture('pr5', name), 'utf8');
  }
  const out = run(['--tool', 'claude', '--target', t, '--home', t]);
  assert.doesNotMatch(out, /skipped \d+ user-edited/, 'no unedited legacy file treated as a user edit');
  assert.match(out, new RegExp(`${legacyNames.length} migrated`), `all ${legacyNames.length} legacy files migrated`);
  // the files whose repo CONTENT changed since the old install must still upgrade
  for (const name of ['postgresql', 'pci-dss', 'csharp-dotnet', 'refusal-policy', 'eu-gdpr-psd2-dora', 'turkey-kvkk-bddk-masak']) {
    const f = path.join(base, name, 'SKILL.md');
    assert.ok(fs.readFileSync(f, 'utf8').includes('fcs-managed-hash:'), `${name} upgraded to new format`);
    assert.ok(fs.existsSync(f + '.bak'), `${name} has a recoverable backup`);
    // backup holds the ORIGINAL old bytes
    assert.equal(fs.readFileSync(f + '.bak', 'utf8'), legacyFixture('pr5', name), `${name}.bak == original old file`);
  }
  fs.rmSync(t, { recursive: true, force: true });
});

test('F04b. a genuinely user-EDITED PR#5 file is preserved (byte-exact), not migrated', { skip: haveFixtures() ? false : 'no fixtures' }, () => {
  const t = tmp();
  const base = path.join(t, '.claude', 'skills');
  const dir = path.join(base, 'java'); fs.mkdirSync(dir, { recursive: true });
  const edited = legacyFixture('pr5', 'java') + '\n<!-- MY TEAM NOTE -->\n';
  fs.writeFileSync(path.join(dir, 'SKILL.md'), edited, 'utf8');
  // the other legacy files are pristine
  for (const name of legacyFixtureNames('pr5')) {
    if (name === 'java') continue;
    const d = path.join(base, name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), legacyFixture('pr5', name), 'utf8');
  }
  const out = run(['--tool', 'claude', '--target', t, '--home', t]);
  assert.match(out, /skipped 1 user-edited file\(s\).*java/);
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), edited, 'edited file untouched byte-for-byte');
  fs.rmSync(t, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// F05: legacy Codex sections — marker-less, with-marker, duplicated, mixed
// ---------------------------------------------------------------------------

function realOldCodexAgents() {
  // captured old AGENTS.md if present; else synthesise the old shape (heading + skills/ refs)
  const f = path.join(FIX, 'pr5', 'codex', 'AGENTS.md');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  return '# AGENTS.md — Fintech Compliance Rules\n\nYou write code for regulated financial systems.\n\n' +
    '- `skills/core/secure-fintech-coding.md` — baseline\n- `skills/refusal/refusal-policy.md` — limits\n';
}

test('F05a. marker-LESS legacy Codex section on an empty target migrates; old skills/ refs gone', () => {
  const t = tmp();
  // old installer on an empty target wrote the heading with NO marker
  fs.writeFileSync(path.join(t, 'AGENTS.md'), realOldCodexAgents(), 'utf8');
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const after = fs.readFileSync(path.join(t, 'AGENTS.md'), 'utf8');
  assert.equal((after.match(/BEGIN fintech-compliance-skills/g) || []).length, 1, 'one managed block');
  assert.ok(!/`skills\/core\/secure-fintech-coding\.md`/.test(after), 'old broken skills/ refs removed');
  assert.ok(!after.includes('# AGENTS.md — Fintech Compliance Rules'), 'legacy heading gone');
  fs.rmSync(t, { recursive: true, force: true });
});

test('F05b. legacy section WITH preceding user text: user text byte-preserved, refs gone', () => {
  const t = tmp();
  const userTop = '# My project\n\nWe deploy on Fridays. Keep this.\n\n';
  fs.writeFileSync(path.join(t, 'AGENTS.md'), userTop + '<!-- fintech-compliance-skills -->\n' + realOldCodexAgents(), 'utf8');
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const after = fs.readFileSync(path.join(t, 'AGENTS.md'), 'utf8');
  assert.ok(after.startsWith(userTop.trimEnd()), 'user text before the block preserved');
  assert.equal((after.match(/BEGIN fintech-compliance-skills/g) || []).length, 1);
  assert.ok(!/`skills\/core\//.test(after), 'old refs removed');
  fs.rmSync(t, { recursive: true, force: true });
});

test('F05c. DUPLICATE legacy sections collapse to one managed block', () => {
  const t = tmp();
  // Use the REAL old Codex block (it ends with the known closing blockquote note), duplicated.
  const realBlock = fs.readFileSync(path.join(FIX, 'pr5', 'codex', 'AGENTS.md'), 'utf8').replace(/\s*$/, '');
  const legacy = '# Notes\n\nKeep.\n\n' +
    '<!-- fintech-compliance-skills -->\n' + realBlock + '\n\n' +
    '<!-- fintech-compliance-skills -->\n' + realBlock + '\n';
  fs.writeFileSync(path.join(t, 'AGENTS.md'), legacy, 'utf8');
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const after = fs.readFileSync(path.join(t, 'AGENTS.md'), 'utf8');
  assert.ok(after.includes('Keep.'), 'user text preserved');
  assert.equal((after.match(/BEGIN fintech-compliance-skills/g) || []).length, 1, 'one managed block');
  assert.ok(!after.includes('<!-- fintech-compliance-skills -->'), 'legacy markers gone');
  assert.ok(!/live in this repo under `skills\/`/.test(after), 'old generated section gone');
  fs.rmSync(t, { recursive: true, force: true });
});

// F01: user text AFTER the legacy section must survive
test('F01. user instructions AFTER a legacy Codex section are byte-preserved', () => {
  const t = tmp();
  const realBlock = fs.readFileSync(path.join(FIX, 'pr5', 'codex', 'AGENTS.md'), 'utf8').replace(/\s*$/, '');
  const before = '# Team rules\n\nAlways lint.\n\n';
  const after = '\n\n## My deployment checklist\n\n1. Run tests.\n2. Tag release.\n\nNEVER delete this section.\n';
  fs.writeFileSync(path.join(t, 'AGENTS.md'), before + realBlock + after, 'utf8');
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const result = fs.readFileSync(path.join(t, 'AGENTS.md'), 'utf8');
  assert.ok(result.includes('Always lint.'), 'user text before preserved');
  assert.ok(result.includes('## My deployment checklist'), 'user heading after preserved');
  assert.ok(result.includes('NEVER delete this section.'), 'user text after the legacy block preserved (F01)');
  assert.ok(result.includes('1. Run tests.') && result.includes('2. Tag release.'), 'user list after preserved');
  assert.ok(!/live in this repo under `skills\/`/.test(result), 'old generated section removed');
  assert.equal((result.match(/BEGIN fintech-compliance-skills/g) || []).length, 1);
  fs.rmSync(t, { recursive: true, force: true });
});

test('F01b. AGENTS.md is backed up before migration (recoverable)', () => {
  const t = tmp();
  const orig = '# Mine\n\nkeep\n\n<!-- fintech-compliance-skills -->\n# AGENTS.md — Fintech Compliance Rules\n\n- `skills/core/secure-fintech-coding.md` — baseline\n';
  fs.writeFileSync(path.join(t, 'AGENTS.md'), orig, 'utf8');
  run(['--tool', 'codex', '--target', t, '--home', t]);
  assert.ok(fs.existsSync(path.join(t, 'AGENTS.md.bak')), 'backup exists');
  assert.equal(fs.readFileSync(path.join(t, 'AGENTS.md.bak'), 'utf8'), orig, 'backup is the original bytes');
  fs.rmSync(t, { recursive: true, force: true });
});

test('10. user instructions outside the managed block preserved on plain re-run', () => {
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

// ---------------------------------------------------------------------------
// F02: A->B update; manifest key contract; unknown user files
// ---------------------------------------------------------------------------

test('F02. A->B update: unchanged managed files become B; edited one preserved+reported; unknown kept; old manifest-key format tolerated', () => {
  const t = tmp();
  // --- install version A ---
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const treeRoot = path.join(t, '.fintech-compliance-skills');
  const coreFile = path.join(treeRoot, 'skills', 'core', 'secure-fintech-coding.md');
  const refusalFile = path.join(treeRoot, 'skills', 'refusal', 'refusal-policy.md');
  const aContentCore = fs.readFileSync(coreFile, 'utf8');

  // simulate the OLD buggy manifest-key format (no leading skills/) to prove F02 tolerance
  const manPath = path.join(treeRoot, '.fcs-manifest.json');
  const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  const legacyKeyMan = {};
  for (const [k, v] of Object.entries(man)) legacyKeyMan[k.replace(/^skills\//, '')] = v;
  fs.writeFileSync(manPath, JSON.stringify(legacyKeyMan, null, 2), 'utf8');

  // a genuine user edit to one managed rule file
  fs.appendFileSync(refusalFile, '\n<!-- MY OVERRIDE -->\n');
  const refusalEdited = fs.readFileSync(refusalFile, 'utf8');
  // an unrelated unknown user file
  const userFile = path.join(treeRoot, 'skills', 'my-notes.md');
  fs.writeFileSync(userFile, 'personal', 'utf8');

  // --- build version B: change the REPO source so content genuinely differs ---
  const srcCore = path.join(REPO_ROOT, 'skills', 'core', 'secure-fintech-coding.md');
  const srcCoreOrig = fs.readFileSync(srcCore, 'utf8');
  fs.writeFileSync(srcCore, srcCoreOrig + '\n<!-- VERSION B MARKER -->\n', 'utf8');
  try {
    const out = run(['--tool', 'codex', '--target', t, '--home', t]);
    // unchanged managed file -> updated to B
    const bCore = fs.readFileSync(coreFile, 'utf8');
    assert.notEqual(bCore, aContentCore, 'core file changed from A');
    assert.ok(bCore.includes('VERSION B MARKER'), 'core file is now B');
    // edited managed file -> preserved + reported
    assert.ok(/preserved 1 edited managed file/.test(out), 'edited managed file reported');
    assert.equal(fs.readFileSync(refusalFile, 'utf8'), refusalEdited, 'user edit on refusal preserved byte-for-byte');
    // unknown user file preserved
    assert.ok(fs.existsSync(userFile) && fs.readFileSync(userFile, 'utf8') === 'personal', 'unknown user file preserved');
  } finally {
    fs.writeFileSync(srcCore, srcCoreOrig, 'utf8'); // restore repo source
  }
  fs.rmSync(t, { recursive: true, force: true });
});

test('F02b. --force replaces an edited managed file with B', () => {
  const t = tmp();
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const refusalFile = path.join(t, '.fintech-compliance-skills', 'skills', 'refusal', 'refusal-policy.md');
  fs.appendFileSync(refusalFile, '\n<!-- EDIT -->\n');
  run(['--tool', 'codex', '--target', t, '--home', t, '--force']);
  assert.ok(!fs.readFileSync(refusalFile, 'utf8').includes('<!-- EDIT -->'), 'force overwrote the edit');
  fs.rmSync(t, { recursive: true, force: true });
});

test('11. unknown user files under the Codex dir are preserved across re-install', () => {
  const t = tmp();
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const userFile = path.join(t, '.fintech-compliance-skills', 'skills', 'core', 'my-extra.md');
  fs.writeFileSync(userFile, 'personal notes', 'utf8');
  run(['--tool', 'codex', '--target', t, '--home', t]);
  assert.ok(fs.existsSync(userFile) && fs.readFileSync(userFile, 'utf8') === 'personal notes');
  fs.rmSync(t, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// F03: rollback at the AGENTS.md WRITE stage (not the read stage)
// ---------------------------------------------------------------------------

test('F03. a failure renaming AGENTS.md into place rolls the tree back to the previous install', () => {
  const t = tmp();
  run(['--tool', 'codex', '--target', t, '--home', t]); // v1
  const treeRoot = path.join(t, '.fintech-compliance-skills');
  const coreFile = path.join(treeRoot, 'skills', 'core', 'secure-fintech-coding.md');
  const v1Core = fs.readFileSync(coreFile, 'utf8');
  const v1Agents = fs.readFileSync(path.join(t, 'AGENTS.md'), 'utf8');

  // AGENTS.md is written to a temp file then atomically renamed into place. Inject a failure
  // at that final RENAME (temp -> AGENTS.md), which is the real commit step.
  const realRename = fs.renameSync;
  let threw = false;
  fs.renameSync = function (a, b, ...rest) {
    if (typeof b === 'string' && b.endsWith('AGENTS.md')) { threw = true; throw new Error('INJECTED rename failure'); }
    return realRename.call(fs, a, b, ...rest);
  };
  try {
    assert.throws(() => api.installCodex(t, api.listSkillFiles(), { force: false }), /INJECTED rename failure/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.ok(threw, 'failure was injected at the AGENTS.md rename');
  assert.ok(fs.existsSync(coreFile), 'rule tree still present after failed update');
  assert.equal(fs.readFileSync(coreFile, 'utf8'), v1Core, 'rule tree is the previous good version');
  assert.equal(fs.readFileSync(path.join(t, 'AGENTS.md'), 'utf8'), v1Agents, 'AGENTS.md unchanged (no partial active file)');
  const leftovers = fs.readdirSync(t).filter((n) => /\.fcs-(tmp|stage|old)-/.test(n));
  assert.deepEqual(leftovers, [], 'no orphan temp/staging/backup dirs');
  fs.rmSync(t, { recursive: true, force: true });
});

test('F03b. first-ever install failing at AGENTS.md rename leaves no partial tree claimed as success', () => {
  const t = tmp();
  const realRename = fs.renameSync;
  fs.renameSync = function (a, b, ...rest) {
    if (typeof b === 'string' && b.endsWith('AGENTS.md')) throw new Error('INJECTED');
    return realRename.call(fs, a, b, ...rest);
  };
  try {
    assert.throws(() => api.installCodex(t, api.listSkillFiles(), { force: false }), /INJECTED/);
  } finally { fs.renameSync = realRename; }
  // On first install there was no previous tree to roll back to; the tree must not be left as a "success".
  assert.ok(!fs.existsSync(path.join(t, 'AGENTS.md')), 'no AGENTS.md written on failed first install');
  const leftovers = fs.existsSync(t) ? fs.readdirSync(t).filter((n) => /\.fcs-(tmp|stage|old)-/.test(n)) : [];
  assert.deepEqual(leftovers, [], 'no orphan temp/staging/backup dirs');
  fs.rmSync(t, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// F07 + link correctness
// ---------------------------------------------------------------------------

test('F07. ./ ../ and anchor links rewritten with anchors preserved; code/URLs untouched', () => {
  const src = [
    'see [java](./java.md#hashing--encryption)',
    'and [core](../core/secure-fintech-coding.md)',
    'and [web](https://example.com/x.md)',
    '`inline ../core/x.md code`',
    '```\nfenced ../core/y.md block\n```',
  ].join('\n');
  const out = api.rewriteRelativeLinks(src);
  assert.ok(out.includes('](../java/SKILL.md#hashing--encryption)'), './sibling + anchor rewritten & anchor kept');
  assert.ok(out.includes('](../secure-fintech-coding/SKILL.md)'), '../group/file rewritten');
  assert.ok(out.includes('https://example.com/x.md'), 'external URL left alone');
  assert.ok(out.includes('`inline ../core/x.md code`'), 'inline code left alone');
  assert.ok(out.includes('fenced ../core/y.md block'), 'fenced code left alone');
});

test('12. installed scala links (./java.md regression) resolve on disk', () => {
  const t = tmp();
  run(['--tool', 'claude', '--target', t, '--home', t]);
  const scala = path.join(t, '.claude', 'skills', 'scala', 'SKILL.md');
  if (fs.existsSync(scala)) {
    const txt = fs.readFileSync(scala, 'utf8');
    let checked = 0;
    for (const m of txt.matchAll(/\]\((\.\.?\/[^)]+)\)/g)) {
      const file = m[1].split('#')[0];
      assert.ok(fs.existsSync(path.resolve(path.dirname(scala), file)), `scala link ${m[1]} resolves`);
      checked++;
    }
    assert.ok(checked > 0, 'scala actually had local links to check');
  }
  fs.rmSync(t, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// YAML, CLI, packed artifact
// ---------------------------------------------------------------------------

test('13. real YAML: tricky description parses; a broken frontmatter actually throws (negative fixture)', () => {
  const tricky = 'Config: "quoted", path C:\\x, unicode é — and: colons';
  const fm = `name: "x"\ndescription: ${JSON.stringify(tricky)}\ntriggers: "a, b"\n`;
  const meta = yaml.load(fm);
  assert.equal(meta.description, tricky);
  assert.throws(() => yaml.load('description: "unterminated\nname: x'), /./);
  // and prove the generator's real output for EVERY skill parses
  for (const s of api.listSkillFiles()) {
    const content = api.managedContent(s);
    const fmBlock = content.slice(3, content.indexOf('\n---', 3));
    const parsed = yaml.load(fmBlock);
    assert.equal(typeof parsed.name, 'string');
    assert.equal(typeof parsed.description, 'string');
    assert.equal(typeof parsed.triggers, 'string');
  }
});

test('14. bad CLI args exit non-zero with a message', () => {
  assert.throws(() => run(['--tool', 'nope']), (e) => /Unknown --tool/.test(e.stderr.toString()));
  assert.throws(() => run(['--tool', 'kiro', '--scope', 'bogus']), (e) => /Unknown --scope/.test(e.stderr.toString()));
});

test('16. packed npm artifact installs + re-installs correctly', () => {
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
  // re-install from the packed artifact is idempotent
  const out2 = execFileSync(process.execPath, [pkgInstaller, '--tool', 'claude', '--target', dest, '--home', dest], { stdio: 'pipe' }).toString();
  assert.match(out2, /0 new, 0 migrated/, 're-install from tarball is idempotent');
  fs.rmSync(t, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// R08: single frontmatter + real author metadata (no derived/duplicated block)
// ---------------------------------------------------------------------------
// A skill whose SOURCE carries YAML frontmatter must install with EXACTLY ONE
// frontmatter block, using the author's own name/description/triggers — not a
// derived description prepended while the author's block lingers in the body.
function frontmatterSkillName() {
  // Pick a source skill that actually starts with a `---` fence.
  for (const s of api.listSkillFiles()) {
    const txt = fs.readFileSync(s.abs, 'utf8');
    if (/^\uFEFF?---[ \t]*\r?\n/.test(txt)) return s.name;
  }
  return null;
}

test('R08. author-frontmatter skill installs with a SINGLE block + author metadata (no duplicate, no derived override)', () => {
  const name = frontmatterSkillName();
  assert.ok(name, 'repo has at least one source skill with YAML frontmatter');
  const src = api.listSkillFiles().find((s) => s.name === name);
  const srcText = fs.readFileSync(src.abs, 'utf8');
  // author's declared metadata from the SOURCE
  const srcFm = srcText.slice(srcText.indexOf('---') + 3, srcText.indexOf('\n---', 3));
  const srcMeta = yaml.load(srcFm);

  const t = tmp();
  run(['--tool', 'claude', '--target', t, '--home', t]);
  const installed = fs.readFileSync(path.join(t, '.claude', 'skills', name, 'SKILL.md'), 'utf8');

  // exactly ONE frontmatter fence pair (a `---` line at col 0, twice — open+close)
  const fences = (installed.match(/^---[ \t]*$/gm) || []).length;
  assert.equal(fences, 2, 'exactly one frontmatter block (open+close), not a duplicated/lingering one');

  // body (everything after the first closing fence) must NOT contain a second
  // frontmatter `name:`/`description:` key line left over from the source.
  const afterFm = installed.slice(installed.indexOf('\n---', 3) + 4);
  assert.ok(!/^\s*name:\s*["']?fintech/m.test(afterFm), 'no leftover author frontmatter in body');
  assert.ok(!/^\s*description:\s*["']/m.test(afterFm), 'no leftover description key in body');

  // installed description/name/triggers equal the AUTHOR's, not a derived first-bold run
  const meta = yaml.load(installed.slice(3, installed.indexOf('\n---', 3)));
  assert.equal(meta.name, srcMeta.name, 'author name preserved');
  assert.equal(meta.description, srcMeta.description, 'author description preserved verbatim (not re-derived)');
  if (srcMeta.triggers) assert.equal(meta.triggers, srcMeta.triggers, 'author triggers preserved');
  fs.rmSync(t, { recursive: true, force: true });
});

test('R08b. a metadata-less (old-style) skill still installs with ONE derived frontmatter (explicit fallback)', () => {
  // secure-fintech-coding has NO source frontmatter: it starts with `# Skill:`.
  const name = 'secure-fintech-coding';
  const src = api.listSkillFiles().find((s) => s.name === name);
  assert.ok(src, 'fallback skill exists');
  const srcText = fs.readFileSync(src.abs, 'utf8');
  assert.ok(!/^\uFEFF?---[ \t]*\r?\n/.test(srcText), 'source has NO frontmatter (the fallback case)');

  const t = tmp();
  run(['--tool', 'claude', '--target', t, '--home', t]);
  const installed = fs.readFileSync(path.join(t, '.claude', 'skills', name, 'SKILL.md'), 'utf8');
  const fences = (installed.match(/^---[ \t]*$/gm) || []).length;
  assert.equal(fences, 2, 'exactly one derived frontmatter block for a metadata-less source');
  const meta = yaml.load(installed.slice(3, installed.indexOf('\n---', 3)));
  assert.equal(meta.name, name, 'name derives from the skill dir name');
  assert.ok(meta.description && meta.description.length > 0, 'a description is derived from the first bold run');
  fs.rmSync(t, { recursive: true, force: true });
});

test('R08c. client-specific (non-standard) source frontmatter keys are carried through, not dropped', () => {
  // Build a throwaway source skill with an extra key and verify managedContent keeps it.
  const extraKey = 'x-client-meta';
  const t = tmp();
  const grp = path.join(t, 'extra');
  fs.mkdirSync(grp, { recursive: true });
  const f = path.join(grp, 'demo-skill.md');
  fs.writeFileSync(f, `---\nname: "demo-skill"\ndescription: "Author desc."\ntriggers: "demo"\n${extraKey}: "keep-me-42"\n---\n\n# Skill: Demo\n\n**Body.**\n`, 'utf8');
  const skill = { group: 'extra', file: 'demo-skill.md', name: 'demo-skill', abs: f };
  const mc = api.managedContent(skill);
  const fences = (mc.match(/^---[ \t]*$/gm) || []).length;
  assert.equal(fences, 2, 'single frontmatter block');
  const meta = yaml.load(mc.slice(3, mc.indexOf('\n---', 3)));
  assert.equal(meta.name, 'demo-skill');
  assert.equal(meta.description, 'Author desc.', 'author description kept');
  assert.equal(meta[extraKey], 'keep-me-42', 'client-specific key carried through verbatim');
  fs.rmSync(t, { recursive: true, force: true });
});

test('R08d. a 400-char valid description is PRESERVED verbatim (no silent truncation)', () => {
  const t = tmp();
  const grp = path.join(t, 'extra');
  fs.mkdirSync(grp, { recursive: true });
  const desc = 'D'.repeat(400);
  const f = path.join(grp, 'demo-skill.md');
  fs.writeFileSync(f, `---\nname: "demo-skill"\ndescription: "${desc}"\ntriggers: "demo"\n---\n\n# Skill: Demo\n\n**Body.**\n`, 'utf8');
  const mc = api.managedContent({ group: 'extra', file: 'demo-skill.md', name: 'demo-skill', abs: f });
  const meta = yaml.load(mc.slice(3, mc.indexOf('\n---', 3)));
  assert.equal(meta.description, desc, '400-char description preserved in full, not cut to ~300');
  assert.ok(!meta.description.includes('…'), 'no ellipsis truncation');
  fs.rmSync(t, { recursive: true, force: true });
});

test('R08e. a description over the limit throws an EXPLICIT error (no silent truncation)', () => {
  assert.throws(
    () => api.frontmatter('demo', 'Z'.repeat(api.MAX_DESCRIPTION + 1), 'trig', {}),
    /over the \d+-char limit/,
    'over-limit description is an explicit error, not a quiet cut');
  // at the limit it is accepted
  assert.doesNotThrow(() => api.frontmatter('demo', 'Z'.repeat(api.MAX_DESCRIPTION), 'trig', {}));
});

test('R08f. nested metadata (metadata.version) and a sequence round-trip through install', () => {
  const t = tmp();
  const grp = path.join(t, 'extra');
  fs.mkdirSync(grp, { recursive: true });
  const f = path.join(grp, 'demo-skill.md');
  fs.writeFileSync(f, `---\nname: "demo-skill"\ndescription: "Author desc."\ntriggers: "demo"\nmetadata:\n  version: 7\n  owner: "team-a"\ntags:\n  - alpha\n  - beta\n---\n\n# Skill: Demo\n\n**Body.**\n`, 'utf8');
  const mc = api.managedContent({ group: 'extra', file: 'demo-skill.md', name: 'demo-skill', abs: f });
  const meta = yaml.load(mc.slice(3, mc.indexOf('\n---', 3)));
  assert.ok(meta.metadata && meta.metadata.version === 7, 'nested metadata.version round-trips (was dropped -> metadata:"")');
  assert.equal(meta.metadata.owner, 'team-a', 'nested metadata.owner round-trips');
  assert.deepEqual(meta.tags, ['alpha', 'beta'], 'a YAML sequence round-trips');
  fs.rmSync(t, { recursive: true, force: true });
});

test('R08g. a quoted scalar with special chars + a BOM/CRLF source parse correctly', () => {
  const t = tmp();
  const grp = path.join(t, 'extra');
  fs.mkdirSync(grp, { recursive: true });
  const f = path.join(grp, 'demo-skill.md');
  // leading UTF-8 BOM + CRLF line endings + a description containing a colon and quotes
  const src = '\uFEFF---\r\nname: "demo-skill"\r\ndescription: "Handle A: store B, never C."\r\ntriggers: "demo"\r\n---\r\n\r\n# Skill: Demo\r\n\r\n**Body.**\r\n';
  fs.writeFileSync(f, src, 'utf8');
  const mc = api.managedContent({ group: 'extra', file: 'demo-skill.md', name: 'demo-skill', abs: f });
  const meta = yaml.load(mc.slice(3, mc.indexOf('\n---', 3)));
  assert.equal(meta.description, 'Handle A: store B, never C.', 'BOM + CRLF + special chars parse correctly');
  fs.rmSync(t, { recursive: true, force: true });
});

test('R08h. every real source skill filename matches a stable name<->folder mapping', () => {
  // The installed layout is <name>/SKILL.md; the emitted `name` must equal the source basename
  // (or the author-set name) so a skill cannot be installed under a folder that disagrees with
  // its declared name. We assert the invariant across the REAL skill set.
  for (const s of api.listSkillFiles()) {
    const parsed = api.parseSkill(s.abs);
    const emittedName = parsed.name || s.name;
    // the install folder is the skill's `name`; it must be a safe slug and match the source file
    assert.ok(/^[a-z0-9-]+$/i.test(s.name), `${s.name}: source basename is a safe folder slug`);
    if (parsed.name) {
      assert.ok(/^[a-z0-9-]+$/i.test(emittedName), `${s.name}: author name '${emittedName}' is a safe folder slug`);
    }
  }
});


// ---------------------------------------------------------------------------
// G1-G4: second-round regressions (deeper Codex migration + atomic AGENTS.md write)
// ---------------------------------------------------------------------------
// G1: user edit deleted on the SECOND re-install (not the first)
test('G1: edited managed Codex file survives repeated re-installs', () => {
  const t = tmp();
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const f = path.join(t, '.fintech-compliance-skills', 'skills', 'refusal', 'refusal-policy.md');
  fs.appendFileSync(f, '\n<!-- MY OVERRIDE -->\n');
  const edited = fs.readFileSync(f, 'utf8');
  run(['--tool', 'codex', '--target', t, '--home', t]); // re-install #1
  assert.equal(fs.readFileSync(f, 'utf8'), edited, 'edit survives re-install #1');
  run(['--tool', 'codex', '--target', t, '--home', t]); // re-install #2 (bug deletes here)
  assert.equal(fs.readFileSync(f, 'utf8'), edited, 'edit survives re-install #2');
  run(['--tool', 'codex', '--target', t, '--home', t]); // re-install #3
  assert.equal(fs.readFileSync(f, 'utf8'), edited, 'edit survives re-install #3');
  fs.rmSync(t, { recursive: true, force: true });
});

// G2: user text that itself references skills/ after a legacy section is preserved
test('G2: user text referencing skills/ after a legacy Codex section is preserved', () => {
  const t = tmp();
  const legacyAgents = fs.readFileSync(path.join(FIX, 'pr5', 'codex', 'AGENTS.md'), 'utf8');
  const userAfter = '\n\n# TEAM RULES AFTER\nAlways read skills/team-policy.md before editing.\nAlso see .fintech-compliance-skills/notes.md\n';
  fs.writeFileSync(path.join(t, 'AGENTS.md'), legacyAgents + userAfter, 'utf8');
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const after = fs.readFileSync(path.join(t, 'AGENTS.md'), 'utf8');
  assert.ok(after.includes('# TEAM RULES AFTER'), 'user heading preserved');
  assert.ok(after.includes('Always read skills/team-policy.md before editing.'), 'user skills/ ref preserved');
  fs.rmSync(t, { recursive: true, force: true });
});

// G3: real 19b4f33 Codex install (rule tree present, NO manifest) must UPGRADE to current source
test('G3: manifest-less old Codex rule files upgrade to current source (not left stale)', () => {
  const t = tmp();
  // lay down the real pr6 Codex rule tree with NO manifest (exactly what 19b4f33 produced)
  const treeSrc = path.join(FIX, 'pr6', 'codex', 'skills');
  const treeDst = path.join(t, '.fintech-compliance-skills', 'skills');
  fs.mkdirSync(path.dirname(treeDst), { recursive: true });
  fs.cpSync(treeSrc, treeDst, { recursive: true });
  fs.writeFileSync(path.join(t, 'AGENTS.md'), fs.readFileSync(path.join(FIX, 'pr6', 'codex', 'AGENTS.md'), 'utf8'), 'utf8');
  run(['--tool', 'codex', '--target', t, '--home', t]);
  // the 6 critical modules must now be byte-identical to the CURRENT repo source
  for (const rel of ['databases/postgresql.md', 'global/pci-dss.md', 'languages/csharp-dotnet.md', 'refusal/refusal-policy.md', 'regional/eu-gdpr-psd2-dora.md', 'regional/turkey-kvkk-bddk-masak.md']) {
    const installed = fs.readFileSync(path.join(treeDst, rel), 'utf8');
    const source = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'skills', rel), 'utf8');
    assert.equal(installed, source, `${rel} upgraded to current source`);
  }
  fs.rmSync(t, { recursive: true, force: true });
});

// G4: a failure at ANY write/commit stage must not leave a corrupt active AGENTS.md.
// The fix stages AGENTS.md to a temp file then atomically renames, so we inject at the
// temp-write, the rename, and the tree-commit stages, plus first-install, plus a
// rollback-time failure — and in every case assert the active file stays consistent.
test('G4: partial/failed AGENTS.md write never corrupts the active file (all stages)', () => {
  const realWrite = fs.writeFileSync;
  const realRename = fs.renameSync;

  // --- A. failure WHILE writing the temp AGENTS file (partial bytes land in the TEMP file) ---
  {
    const t = tmp();
    run(['--tool', 'codex', '--target', t, '--home', t]); // v1
    const dest = path.join(t, 'AGENTS.md');
    const v1 = fs.readFileSync(dest, 'utf8');
    fs.writeFileSync = function (p, data, ...rest) {
      if (typeof p === 'string' && /AGENTS\.md\.fcs-tmp-/.test(p)) {
        realWrite.call(fs, p, String(data).slice(0, 40), ...rest); // partial content into TEMP only
        throw new Error('INJECTED temp-write');
      }
      return realWrite.call(fs, p, data, ...rest);
    };
    try { assert.throws(() => api.installCodex(t, api.listSkillFiles(), { force: false }), /INJECTED temp-write/); }
    finally { fs.writeFileSync = realWrite; }
    assert.equal(fs.readFileSync(dest, 'utf8'), v1, 'A: active AGENTS.md unchanged (partial landed only in temp)');
    assert.deepEqual(fs.readdirSync(t).filter((n) => /\.fcs-(tmp|stage|old)-/.test(n)), [], 'A: no orphan temp/stage/old');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // --- B. failure at the AGENTS.md RENAME (temp fully written, rename throws) ---
  {
    const t = tmp();
    run(['--tool', 'codex', '--target', t, '--home', t]);
    const dest = path.join(t, 'AGENTS.md');
    const v1 = fs.readFileSync(dest, 'utf8');
    const treeFile = path.join(t, '.fintech-compliance-skills', 'skills', 'core', 'secure-fintech-coding.md');
    const v1Tree = fs.readFileSync(treeFile, 'utf8');
    fs.renameSync = function (a, b, ...rest) {
      if (typeof b === 'string' && b.endsWith('AGENTS.md')) throw new Error('INJECTED rename');
      return realRename.call(fs, a, b, ...rest);
    };
    try { assert.throws(() => api.installCodex(t, api.listSkillFiles(), { force: false }), /INJECTED rename/); }
    finally { fs.renameSync = realRename; }
    assert.equal(fs.readFileSync(dest, 'utf8'), v1, 'B: active AGENTS.md still the previous good content');
    assert.equal(fs.readFileSync(treeFile, 'utf8'), v1Tree, 'B: rule tree rolled back to previous');
    assert.deepEqual(fs.readdirSync(t).filter((n) => /\.fcs-(tmp|stage|old)-/.test(n)), [], 'B: no orphan temp/stage/old');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // --- C. failure at the TREE commit (rename of the staged tree) ---
  {
    const t = tmp();
    run(['--tool', 'codex', '--target', t, '--home', t]);
    const dest = path.join(t, 'AGENTS.md');
    const v1 = fs.readFileSync(dest, 'utf8');
    const treeFile = path.join(t, '.fintech-compliance-skills', 'skills', 'core', 'secure-fintech-coding.md');
    const v1Tree = fs.readFileSync(treeFile, 'utf8');
    fs.renameSync = function (a, b, ...rest) {
      // target ONLY the forward tree swap (staging dir -> .fintech-compliance-skills),
      // not the rollback (backup -> tree), so rollback can still restore the previous tree.
      if (typeof b === 'string' && b.endsWith('.fintech-compliance-skills') && typeof a === 'string' && /\.fcs-stage-/.test(a)) {
        throw new Error('INJECTED tree-commit');
      }
      return realRename.call(fs, a, b, ...rest);
    };
    try { assert.throws(() => api.installCodex(t, api.listSkillFiles(), { force: false }), /INJECTED tree-commit/); }
    finally { fs.renameSync = realRename; }
    assert.equal(fs.readFileSync(dest, 'utf8'), v1, 'C: active AGENTS.md unchanged');
    assert.equal(fs.readFileSync(treeFile, 'utf8'), v1Tree, 'C: rule tree unchanged');
    assert.deepEqual(fs.readdirSync(t).filter((n) => /\.fcs-(tmp|stage|old)-/.test(n)), [], 'C: no orphan temp/stage/old');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // --- D. FIRST install failing at the AGENTS rename: no AGENTS.md left, no false success ---
  {
    const t = tmp();
    fs.renameSync = function (a, b, ...rest) {
      if (typeof b === 'string' && b.endsWith('AGENTS.md')) throw new Error('INJECTED first-install');
      return realRename.call(fs, a, b, ...rest);
    };
    try { assert.throws(() => api.installCodex(t, api.listSkillFiles(), { force: false }), /INJECTED first-install/); }
    finally { fs.renameSync = realRename; }
    assert.ok(!fs.existsSync(path.join(t, 'AGENTS.md')), 'D: no AGENTS.md written on failed first install');
    assert.deepEqual(fs.existsSync(t) ? fs.readdirSync(t).filter((n) => /\.fcs-(tmp|stage|old)-/.test(n)) : [], [], 'D: no orphan temp/stage/old');
    fs.rmSync(t, { recursive: true, force: true });
  }

  // --- E. failure DURING rollback must not delete recovery data; it must surface an error ---
  {
    const t = tmp();
    run(['--tool', 'codex', '--target', t, '--home', t]);
    const treeFile = path.join(t, '.fintech-compliance-skills', 'skills', 'core', 'secure-fintech-coding.md');
    const v1Tree = fs.readFileSync(treeFile, 'utf8');
    let stage = 0;
    fs.renameSync = function (a, b, ...rest) {
      if (typeof b === 'string' && b.endsWith('AGENTS.md')) throw new Error('INJECTED commit'); // trigger rollback
      // during rollback the backup dir is renamed back onto the tree; fail that ONCE
      if (typeof b === 'string' && b.endsWith('.fintech-compliance-skills') && typeof a === 'string' && /\.fcs-old-/.test(a) && stage++ === 0) {
        throw new Error('INJECTED rollback');
      }
      return realRename.call(fs, a, b, ...rest);
    };
    let caught;
    try { api.installCodex(t, api.listSkillFiles(), { force: false }); }
    catch (e) { caught = e; }
    finally { fs.renameSync = realRename; }
    assert.ok(caught, 'E: an error was surfaced (no silent success)');
    // recovery data (the .fcs-old backup holding v1 tree) must still exist on disk
    const backups = fs.readdirSync(t).filter((n) => /\.fcs-old-/.test(n));
    assert.ok(backups.length === 1, 'E: the backup (recovery data) was NOT deleted');
    assert.equal(fs.readFileSync(path.join(t, backups[0], 'skills', 'core', 'secure-fintech-coding.md'), 'utf8'), v1Tree, 'E: backup still holds the previous good tree');
    fs.rmSync(t, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E: CLI subcommands — list / explain / dry-run / diff / uninstall
// ---------------------------------------------------------------------------
// exit-code-aware runner (run() throws on non-zero; these need the code+output)
function runCli(args, opts = {}) {
  try { return { code: 0, out: execFileSync(process.execPath, [INSTALLER, ...args], { stdio: 'pipe', ...opts }).toString() }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '').toString() + (e.stderr || '').toString() }; }
}

test('E-list: JSON lists every skill with its controls + evidence status', () => {
  const r = runCli(['list', '--json']);
  assert.equal(r.code, 0, 'list exits 0');
  const j = JSON.parse(r.out);
  assert.equal(j.skills.length, sourceSkillNames.length, 'lists every source skill');
  for (const s of j.skills) {
    assert.ok(typeof s.description === 'string' && s.description.length > 0, `${s.name} has a description`);
    assert.ok(Array.isArray(s.controls), `${s.name} reports its controls`);
    assert.ok(Number.isInteger(s.needs_review_controls), `${s.name} reports needs-review count`);
  }
});

test('E-explain: a declared-role profile selects controls with REASONS; obligations not inferred', () => {
  const r = runCli(['explain', '--profile', 'tr-psp-postgres', '--json']);
  assert.equal(r.code, 0, 'explain exits 0');
  const j = JSON.parse(r.out);
  assert.equal(j.role_declared, true, 'role is declared in this profile');
  assert.ok(j.selected.length > 0, 'some controls selected');
  for (const s of j.selected) assert.ok(s.why && s.why.length, `${s.id} has an explicit reason`);
  // the red-line PAN control is selected because the profile declares pan data
  assert.ok(j.selected.some((s) => s.id === 'FCS-PAN-001'), 'PAN control selected for a pan-handling profile');
});

test('E-explain: a profile with role NOT declared surfaces the ambiguity (no inference)', () => {
  const t = tmp();
  // synthesise a profile whose role is not declared
  const profDir = path.join(REPO_ROOT, 'controls', 'profiles');
  const tmpProfile = path.join(profDir, 'zzz-test-undeclared.json');
  fs.writeFileSync(tmpProfile, JSON.stringify({
    profile_id: 'zzz-test-undeclared', description: 'test', entity_role: { kind: 'unknown', activity: 'unknown', declared: false },
    jurisdictions: ['TR'], data_categories: ['pan'], payment_providers: [], stack: { languages: [], databases: [], detected: true }, assumptions: [], overlays: [],
  }), 'utf8');
  try {
    const r = runCli(['explain', '--profile', 'zzz-test-undeclared', '--json']);
    const j = JSON.parse(r.out);
    assert.equal(j.role_declared, false, 'role not declared');
    assert.ok(j.ambiguities.some((a) => /not inferred/i.test(a)), 'ambiguity: obligations are not inferred');
    assert.ok(j.ambiguities.some((a) => /auto-detected/i.test(a)), 'ambiguity: detected stack flagged');
  } finally { fs.rmSync(tmpProfile, { force: true }); fs.rmSync(t, { recursive: true, force: true }); }
});

test('E-dry-run: install --dry-run writes NOTHING', () => {
  const t = tmp();
  const r = runCli(['--tool', 'claude', '--target', t, '--home', t, '--dry-run', '--json']);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.dry_run, true);
  assert.ok(j.changes.length === sourceSkillNames.length);
  assert.ok(!fs.existsSync(path.join(t, '.claude')), 'dry-run created NO files');
  fs.rmSync(t, { recursive: true, force: true });
});

test('E-diff: diff reports create/update/unchanged and touches nothing', () => {
  const t = tmp();
  run(['--tool', 'claude', '--target', t, '--home', t]); // real install
  const before = walkFiles(path.join(t, '.claude'));
  const r = runCli(['diff', '--tool', 'claude', '--target', t, '--home', t, '--json']);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.ok((j.summary.unchanged || 0) === sourceSkillNames.length, 'a fresh install diffs as all-unchanged');
  const after = walkFiles(path.join(t, '.claude'));
  assert.deepEqual(after, before, 'diff wrote nothing');
  fs.rmSync(t, { recursive: true, force: true });
});

test('E-uninstall: removes only unchanged managed; preserves user edits; --dry-run writes nothing', () => {
  const t = tmp();
  run(['--tool', 'claude', '--target', t, '--home', t]);
  // user-edit one skill
  const edited = path.join(t, '.claude', 'skills', 'go', 'SKILL.md');
  fs.appendFileSync(edited, '\n<!-- user edit -->\n');
  // dry-run first: nothing removed
  const dry = runCli(['uninstall', '--tool', 'claude', '--target', t, '--home', t, '--dry-run']);
  assert.equal(dry.code, 0);
  assert.ok(fs.existsSync(edited), 'dry-run uninstall removed nothing');
  // real uninstall: unchanged removed, the edited one preserved
  const r = runCli(['uninstall', '--tool', 'claude', '--target', t, '--home', t]);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(edited), 'user-edited skill PRESERVED');
  assert.ok(!fs.existsSync(path.join(t, '.claude', 'skills', 'python', 'SKILL.md')), 'an unchanged managed skill was removed');
  fs.rmSync(t, { recursive: true, force: true });
});

test('E-uninstall codex: removes the managed AGENTS block but keeps user text', () => {
  const t = tmp();
  fs.writeFileSync(path.join(t, 'AGENTS.md'), '# My own notes\nkeep me\n', 'utf8');
  run(['--tool', 'codex', '--target', t, '--home', t]);
  const r = runCli(['uninstall', '--tool', 'codex', '--target', t, '--home', t]);
  assert.equal(r.code, 0);
  const agents = fs.readFileSync(path.join(t, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('# My own notes') && agents.includes('keep me'), 'user text preserved');
  assert.ok(!agents.includes(api.BLOCK_START), 'managed block removed');
  fs.rmSync(t, { recursive: true, force: true });
});

test('E-strict: an unknown flag or command errors (exit 2) and never installs', () => {
  const t = tmp();
  const f = runCli(['--tool', 'claude', '--target', t, '--home', t, '--frobnicate']);
  assert.equal(f.code, 2, 'unknown flag exits 2');
  assert.ok(!fs.existsSync(path.join(t, '.claude')), 'unknown flag did NOT install');
  const c = runCli(['frobnicate', '--tool', 'claude', '--target', t, '--home', t]);
  assert.equal(c.code, 2, 'unknown command exits 2');
  assert.ok(!fs.existsSync(path.join(t, '.claude')), 'unknown command did NOT install');
  fs.rmSync(t, { recursive: true, force: true });
});
