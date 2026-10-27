#!/usr/bin/env node
/*
 * fintech-compliance-skills installer
 *
 * Targets:
 *   claude     -> <target>/.claude/skills/<name>/SKILL.md      (--scope user -> <home>/.claude/skills)
 *   kiro       -> <home>/.kiro/skills/<name>/SKILL.md          (--scope workspace -> <target>/.kiro/skills)
 *   kiro-crew  -> <home>/.kiro/crew/skills/<name>/SKILL.md
 *   codex      -> <target>/AGENTS.md + <target>/.fintech-compliance-skills/skills/
 *
 * Guarantees:
 *   - Referenced rule files always exist at the installed location
 *     (cross-links rewritten for the flat layout, anchors preserved; Codex gets the tree copied).
 *   - YAML frontmatter is emitted as safe double-quoted scalars (always parses).
 *   - Re-running is idempotent (content hash; Codex uses a marker-delimited block + manifest).
 *   - A file edited by the user is preserved (skipped) unless --force.
 *   - An UNEDITED file from EITHER previous installer is recognised by a byte-exact full-file
 *     hash (captured from git history), then migrated to the new format with a .bak backup.
 *     Any user edit changes the hash and is preserved, never overwritten.
 *   - Writes are staged in a temp dir and moved into place; a failed write (including the
 *     final AGENTS.md write) rolls back to the previous working install.
 *
 * Manifest contract (Codex): keys are tree-relative POSIX paths INCLUDING the leading
 * `skills/` segment, e.g. "skills/core/secure-fintech-coding.md". Both the writer
 * (copyTree) and the reader (carry-over walk) use this one convention; a legacy
 * manifest without the prefix is normalised on read.
 *
 * Zero runtime dependencies — Node built-ins only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');

const REPO_ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

const BLOCK_START = '<!-- BEGIN fintech-compliance-skills (managed; do not edit inside) -->';
const BLOCK_END = '<!-- END fintech-compliance-skills -->';
const STAMP_RE = /\n\n<!-- fcs-managed-hash:([0-9a-f]+) -->\n?$/;
const stampFor = (content) => `\n\n<!-- fcs-managed-hash:${sha(content)} -->\n`;
// The old installer's one-time marker between appended Codex sections.
const LEGACY_CODEX_MARKER = '<!-- fintech-compliance-skills -->';
// The generated heading both old Codex outputs start their block with.
const LEGACY_CODEX_HEADING = '# AGENTS.md — Fintech Compliance Rules';
const CODEX_ROOT = '.fintech-compliance-skills';
const CODEX_MANIFEST = '.fcs-manifest.json';

// ---------- discovery ----------

function listSkillFiles() {
  const out = [];
  for (const group of fs.readdirSync(SKILLS_DIR)) {
    const groupPath = path.join(SKILLS_DIR, group);
    if (!fs.statSync(groupPath).isDirectory()) continue;
    for (const file of fs.readdirSync(groupPath)) {
      if (!file.endsWith('.md')) continue;
      out.push({ group, file, name: file.replace(/\.md$/, ''), abs: path.join(groupPath, file) });
    }
  }
  return out;
}

function parseSkill(abs) {
  const text = fs.readFileSync(abs, 'utf8');
  const titleMatch = text.match(/^#\s+(?:Skill:\s*)?(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : path.basename(abs, '.md');
  const descMatch = text.match(/\*\*(.+?)\*\*/s);
  const desc = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : title;
  return { title, desc, body: text };
}

function triggersFor(skill) {
  const base = skill.name.replace(/-/g, ', ');
  const extra = {
    languages: 'write code, implement, coding',
    databases: 'schema, migration, query, store data',
    global: 'compliance, audit, standard',
    regional: 'regulation, jurisdiction, country',
    core: 'fintech, payment, money',
    refusal: 'refuse, red line, forbidden',
  }[skill.group] || '';
  return [base, extra].filter(Boolean).join(', ');
}

// ---------- YAML-safe emit ----------

function yamlScalar(s) { return JSON.stringify(String(s)); }

function frontmatter(name, description, triggers) {
  const d = description.length > 300 ? description.slice(0, 297) + '…' : description;
  return ['---', `name: ${yamlScalar(name)}`, `description: ${yamlScalar(d)}`,
    `triggers: ${yamlScalar(triggers)}`, '---', '', ''].join('\n');
}

// Flat <name>/SKILL.md layout: sibling skill X is at ../X/SKILL.md.
// F07: preserve #anchors; only rewrite the .md path, never external URLs or inline/fenced code.
function rewriteRelativeLinks(body) {
  const parts = body.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  const rewriteSeg = (seg) => seg
    // [text](../group/file.md#anchor) -> [text](../file/SKILL.md#anchor)
    .replace(/\]\(\.\.\/[a-z0-9-]+\/([a-z0-9-]+)\.md(#[^)]*)?\)/gi, (_m, f, anchor) => `](../${f}/SKILL.md${anchor || ''})`)
    // [text](./file.md#anchor) -> [text](../file/SKILL.md#anchor)
    .replace(/\]\(\.\/([a-z0-9-]+)\.md(#[^)]*)?\)/gi, (_m, f, anchor) => `](../${f}/SKILL.md${anchor || ''})`);
  return parts.map((p, i) => (i % 2 === 0 ? rewriteSeg(p) : p)).join('');
}

// The managed (new-format) body for a skill, without the trailing hash stamp.
function managedContent(skill) {
  const { desc, body } = parseSkill(skill.abs);
  return frontmatter(skill.name, desc, triggersFor(skill)) + rewriteRelativeLinks(body);
}

// ---------- LEGACY output recognition (for migration) ----------
// We recognise an UNEDITED file written by a previous installer by hashing the whole file
// and matching a fixed table of byte-exact hashes captured by running the REAL old
// installers from git history (see installer/fixtures/FIXTURES.json):
//   pr5 = b742e893  (unescaped frontmatter, no link rewrite, NO stamp)
//   pr6 = 19b4f33    (quoted frontmatter, link rewrite, WITH stamp — also matched by the stamp branch)
// Matching the FULL FILE (not just the frontmatter) is what distinguishes an unedited old
// install (migrate, F04) from a file the user edited (preserve, F04b): any edit changes the hash.
// Generated from OLD code, never from the current installer.
const LEGACY_FILE_HASHES = {
  'aml-kyc': ['d81cfba57dc297dd', '82731709efe1023e'],
  'cobol': ['6d19a30df3460d53', 'e642b9f6fddddcd1'],
  'csharp-dotnet': ['996bf667ab0c8fe5', 'aa72183f577750b2'],
  'db2': ['946ceb1edfdfa625', '2901f1d970e175b1'],
  'eu-gdpr-psd2-dora': ['04e47c00c60dd0c8', '2bbd20ff647ead55'],
  'go': ['880cc47652d80d60', '4e9a9263163bb19e'],
  'iso27001-soc2': ['ec848221e0f84301', 'a6adaefc92763e01'],
  'java': ['15ad79abcddbe36a', 'b25bc40bd81a92dc'],
  'javascript-typescript': ['da73e45ebfb30d53', '79dbb32ec2db34bd'],
  'kotlin': ['a26f0f47c462fd48', 'e8034fa02f396261'],
  'mongodb': ['0336f87f7c1670f8', '6d91a556a3993ed5'],
  'mysql-mariadb': ['fda2f37f1bb0cb59', 'fdf2c2f2e6912d49'],
  'oracle': ['867f7f78d0763eeb', '7b71f3351d5405a7'],
  'pci-dss': ['52d0afebc7549deb', 'aaa274b9e46c2f09'],
  'plsql': ['ce4672a8924ac737', '477febb94c4d3175'],
  'postgresql': ['ee823899b980a5d7', '4b1da4360e936453'],
  'python': ['fe63e0a932246a16', 'c8aa0d658ea353b1'],
  'redis': ['d821af09a58ddabc', '18f00fd8f3a040ab'],
  'refusal-policy': ['eadfc78287c6f460', '2a9b5b07bbe3bd86'],
  'rust': ['778f4af3aa48681e', 'ce1cb1ac9bdd2fff'],
  'scala': ['b18862e2f0ad5450', '8095200f4b149f97'],
  'secure-fintech-coding': ['db160b93a861ac39', '3dfbfe78c117b9ae'],
  'sql-server': ['634e7da39fd97e4d', '69093bb470776a69'],
  'turkey-kvkk-bddk-masak': ['13728ee32d3af663', '2b25899da9f95184'],
  'uk-fca-gdpr': ['d3c9492f911e5cbe', 'c43de2e50d64fb4e'],
  'us-sox-glba-ccpa': ['81e3a61652aa47e2', '8cfba7434d3b8314'],
};

// Is `fileText` a byte-exact, UNEDITED file from a previous installer for this skill?
function isLegacyOutput(skill, fileText) {
  const known = LEGACY_FILE_HASHES[skill.name];
  return !!known && known.includes(sha(fileText));
}

// ---------- fs helpers ----------

function expandHome(p, home) {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(1));
  return p;
}
function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }
function sha(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16); }
function readIf(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }
// A staging/backup sibling name that will not collide with a real user file.
function scratchName(base, suffix) { return `${base}.fcs-${suffix}-${process.pid}-${Date.now().toString(36)}`; }

// ---------- path resolver (testable: home + target injected) ----------

function resolveBase(tool, scope, target, home) {
  switch (tool) {
    case 'claude':
      return scope === 'user' ? path.join(home, '.claude', 'skills') : path.join(target, '.claude', 'skills');
    case 'kiro':
      return scope === 'workspace' ? path.join(target, '.kiro', 'skills') : path.join(home, '.kiro', 'skills');
    case 'kiro-crew':
      return path.join(home, '.kiro', 'crew', 'skills');
    default:
      return null;
  }
}

// ---------- SKILL.md installer (Claude / Kiro / Kiro-Crew) ----------
// classify(dest, skill) -> 'absent' | 'current' | 'ours-stale' | 'legacy' | 'user'
function classify(dest, skill) {
  const prev = readIf(dest);
  if (prev == null) return 'absent';
  const m = prev.match(STAMP_RE);
  if (m) {
    const bodyNow = prev.replace(STAMP_RE, '');
    if (sha(bodyNow) !== m[1]) return 'user';            // our stamp but body changed by user
    return bodyNow === managedContent(skill) ? 'current' : 'ours-stale';
  }
  // No stamp: migrate ONLY a byte-exact, UNEDITED file from a previous installer.
  // Any user edit changes the hash and falls through to 'user' (preserved). (F04 / F04b)
  return isLegacyOutput(skill, prev) ? 'legacy' : 'user';
}

function installSkillDir(baseDir, skills, { force }) {
  const res = { installed: 0, migrated: [], skipped: [], unchanged: 0, backups: [] };
  // Stage classification first, then commit, so a mid-run failure leaves the old install intact.
  const staged = [];
  for (const s of skills) {
    const dir = path.join(baseDir, s.name);
    const dest = path.join(dir, 'SKILL.md');
    const cls = force ? 'absent' : classify(dest, s);
    if (cls === 'current') { res.unchanged++; continue; }
    if (cls === 'user') { res.skipped.push(s.name); continue; }
    const content = managedContent(s);
    staged.push({ dir, dest, data: content + stampFor(content), migrate: cls === 'legacy', name: s.name });
  }
  // commit
  for (const st of staged) {
    mkdirp(st.dir);
    if (st.migrate && fs.existsSync(st.dest)) {
      const bak = st.dest + '.bak';
      if (!fs.existsSync(bak)) fs.copyFileSync(st.dest, bak); // never overwrite an existing user backup
      res.backups.push(bak);
    }
    const tmp = st.dest + '.tmp';
    fs.writeFileSync(tmp, st.data, 'utf8');
    fs.renameSync(tmp, st.dest);          // atomic replace on same volume
    if (st.migrate) res.migrated.push(st.name); else res.installed++;
  }
  return res;
}

// ---------- Codex installer ----------
// Manifest keys are tree-relative INCLUDING the leading `skills/` segment.
function copyTree(srcRoot, dstRoot, manifest) {
  const walk = (src, dst, rel) => {
    mkdirp(dst);
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(s, d, r);
      else { const data = fs.readFileSync(s); fs.writeFileSync(d, data); manifest[r] = sha(data.toString('utf8')); }
    }
  };
  walk(srcRoot, dstRoot, 'skills'); // keys become skills/<group>/<file>
}

function buildCodexBlock(skills, relRoot) {
  const byGroup = {};
  for (const s of skills) (byGroup[s.group] = byGroup[s.group] || []).push(s);
  const p = (g, f) => `${relRoot}/skills/${g}/${f}`;
  let md = `${BLOCK_START}\n# Fintech Compliance Rules\n\n`;
  md += `You write code for regulated financial systems. Before writing or changing\n`;
  md += `any code that touches money, payments, accounts, balances, or personal /\n`;
  md += `financial data, load and obey the relevant rule files below. **Always** obey\n`;
  md += `\`${p('core', 'secure-fintech-coding.md')}\` and \`${p('refusal', 'refusal-policy.md')}\`.\n`;
  md += `If a request would break a red line, refuse and name the rule — do not write\n`;
  md += `the non-compliant code.\n\n## Always load\n\n`;
  md += `- \`${p('core', 'secure-fintech-coding.md')}\` — baseline for all financial code\n`;
  md += `- \`${p('refusal', 'refusal-policy.md')}\` — hard limits / when to say no\n\n`;
  const order = ['global', 'regional', 'languages', 'databases'];
  const titleFor = { global: 'Load for the framework in scope', regional: "Load for the user's jurisdiction",
    languages: 'Load the one you are coding in', databases: 'Load the one you store in' };
  for (const g of order) {
    if (!byGroup[g]) continue;
    md += `## ${g[0].toUpperCase() + g.slice(1)} — ${titleFor[g]}\n\n`;
    for (const s of byGroup[g]) md += `- \`${p(g, s.file)}\` — ${parseSkill(s.abs).desc}\n`;
    md += `\n`;
  }
  md += `> These rule files were installed next to this AGENTS.md under \`${relRoot}/\`.\n`;
  md += `> Open the one that matches your task and follow its Do / Never / examples.\n`;
  md += BLOCK_END;
  return md;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Replace our managed block; also strip any legacy appended sections so old broken
// skills/... references do not linger. Preserves ALL user text outside those regions.
//
// F01: a legacy generated section is bounded PRECISELY. The old installer's block is
// always: [optional "<!-- marker -->"] heading + fixed intro + "## Group" subheadings +
// a bullet list whose items reference `skills/...`. Its content ALWAYS ends on the LAST
// line that references `skills/`. So we remove from the heading (or its preceding marker)
// up to and including that last `skills/`-referencing line, and KEEP everything after it
// verbatim (that is user text).
function mergeCodexBlock(existing, block) {
  let out = existing;

  // 1. Remove every one of OUR managed blocks (handles duplicates).
  const managedRe = new RegExp(`\\n*${escapeRe(BLOCK_START)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n*`, 'g');
  out = out.replace(managedRe, '\n');

  // 2. Remove every LEGACY generated section with a precise boundary.
  const lines = out.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let headingIdx = -1;
    if (line.startsWith(LEGACY_CODEX_HEADING)) {
      headingIdx = i;
    } else if (line.trim() === LEGACY_CODEX_MARKER) {
      let j = i + 1; while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && lines[j].startsWith(LEGACY_CODEX_HEADING)) headingIdx = j;
    }
    if (headingIdx === -1) { kept.push(line); continue; }

    // scan forward for the LAST `skills/`-referencing line of THIS generated section,
    // stopping at the next legacy heading / section-heading marker.
    let lastSkillsRef = headingIdx;
    for (let j = headingIdx + 1; j < lines.length; j++) {
      const t = lines[j];
      if (t.startsWith(LEGACY_CODEX_HEADING)) break;
      if (t.trim() === LEGACY_CODEX_MARKER) {
        let k = j + 1; while (k < lines.length && lines[k].trim() === '') k++;
        if (k < lines.length && lines[k].startsWith(LEGACY_CODEX_HEADING)) break;
      }
      if (/skills\//.test(t)) lastSkillsRef = j;
    }
    i = lastSkillsRef; // drop [current .. lastSkillsRef]; outer ++ resumes after it (user text)
  }

  out = kept.join('\n').replace(/\s*$/, '');
  out = (out ? out + '\n\n' : '') + `${block}\n`;
  return out.replace(/\n{3,}/g, '\n\n');
}

function installCodex(targetDir, skills, { force }) {
  mkdirp(targetDir);
  const treeDst = path.join(targetDir, CODEX_ROOT);
  const skillsDst = path.join(treeDst, 'skills');
  const manifestPath = path.join(treeDst, CODEX_MANIFEST);
  // F02: tolerate a missing/old/garbage manifest. Old manifests used `core/file.md` keys
  // (no leading skills/). Normalise any such legacy key to the single `skills/...` contract
  // so our own files are never mistaken for unknown user files.
  const rawPrev = (() => { try { return JSON.parse(readIf(manifestPath) || '{}'); } catch { return {}; } })();
  const prevManifest = {};
  for (const [k, v] of Object.entries(rawPrev)) {
    const key = k.startsWith('skills/') ? k : (/^(core|refusal|global|regional|languages|databases)\//.test(k) ? `skills/${k}` : k);
    prevManifest[key] = v;
  }

  // Stage the new tree in a uniquely-named temp dir; validate; then swap. Preserve unknown user files.
  const stage = scratchName(treeDst, 'stage');
  fs.rmSync(stage, { recursive: true, force: true });
  const manifest = {};
  let backup = null;
  try {
    copyTree(SKILLS_DIR, path.join(stage, 'skills'), manifest);
    const skipped = [];
    if (fs.existsSync(treeDst)) {
      // Carry over unknown user files; refuse to clobber a managed file the user edited.
      const walkPrev = (dir, rel) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, e.name);
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (r === CODEX_MANIFEST) continue;
          if (e.isDirectory()) { walkPrev(abs, r); continue; }
          const relKey = r; // tree-relative, includes leading skills/ for rule files
          const wasManaged = Object.prototype.hasOwnProperty.call(prevManifest, relKey);
          const cur = sha(fs.readFileSync(abs, 'utf8'));
          if (!wasManaged) {
            const d = path.join(stage, r); mkdirp(path.dirname(d)); fs.copyFileSync(abs, d); // unknown user file -> preserve
          } else if (!force && cur !== prevManifest[relKey] && manifest[relKey] !== cur) {
            // managed file the user edited (differs from installed AND from new content) -> preserve + skip
            const d = path.join(stage, r); mkdirp(path.dirname(d)); fs.copyFileSync(abs, d);
            manifest[relKey] = cur; // keep ownership so a future run still tracks it
            skipped.push(relKey);
          }
          // else: managed + unchanged (or --force) -> the fresh staged copy wins.
        }
      };
      walkPrev(treeDst, '');
    }
    fs.writeFileSync(path.join(stage, CODEX_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');

    // AGENTS.md merge (compute before swapping so a failure here leaves tree untouched).
    const block = buildCodexBlock(skills, CODEX_ROOT);
    const dest = path.join(targetDir, 'AGENTS.md');
    const existing = readIf(dest);
    const agentsOut = existing == null ? block + '\n' : mergeCodexBlock(existing, block);

    // F01: back up an existing AGENTS.md (never overwrite a prior backup).
    if (existing != null) {
      const agentsBak = dest + '.bak';
      if (!fs.existsSync(agentsBak)) fs.writeFileSync(agentsBak, existing, 'utf8');
    }

    // commit: swap tree, then write AGENTS.md. F03: keep the tree backup until BOTH succeed,
    // so a failure writing AGENTS.md rolls the tree back too.
    if (fs.existsSync(treeDst)) {
      backup = scratchName(treeDst, 'old');
      fs.rmSync(backup, { recursive: true, force: true });
      fs.renameSync(treeDst, backup);
    }
    try {
      fs.renameSync(stage, treeDst);
      fs.writeFileSync(dest, agentsOut, 'utf8'); // if THIS throws, catch restores the tree
    } catch (e) {
      fs.rmSync(treeDst, { recursive: true, force: true });
      if (backup && fs.existsSync(backup)) fs.renameSync(backup, treeDst); // rollback tree
      backup = null;
      throw e;
    }
    if (backup) { fs.rmSync(backup, { recursive: true, force: true }); backup = null; }
    return { where: skillsDst, skipped };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
  }
}

// ---------- inventory checks ----------
function assertInventory(baseDir, skills) {
  return skills.filter((s) => !fs.existsSync(path.join(baseDir, s.name, 'SKILL.md'))).map((s) => s.name);
}
function assertCodexInventory(skillsRoot, skills) {
  return skills.filter((s) => !fs.existsSync(path.join(skillsRoot, s.group, s.file))).map((s) => `${s.group}/${s.file}`);
}

// ---------- CLI ----------

function ask(rl, q) { return new Promise((res) => rl.question(q, (a) => res(a.trim()))); }

async function main() {
  const args = process.argv.slice(2);
  const has = (k) => args.includes(k);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] || true) : undefined; };

  if (has('--help') || has('-h')) {
    console.log(`fintech-compliance-skills

Usage: npx fintech-compliance-skills [--tool TOOL] [--target DIR] [--scope SCOPE] [--home DIR] [--force]

  --tool    claude | kiro | kiro-crew | codex   (prompted if omitted)
  --scope   claude: project (default) | user
            kiro:   global (default, ~/.kiro/skills) | workspace (.kiro/skills in --target)
  --target  project dir for project/workspace/codex installs (default: current dir)
  --home    override home dir (for testing; default: OS home)
  --force   overwrite SKILL.md / managed files even if edited since install
  --help    show this help

Targets:
  claude      <target>/.claude/skills/            (or ~/.claude/skills with --scope user)
  kiro        ~/.kiro/skills/  (global)            (or <target>/.kiro/skills with --scope workspace)
  kiro-crew   ~/.kiro/crew/skills/
  codex       <target>/AGENTS.md + <target>/.fintech-compliance-skills/`);
    return;
  }

  let tool = flag('--tool');
  let target = flag('--target');
  let scope = flag('--scope');
  const home = flag('--home') ? String(flag('--home')) : os.homedir();
  const force = has('--force');
  const skills = listSkillFiles();

  const KNOWN = ['claude', 'kiro', 'kiro-crew', 'codex'];
  if (tool && !KNOWN.includes(String(tool))) {
    console.error(`Unknown --tool "${tool}". Supported: ${KNOWN.join(', ')}.`);
    process.exit(2);
  }
  if (scope && !['project', 'user', 'workspace', 'global'].includes(String(scope))) {
    console.error(`Unknown --scope "${scope}". Use project|user (claude) or global|workspace (kiro).`);
    process.exit(2);
  }

  if (!tool) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\nfintech-compliance-skills — install compliance rules into your AI coding agent.\n');
    console.log('  1) Claude Code   (project .claude/skills/)');
    console.log('  2) Kiro CLI/IDE  (~/.kiro/skills/)');
    console.log('  3) Kiro Crew     (~/.kiro/crew/skills/)');
    console.log('  4) Codex CLI     (project AGENTS.md + rule files)\n');
    const choice = await ask(rl, 'Which tool? [1/2/3/4]: ');
    tool = { '1': 'claude', '2': 'kiro', '3': 'kiro-crew', '4': 'codex' }[choice] || 'claude';
    if (tool === 'claude' || tool === 'codex') {
      const t = await ask(rl, `Target project directory [${process.cwd()}]: `);
      target = t || process.cwd();
    }
    rl.close();
  }

  target = target ? expandHome(String(target), home) : process.cwd();
  scope = scope ? String(scope) : undefined;

  if (tool === 'codex') {
    const { where, skipped } = installCodex(target, skills, { force });
    const missing = assertCodexInventory(where, skills);
    console.log(`\n✅ codex: AGENTS.md updated and ${skills.length} rule files installed -> ${where}`);
    if (skipped.length) console.log(`⚠️  preserved ${skipped.length} edited managed file(s) (use --force): ${skipped.join(', ')}`);
    if (missing.length) { console.error(`✗ inventory check failed, missing: ${missing.join(', ')}`); process.exit(1); }
    console.log('   Codex reads AGENTS.md automatically at session start.');
  } else {
    const base = resolveBase(tool, scope, target, home);
    mkdirp(base);
    const r = installSkillDir(base, skills, { force });
    const missing = assertInventory(base, skills);
    console.log(`\n✅ ${tool}: ${r.installed} new, ${r.migrated.length} migrated, ${r.unchanged} unchanged -> ${base}`);
    if (r.migrated.length) console.log(`↗  migrated from previous installer: ${r.migrated.join(', ')} (backups: *.bak)`);
    if (r.skipped.length) console.log(`⚠️  skipped ${r.skipped.length} user-edited file(s) (use --force): ${r.skipped.join(', ')}`);
    if (missing.length) { console.error(`✗ inventory check failed, missing: ${missing.join(', ')}`); process.exit(1); }
    console.log(tool === 'claude' ? '   Restart Claude Code (or /reload) to pick up the skills.'
      : '   Kiro loads skills on the next session.');
  }
  console.log('');
}

if (require.main === module) {
  main().catch((e) => { console.error('Install failed:', e.message); process.exit(1); });
}

module.exports = {
  resolveBase, classify, isLegacyOutput, managedContent, mergeCodexBlock, rewriteRelativeLinks,
  listSkillFiles, installCodex, installSkillDir, LEGACY_FILE_HASHES,
  BLOCK_START, BLOCK_END, LEGACY_CODEX_MARKER, LEGACY_CODEX_HEADING, CODEX_ROOT, CODEX_MANIFEST,
};
