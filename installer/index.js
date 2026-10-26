#!/usr/bin/env node
/*
 * fintech-compliance-skills installer
 *
 * Installs the repo's compliance skills into the agent tool of your choice:
 *   - Claude Code  -> <target>/.claude/skills/<name>/SKILL.md   (+ YAML frontmatter)
 *   - Kiro         -> ~/.kiro/crew/skills/<name>/SKILL.md        (+ YAML frontmatter)
 *   - Codex CLI    -> <target>/AGENTS.md                         (single instruction file)
 *
 * Zero runtime dependencies — only Node.js built-ins, so `npx` just works.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const REPO_ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

// ---------- helpers ----------

function listSkillFiles() {
  const out = [];
  for (const group of fs.readdirSync(SKILLS_DIR)) {
    const groupPath = path.join(SKILLS_DIR, group);
    if (!fs.statSync(groupPath).isDirectory()) continue; // skip INDEX.md
    for (const file of fs.readdirSync(groupPath)) {
      if (!file.endsWith('.md')) continue;
      out.push({
        group,                              // core | refusal | global | regional | languages | databases
        file,                               // java.md
        name: file.replace(/\.md$/, ''),    // java
        abs: path.join(groupPath, file),
      });
    }
  }
  return out;
}

// Derive name + description from the first "# Skill: X" line and the bold one-liner under it.
function parseSkill(abs) {
  const text = fs.readFileSync(abs, 'utf8');
  const titleMatch = text.match(/^#\s+(?:Skill:\s*)?(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : path.basename(abs, '.md');
  // first bold **...** sentence after the title = the purpose line
  const descMatch = text.match(/\*\*(.+?)\*\*/);
  const desc = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : title;
  return { title, desc, body: text };
}

// Triggers from the skill name + group so the agent auto-loads it when relevant.
function triggersFor(skill, title) {
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

function yamlFrontmatter(name, description, triggers) {
  // keep description single-line and under ~300 chars
  const d = description.length > 300 ? description.slice(0, 297) + '...' : description;
  return `---\nname: ${name}\ndescription: ${d}\ntriggers: ${triggers}\n---\n\n`;
}

function expandHome(p) {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------- installers ----------

// Claude Code & Kiro share the SKILL.md + frontmatter format.
function installSkillDir(baseDir, skills) {
  let count = 0;
  for (const s of skills) {
    const { title, desc, body } = parseSkill(s.abs);
    const triggers = triggersFor(s, title);
    const dir = path.join(baseDir, s.name);
    mkdirp(dir);
    const front = yamlFrontmatter(s.name, desc, triggers);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), front + body, 'utf8');
    count++;
  }
  return count;
}

// Codex uses a single AGENTS.md. We write a compact router that points at the
// full skill files (kept in the repo) so AGENTS.md stays small but authoritative.
function installCodex(targetDir, skills) {
  const byGroup = {};
  for (const s of skills) {
    (byGroup[s.group] = byGroup[s.group] || []).push(s);
  }
  let md = `# AGENTS.md — Fintech Compliance Rules\n\n`;
  md += `You write code for regulated financial systems. Before writing or changing any\n`;
  md += `code that touches money, payments, accounts, balances, or personal/financial\n`;
  md += `data, load and obey the relevant rule files below. **Always** obey\n`;
  md += `\`skills/core/secure-fintech-coding.md\` and \`skills/refusal/refusal-policy.md\`.\n`;
  md += `If a request would break a red line, refuse and explain which rule — do not\n`;
  md += `write the non-compliant code.\n\n`;
  md += `## Always load\n\n`;
  md += `- \`skills/core/secure-fintech-coding.md\` — baseline for all financial code\n`;
  md += `- \`skills/refusal/refusal-policy.md\` — hard limits / when to say no\n\n`;
  const order = ['global', 'regional', 'languages', 'databases'];
  const titleFor = { global: 'Load for the framework in scope', regional: 'Load for the user\'s jurisdiction', languages: 'Load the one you are coding in', databases: 'Load the one you store in' };
  for (const g of order) {
    if (!byGroup[g]) continue;
    md += `## ${g.charAt(0).toUpperCase() + g.slice(1)} — ${titleFor[g] || ''}\n\n`;
    for (const s of byGroup[g]) {
      const { desc } = parseSkill(s.abs);
      md += `- \`skills/${g}/${s.file}\` — ${desc}\n`;
    }
    md += `\n`;
  }
  md += `> These rule files live in this repo under \`skills/\`. Open the one that\n`;
  md += `> matches your task and follow its Do / Never / examples before coding.\n`;
  const dest = path.join(targetDir, 'AGENTS.md');
  if (fs.existsSync(dest)) {
    const marker = '\n\n<!-- fintech-compliance-skills -->\n';
    fs.appendFileSync(dest, marker + md, 'utf8');
  } else {
    fs.writeFileSync(dest, md, 'utf8');
  }
  return 1;
}

// ---------- CLI ----------

function ask(rl, q) {
  return new Promise((res) => rl.question(q, (a) => res(a.trim())));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? (args[i + 1] || true) : undefined;
  };

  let tool = flag('--tool');      // claude | kiro | codex
  let target = flag('--target');  // dir for claude/codex (default cwd)

  const skills = listSkillFiles();

  if (!tool) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\nfintech-compliance-skills — install compliance rules into your AI coding agent.\n');
    console.log('  1) Claude Code   (project .claude/skills/)');
    console.log('  2) Kiro          (~/.kiro/crew/skills/)');
    console.log('  3) Codex CLI     (project AGENTS.md)\n');
    const choice = await ask(rl, 'Which tool? [1/2/3]: ');
    tool = { '1': 'claude', '2': 'kiro', '3': 'codex' }[choice] || 'claude';
    if (tool !== 'kiro') {
      const t = await ask(rl, `Target project directory [${process.cwd()}]: `);
      target = t || process.cwd();
    }
    rl.close();
  }

  target = target ? expandHome(String(target)) : process.cwd();

  let installed = 0;
  let where = '';

  if (tool === 'claude') {
    const base = path.join(target, '.claude', 'skills');
    mkdirp(base);
    installed = installSkillDir(base, skills);
    where = base;
  } else if (tool === 'kiro') {
    const base = path.join(os.homedir(), '.kiro', 'crew', 'skills');
    mkdirp(base);
    installed = installSkillDir(base, skills);
    where = base;
  } else if (tool === 'codex') {
    installed = installCodex(target, skills);
    where = path.join(target, 'AGENTS.md');
  } else {
    console.error(`Unknown tool: ${tool}. Use claude | kiro | codex.`);
    process.exit(1);
  }

  console.log(`\n✅ Installed for ${tool}: ${tool === 'codex' ? 'AGENTS.md written' : installed + ' skills'} -> ${where}`);
  if (tool === 'claude') console.log('   Restart Claude Code (or /reload) so it picks up the new skills.');
  if (tool === 'kiro') console.log('   Kiro loads skills on the next session.');
  if (tool === 'codex') console.log('   Codex reads AGENTS.md automatically at session start.');
  console.log('');
}

main().catch((e) => {
  console.error('Install failed:', e.message);
  process.exit(1);
});
