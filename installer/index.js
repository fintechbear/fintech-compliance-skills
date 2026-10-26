#!/usr/bin/env node
/*
 * fintech-compliance-skills installer
 *
 * Installs the repo's compliance skills into the agent tool of your choice:
 *   - Claude Code  -> <target>/.claude/skills/<name>/SKILL.md
 *   - Kiro         -> ~/.kiro/crew/skills/<name>/SKILL.md
 *   - Codex CLI    -> <target>/.fintech-compliance-skills/  (+ a managed block in AGENTS.md)
 *
 * Design guarantees (see the repo's analysis / roadmap):
 *   - Every rule file an installed skill references actually exists at the
 *     installed location (relative links are rewritten for the flat layout;
 *     Codex gets the whole tree copied so `skills/...` paths resolve).
 *   - YAML frontmatter is emitted with a safe (double-quoted, escaped) scalar,
 *     so every generated SKILL.md parses.
 *   - Re-running is idempotent: the Codex AGENTS.md block is delimited by
 *     markers and replaced in place, never appended twice.
 *   - A SKILL.md the user has edited since we wrote it is NOT overwritten
 *     unless --force is passed; the conflict is reported.
 *
 * Zero runtime dependencies — only Node.js built-ins, so `npx` just works.
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
const STAMP = '<!-- fcs-managed-hash:'; // written as an HTML comment at the end of each generated SKILL.md

// ---------- discovery ----------

function listSkillFiles() {
  const out = [];
  for (const group of fs.readdirSync(SKILLS_DIR)) {
    const groupPath = path.join(SKILLS_DIR, group);
    if (!fs.statSync(groupPath).isDirectory()) continue; // skip INDEX.md
    for (const file of fs.readdirSync(groupPath)) {
      if (!file.endsWith('.md')) continue;
      out.push({
        group,                            // core | refusal | global | regional | languages | databases
        file,                             // java.md
        name: file.replace(/\.md$/, ''),  // java
        abs: path.join(groupPath, file),
      });
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

// JSON double-quoted strings are valid YAML double-quoted scalars, so a colon,
// quote, or backslash inside the description can no longer break the parse.
function yamlScalar(s) {
  return JSON.stringify(String(s));
}

function frontmatter(name, description, triggers) {
  const d = description.length > 300 ? description.slice(0, 297) + '…' : description;
  return [
    '---',
    `name: ${yamlScalar(name)}`,
    `description: ${yamlScalar(d)}`,
    `triggers: ${yamlScalar(triggers)}`,
    '---',
    '',
    '',
  ].join('\n');
}

// In the flat <name>/SKILL.md layout, a sibling skill X lives at ../X/SKILL.md.
// Rewrite the repo's ../group/file.md links to that shape so they resolve.
function rewriteRelativeLinks(body) {
  return body.replace(
    /\]\(\.\.\/[a-z0-9-]+\/([a-z0-9-]+)\.md\)/gi,
    (_m, fileBase) => `](../${fileBase}/SKILL.md)`
  );
}

// ---------- fs helpers ----------

function expandHome(p) {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}
function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }
function sha(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16); }

// ---------- SKILL.md installer (Claude + Kiro) ----------

// Returns { installed, skipped: [names] }.
function installSkillDir(baseDir, skills, force) {
  let installed = 0;
  const skipped = [];
  for (const s of skills) {
    const { desc, body } = parseSkill(s.abs);
    const front = frontmatter(s.name, desc, triggersFor(s));
    const content = front + rewriteRelativeLinks(body);
    const managed = content + `\n\n${STAMP}${sha(content)} -->\n`;
    const dir = path.join(baseDir, s.name);
    const dest = path.join(dir, 'SKILL.md');

    if (fs.existsSync(dest) && !force) {
      const prev = fs.readFileSync(dest, 'utf8');
      const m = prev.match(/\n\n<!-- fcs-managed-hash:([0-9a-f]+) -->\n?$/);
      // Strip exactly the separator + stamp we appended, leaving content untouched.
      const prevBody = prev.replace(/\n\n<!-- fcs-managed-hash:[0-9a-f]+ -->\n?$/, '');
      // If it has our stamp and the stamp still matches its body, it is unchanged by the user.
      const userEdited = !m || sha(prevBody) !== m[1];
      if (userEdited) {
        skipped.push(s.name);
        continue;
      }
      if (prevBody === content) { installed++; continue; } // already current, no-op
    }
    mkdirp(dir);
    fs.writeFileSync(dest, managed, 'utf8');
    installed++;
  }
  return { installed, skipped };
}

// ---------- Codex installer ----------

// Copy the whole skills/ tree so every `skills/<group>/<file>.md` path in the
// AGENTS.md block resolves, then write/replace a single managed block.
function copyTree(src, dst) {
  mkdirp(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function buildCodexBlock(skills, relRoot) {
  const byGroup = {};
  for (const s of skills) (byGroup[s.group] = byGroup[s.group] || []).push(s);
  const p = (g, f) => `${relRoot}/skills/${g}/${f}`;
  let md = `${BLOCK_START}\n`;
  md += `# Fintech Compliance Rules\n\n`;
  md += `You write code for regulated financial systems. Before writing or changing\n`;
  md += `any code that touches money, payments, accounts, balances, or personal /\n`;
  md += `financial data, load and obey the relevant rule files below. **Always** obey\n`;
  md += `\`${p('core', 'secure-fintech-coding.md')}\` and \`${p('refusal', 'refusal-policy.md')}\`.\n`;
  md += `If a request would break a red line, refuse and name the rule — do not write\n`;
  md += `the non-compliant code.\n\n`;
  md += `## Always load\n\n`;
  md += `- \`${p('core', 'secure-fintech-coding.md')}\` — baseline for all financial code\n`;
  md += `- \`${p('refusal', 'refusal-policy.md')}\` — hard limits / when to say no\n\n`;
  const order = ['global', 'regional', 'languages', 'databases'];
  const titleFor = {
    global: 'Load for the framework in scope',
    regional: "Load for the user's jurisdiction",
    languages: 'Load the one you are coding in',
    databases: 'Load the one you store in',
  };
  for (const g of order) {
    if (!byGroup[g]) continue;
    md += `## ${g[0].toUpperCase() + g.slice(1)} — ${titleFor[g]}\n\n`;
    for (const s of byGroup[g]) {
      const { desc } = parseSkill(s.abs);
      md += `- \`${p(g, s.file)}\` — ${desc}\n`;
    }
    md += `\n`;
  }
  md += `> These rule files were installed next to this AGENTS.md under \`${relRoot}/\`.\n`;
  md += `> Open the one that matches your task and follow its Do / Never / examples.\n`;
  md += BLOCK_END;
  return md;
}

function installCodex(targetDir, skills) {
  mkdirp(targetDir);
  const rootName = '.fintech-compliance-skills';
  const treeDst = path.join(targetDir, rootName);
  // refresh the copied tree
  fs.rmSync(treeDst, { recursive: true, force: true });
  copyTree(SKILLS_DIR, path.join(treeDst, 'skills'));

  const block = buildCodexBlock(skills, rootName);
  const dest = path.join(targetDir, 'AGENTS.md');

  if (fs.existsSync(dest)) {
    let existing = fs.readFileSync(dest, 'utf8');
    const re = new RegExp(`${escapeRe(BLOCK_START)}[\\s\\S]*?${escapeRe(BLOCK_END)}`);
    if (re.test(existing)) {
      existing = existing.replace(re, block);                 // replace managed block in place
    } else {
      existing = existing.replace(/\s*$/, '') + `\n\n${block}\n`; // append once
    }
    fs.writeFileSync(dest, existing, 'utf8');
  } else {
    fs.writeFileSync(dest, block + '\n', 'utf8');
  }
  return treeDst;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- CLI ----------

function ask(rl, q) { return new Promise((res) => rl.question(q, (a) => res(a.trim()))); }

async function main() {
  const args = process.argv.slice(2);
  const has = (k) => args.includes(k);
  const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] || true) : undefined; };

  if (has('--help') || has('-h')) {
    console.log(`fintech-compliance-skills

Usage: npx fintech-compliance-skills [--tool claude|kiro|codex] [--target <dir>] [--force]

  --tool     claude | kiro | codex   (prompted if omitted)
  --target   project dir for claude/codex (default: current dir; kiro ignores it)
  --force    overwrite SKILL.md files even if edited since install
  --help     show this help`);
    return;
  }

  let tool = flag('--tool');
  let target = flag('--target');
  const force = has('--force');
  const skills = listSkillFiles();

  if (!tool) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\nfintech-compliance-skills — install compliance rules into your AI coding agent.\n');
    console.log('  1) Claude Code   (project .claude/skills/)');
    console.log('  2) Kiro          (~/.kiro/crew/skills/)');
    console.log('  3) Codex CLI     (project AGENTS.md + rule files)\n');
    const choice = await ask(rl, 'Which tool? [1/2/3]: ');
    tool = { '1': 'claude', '2': 'kiro', '3': 'codex' }[choice] || 'claude';
    if (tool !== 'kiro') {
      const t = await ask(rl, `Target project directory [${process.cwd()}]: `);
      target = t || process.cwd();
    }
    rl.close();
  }

  target = target ? expandHome(String(target)) : process.cwd();

  if (tool === 'claude' || tool === 'kiro') {
    const base = tool === 'claude'
      ? path.join(target, '.claude', 'skills')
      : path.join(os.homedir(), '.kiro', 'crew', 'skills');
    mkdirp(base);
    const { installed, skipped } = installSkillDir(base, skills, force);
    console.log(`\n✅ ${tool}: installed ${installed} skill(s) -> ${base}`);
    if (skipped.length) {
      console.log(`⚠️  skipped ${skipped.length} edited file(s) (use --force to overwrite): ${skipped.join(', ')}`);
    }
    console.log(tool === 'claude'
      ? '   Restart Claude Code (or /reload) to pick up the skills.'
      : '   Kiro loads skills on the next session.');
  } else if (tool === 'codex') {
    const where = installCodex(target, skills);
    console.log(`\n✅ codex: AGENTS.md updated and rule files installed -> ${where}`);
    console.log('   Codex reads AGENTS.md automatically at session start.');
  } else {
    console.error(`Unknown tool: ${tool}. Use claude | kiro | codex.`);
    process.exit(1);
  }
  console.log('');
}

main().catch((e) => { console.error('Install failed:', e.message); process.exit(1); });
