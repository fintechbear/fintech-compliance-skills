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
 *     (cross-links rewritten for the flat layout; Codex gets the tree copied).
 *   - YAML frontmatter is emitted as safe double-quoted scalars (always parses).
 *   - Re-running is idempotent (content hash; Codex uses a marker-delimited block + manifest).
 *   - A file edited by the user is preserved (skipped) unless --force.
 *   - Files written by the PREVIOUS installer (no hash stamp) are recognised by
 *     deterministically reproducing the old output and matched byte-for-byte, then
 *     migrated to the new format with a .bak backup. A file we cannot prove is old
 *     output is treated as a user edit and never overwritten.
 *   - Writes are staged in a temp dir and moved into place; a failed write leaves
 *     the previous working install intact.
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
function rewriteRelativeLinks(body) {
  return body
    .replace(/\]\(\.\.\/[a-z0-9-]+\/([a-z0-9-]+)\.md\)/gi, (_m, f) => `](../${f}/SKILL.md)`)
    .replace(/\]\(\.\/([a-z0-9-]+)\.md\)/gi, (_m, f) => `](../${f}/SKILL.md)`);
}

// The managed (new-format) body for a skill, without the trailing hash stamp.
function managedContent(skill) {
  const { desc, body } = parseSkill(skill.abs);
  return frontmatter(skill.name, desc, triggersFor(skill)) + rewriteRelativeLinks(body);
}

// ---------- LEGACY output reproduction (for migration) ----------
// The previous installer wrote: oldFrontmatter(name, desc, oldTriggers) + rawBody
// with NO link rewrite and NO hash stamp. Reproduce it exactly so we can recognise
// an unedited old file byte-for-byte.

function legacyTriggersFor(skill) {
  const base = skill.name.replace(/-/g, ', ');
  const extra = {
    languages: 'write code, implement, coding',
    databases: 'schema, migration, query, store data',
    global: 'compliance, audit, standard',
    regional: 'regulation, jurisdiction, country',
    core: 'fintech, payment, money, always',
    refusal: 'refuse, red line, forbidden, always',
  }[skill.group] || '';
  return [base, extra].filter(Boolean).join(', ');
}

function legacyFrontmatter(name, description, triggers) {
  const d = description.length > 300 ? description.slice(0, 297) + '...' : description;
  return `---\nname: ${name}\ndescription: ${d}\ntriggers: ${triggers}\n---\n\n`;
}

// Returns the set of exact byte strings the old installer could have produced for
// this skill. (Both prior versions used identical generation logic.)
function legacyOutputs(skill) {
  const { desc, body } = parseSkill(skill.abs);
  const fm = legacyFrontmatter(skill.name, desc, legacyTriggersFor(skill));
  return [fm + body];
}

// ---------- fs helpers ----------

function expandHome(p, home) {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(1));
  return p;
}
function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }
function sha(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16); }
function readIf(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }

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
  // No stamp: could be previous-installer output (migratable) or a hand-written file.
  return legacyOutputs(skill).includes(prev) ? 'legacy' : 'user';
}

function installSkillDir(baseDir, skills, { force }) {
  const res = { installed: 0, migrated: [], skipped: [], unchanged: 0, backups: [] };
  // Stage everything first, then commit, so a mid-run failure leaves the old install intact.
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
      fs.copyFileSync(st.dest, bak);
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

function copyTree(src, dst, manifest, rel = '') {
  mkdirp(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) copyTree(s, d, manifest, r);
    else { const data = fs.readFileSync(s); fs.writeFileSync(d, data); manifest[r] = sha(data.toString('utf8')); }
  }
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
// skills/... references do not linger. Preserves user text outside those blocks.
function mergeCodexBlock(existing, block) {
  let out = existing;
  const managedRe = new RegExp(`${escapeRe(BLOCK_START)}[\\s\\S]*?${escapeRe(BLOCK_END)}`, 'g');
  if (managedRe.test(out)) {
    // Remove ALL managed blocks (including duplicates), then append exactly one fresh block.
    out = out.replace(managedRe, '').replace(/\s*$/, '') + `\n\n${block}\n`;
  } else if (out.includes(LEGACY_CODEX_MARKER)) {
    // Old format: "<user text>\n\n<!-- marker -->\n# AGENTS.md — Fintech Compliance Rules ... (to EOF or next marker)"
    // Remove every legacy section (marker + the generated heading block that follows), keep preceding user text.
    const legacyRe = new RegExp(`\\n*${escapeRe(LEGACY_CODEX_MARKER)}\\n# AGENTS\\.md — Fintech Compliance Rules[\\s\\S]*?(?=(\\n${escapeRe(LEGACY_CODEX_MARKER)}\\n)|$)`, 'g');
    out = out.replace(legacyRe, '');
    out = out.replace(/\s*$/, '') + `\n\n${block}\n`;
  } else {
    out = out.replace(/\s*$/, '') + `\n\n${block}\n`;
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function installCodex(targetDir, skills, { force }) {
  mkdirp(targetDir);
  const treeDst = path.join(targetDir, CODEX_ROOT);
  const manifestPath = path.join(treeDst, CODEX_MANIFEST);
  const prevManifest = (() => { try { return JSON.parse(readIf(manifestPath) || '{}'); } catch { return {}; } })();

  // Stage the new tree in a temp dir; validate; then swap. Preserve unknown user files.
  const stage = path.join(targetDir, `.fcs-stage-${process.pid}`);
  fs.rmSync(stage, { recursive: true, force: true });
  const manifest = {};
  try {
    copyTree(SKILLS_DIR, path.join(stage, 'skills'), manifest);
    const skipped = [];
    if (fs.existsSync(treeDst)) {
      // Carry over unknown user files; refuse to clobber a managed file the user edited.
      const walk = (dir, rel = '') => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.name === CODEX_MANIFEST) continue;
          if (e.isDirectory()) { walk(abs, r); continue; }
          const relKey = r.startsWith('skills/') ? r : r; // manifest keys are tree-relative
          const wasManaged = Object.prototype.hasOwnProperty.call(prevManifest, relKey);
          const cur = sha(fs.readFileSync(abs, 'utf8'));
          if (!wasManaged) {
            // unknown user file -> preserve
            const d = path.join(stage, r); mkdirp(path.dirname(d)); fs.copyFileSync(abs, d);
          } else if (!force && cur !== prevManifest[relKey] && manifest[relKey] !== cur) {
            // managed file the user edited -> preserve + skip replacing
            const d = path.join(stage, r); mkdirp(path.dirname(d)); fs.copyFileSync(abs, d);
            skipped.push(r);
          }
        }
      };
      walk(treeDst);
    }
    fs.writeFileSync(path.join(stage, CODEX_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');

    // AGENTS.md merge (compute before swapping the tree so a failure here leaves tree untouched).
    const block = buildCodexBlock(skills, CODEX_ROOT);
    const dest = path.join(targetDir, 'AGENTS.md');
    const existing = readIf(dest);
    const agentsOut = existing == null ? block + '\n' : mergeCodexBlock(existing, block);

    // commit: swap tree, then write AGENTS.md
    const backup = treeDst + '.old';
    if (fs.existsSync(treeDst)) { fs.rmSync(backup, { recursive: true, force: true }); fs.renameSync(treeDst, backup); }
    try {
      fs.renameSync(stage, treeDst);
    } catch (e) {
      if (fs.existsSync(backup)) fs.renameSync(backup, treeDst); // rollback
      throw e;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    fs.writeFileSync(dest, agentsOut, 'utf8');
    return { where: treeDst, skipped };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// ---------- inventory check ----------
function assertInventory(baseDir, skills) {
  const missing = skills.filter((s) => !fs.existsSync(path.join(baseDir, s.name, 'SKILL.md')));
  return missing.map((s) => s.name);
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
    const missing = assertInventory(path.join(where, 'skills'), skills.map((s) => ({ name: path.join(s.group, s.name) })));
    console.log(`\n✅ codex: AGENTS.md updated and ${skills.length} rule files installed -> ${where}`);
    if (skipped.length) console.log(`⚠️  preserved ${skipped.length} edited managed file(s) (use --force): ${skipped.join(', ')}`);
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

module.exports = { resolveBase, classify, legacyOutputs, managedContent, mergeCodexBlock, rewriteRelativeLinks, listSkillFiles, BLOCK_START, BLOCK_END, LEGACY_CODEX_MARKER };
