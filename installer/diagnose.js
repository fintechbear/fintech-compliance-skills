#!/usr/bin/env node
/*
 * fintech-compliance-skills — install self-check (diagnostics)
 *
 *   node installer/diagnose.js [--home <dir>] [--target <dir>] [--json]
 *
 * A developer runs this to self-check an install. It answers four questions:
 *   1. Which install targets (claude / kiro / kiro-crew / codex) are present under --home/--target?
 *   2. For each present target, is every managed skill CURRENT, or has it drifted
 *      (our stamp but a newer source = 'stale'), been user-edited, or is it a legacy format?
 *   3. Does every FCS-id a skill cites resolve to a control in controls/catalog.json?
 *   4. Has any legacy NUMBERED refusal-rule citation crept back in (should be 0)?
 *
 * HONESTY — this is a STATIC self-check of files on disk, NOT a runtime compliance audit
 * and NOT a scanner: it cannot tell you your code is compliant, only whether the installed
 * skill files are intact, current, and internally consistent. Questions 3 and 4 are about
 * the SOURCE repo; questions 1 and 2 are about an INSTALL.
 *
 * Zero runtime dependencies — Node built-ins only. Reuses installer/index.js discovery so it
 * never drifts from the installer's own notion of "current".
 *
 * Exit code: non-zero if a SOURCE defect is found (unresolved FCS id or a legacy citation),
 * or if a PRESENT install has a stale (drifted) managed file. A target simply not being
 * installed is reported, not an error.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const idx = require('./index.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(REPO_ROOT, 'controls', 'catalog.json');

function argv(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const HOME = argv('--home', os.homedir());
const TARGET = argv('--target', HOME);
const JSON_OUT = process.argv.includes('--json');

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

// ---- SOURCE check 1: FCS-id references in skills all resolve to the catalog ----
function sourceControlRefs() {
  const catalog = JSON.parse(read(CATALOG));
  const known = new Set(catalog.controls.map((c) => c.id));
  const skills = idx.listSkillFiles();
  const unresolved = []; // { skill, id }
  const legacyCitations = []; // { skill, text }
  // A legacy numbered refusal-rule citation: "rule(s) N" near the word refusal/policy.
  const LEGACY_RE = /\brules?\s+\d+(\s*[,&/]\s*\d+)*/gi;
  for (const s of skills) {
    const text = fs.readFileSync(s.abs, 'utf8');
    for (const m of text.matchAll(/\bFCS-[A-Z]+-\d{3}\b/g)) {
      if (!known.has(m[0])) unresolved.push({ skill: `${s.group}/${s.file}`, id: m[0] });
    }
    // refusal-policy.md intentionally keeps ONE worked example of an old numbered citation
    // (to explain why FCS ids replaced them); exclude it, exactly as validate-controls.js does.
    if (s.group === 'refusal' && s.file === 'refusal-policy.md') continue;
    for (const m of text.matchAll(LEGACY_RE)) {
      // Only flag when it reads as a refusal-rule citation, not an unrelated "rules 1".
      const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 10).toLowerCase();
      if (/refus|red line|red-line|policy rule/.test(around)) legacyCitations.push({ skill: `${s.group}/${s.file}`, text: m[0] });
    }
  }
  return { controls: known.size, skills: skills.length, unresolved, legacyCitations };
}

// ---- INSTALL check: which targets are present, and per-skill status ----
// Reuses installer classify(): 'absent' | 'current' | 'ours-stale' | 'user' | 'legacy'.
// R07: enumerate the SAME tool/scope matrix the installer supports — not just user scope —
// so a default project-scoped Claude install is discovered, not silently missed.
const SKILL_TARGETS = [
  { tool: 'claude', scope: 'project', label: 'claude (project)' },
  { tool: 'claude', scope: 'user', label: 'claude (user)' },
  { tool: 'kiro', scope: 'user', label: 'kiro (home)' },
  { tool: 'kiro', scope: 'workspace', label: 'kiro (workspace)' },
  { tool: 'kiro-crew', scope: 'user', label: 'kiro-crew' },
];

function installStatus() {
  const skills = idx.listSkillFiles();
  const out = [];
  for (const t of SKILL_TARGETS) {
    const base = idx.resolveBase(t.tool, t.scope, TARGET, HOME);
    if (!base || !fs.existsSync(base)) { out.push({ ...t, base, present: false }); continue; }
    const tally = { current: 0, 'ours-stale': 0, user: 0, legacy: 0, absent: 0 };
    const details = [];
    for (const s of skills) {
      const dest = path.join(base, s.name, 'SKILL.md');
      const state = idx.classify(dest, s);
      tally[state] = (tally[state] || 0) + 1;
      if (state === 'ours-stale' || state === 'legacy') details.push({ skill: s.name, state });
    }
    const installedCount = skills.length - tally.absent;
    // A base DIRECTORY that exists but holds NONE of our skills is NOT an install — report
    // it as not-present rather than a hollow "present with 0 current" (which read as OK before).
    if (installedCount === 0) { out.push({ ...t, base, present: false }); continue; }
    // A partial install (some of our skills present, some absent) is a BROKEN install, not a
    // clean one: the tree was deleted/truncated under us. Surface it and fail.
    const partial = tally.absent > 0;
    out.push({ ...t, base, present: true, installed: installedCount, tally, details, partial });
  }
  out.push(codexStatus());
  return out;
}

// R07: Codex is a tree + manifest, not a single file. A managed block in AGENTS.md with a
// deleted/truncated/corrupt skill tree is a BROKEN install, not "present/OK". Verify the
// tree against the installer's own manifest v2 contract: every `managed` relKey must exist
// on disk with the recorded hash; `userEdited` entries are PRESERVED (reported, never
// "repaired"); extra/unknown files are user files and left alone.
function codexStatus() {
  const agentsPath = path.join(TARGET, 'AGENTS.md');
  const agents = read(agentsPath);
  const blockPresent = agents != null && agents.includes(idx.BLOCK_START);
  const treeRoot = path.join(TARGET, idx.CODEX_ROOT);
  const manifestPath = path.join(treeRoot, idx.CODEX_MANIFEST);
  const sha = (s) => require('crypto').createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

  if (!blockPresent && !fs.existsSync(treeRoot)) {
    return { tool: 'codex', label: 'codex', base: agentsPath, present: false, note: 'not installed' };
  }
  // From here a managed block OR a tree exists, so SOMETHING claims to be installed.
  const issues = [];      // broken-install problems (cause exit != 0)
  const userEditedList = []; // preserved edits (reported, not errors)
  let managedOk = 0, managedTotal = 0;

  if (blockPresent && !fs.existsSync(treeRoot)) {
    issues.push('AGENTS.md has the managed block but the skill tree is MISSING (deleted)');
  }
  if (!blockPresent && fs.existsSync(treeRoot)) {
    issues.push('skill tree exists but AGENTS.md has no managed block (half-removed)');
  }
  let manifest = null;
  if (fs.existsSync(treeRoot)) {
    const rawM = read(manifestPath);
    if (rawM == null) {
      issues.push(`manifest ${idx.CODEX_MANIFEST} missing — cannot verify tree integrity`);
    } else {
      try { manifest = JSON.parse(rawM); } catch { issues.push('manifest is not valid JSON (corrupt)'); }
    }
  }
  if (manifest && manifest.managed && typeof manifest.managed === 'object') {
    for (const [relKey, wantHash] of Object.entries(manifest.managed)) {
      managedTotal++;
      const abs = path.join(treeRoot, relKey);
      const cur = read(abs);
      if (cur == null) { issues.push(`managed file deleted: ${relKey}`); continue; }
      const got = sha(cur);
      if (got !== wantHash) {
        // Our managed baseline hash no longer matches. If the manifest also recorded it as a
        // user edit, that is a PRESERVED edit; otherwise it is corruption/tampering.
        const ue = manifest.userEdited && manifest.userEdited[relKey];
        if (ue && ue === got) userEditedList.push(relKey);
        else issues.push(`managed file content changed (stale/corrupt): ${relKey}`);
      } else managedOk++;
    }
    // userEdited entries the manifest declares but that still exist are preserved edits.
    for (const [relKey, h] of Object.entries(manifest.userEdited || {})) {
      const cur = read(path.join(treeRoot, relKey));
      if (cur != null && sha(cur) === h && !userEditedList.includes(relKey)) userEditedList.push(relKey);
    }
  } else if (fs.existsSync(treeRoot) && manifest !== null) {
    issues.push('manifest has no managed map (unexpected schema) — cannot verify integrity');
  }

  const healthy = issues.length === 0 && blockPresent && fs.existsSync(treeRoot) && managedTotal > 0;
  return {
    tool: 'codex', label: 'codex', base: agentsPath,
    present: blockPresent || fs.existsSync(treeRoot),
    healthy, issues, userEdited: userEditedList,
    managedOk, managedTotal,
    note: healthy
      ? `managed block + ${managedOk}/${managedTotal} tree files intact${userEditedList.length ? `, ${userEditedList.length} user-edited (preserved)` : ''}`
      : (issues[0] || 'incomplete'),
  };
}

function main() {
  const src = sourceControlRefs();
  const inst = installStatus();

  const anyStale = inst.some((t) => t.present && t.tally && t.tally['ours-stale'] > 0);
  // R07: a partial SKILL.md install (tree truncated) and a broken/half-removed Codex install
  // (managed block but missing/corrupt tree) are BROKEN installs — they must fail, not pass.
  const anyPartial = inst.some((t) => t.present && t.partial);
  const codexBroken = inst.some((t) => t.tool === 'codex' && t.present && !t.healthy);
  const sourceBad = src.unresolved.length > 0 || src.legacyCitations.length > 0;
  const exitCode = sourceBad || anyStale || anyPartial || codexBroken ? 1 : 0;

  if (JSON_OUT) {
    console.log(JSON.stringify({ home: HOME, target: TARGET, source: src, installs: inst, ok: exitCode === 0 }, null, 2));
    process.exit(exitCode);
  }

  console.log('fintech-compliance-skills — install self-check');
  console.log('(static check of files on disk; NOT a runtime compliance audit, NOT a scanner)\n');

  console.log(`SOURCE  controls: ${src.controls}   skills: ${src.skills}`);
  console.log(`  FCS-id references resolve to catalog : ${src.unresolved.length === 0 ? 'yes' : 'NO (' + src.unresolved.length + ' unresolved)'}`);
  for (const u of src.unresolved) console.log(`    ✗ ${u.skill} cites unknown ${u.id}`);
  console.log(`  legacy numbered citations remaining  : ${src.legacyCitations.length}`);
  for (const c of src.legacyCitations) console.log(`    ✗ ${c.skill}: "${c.text}"`);

  console.log('\nINSTALLS (under this home/target)');
  for (const t of inst) {
    if (!t.present) { console.log(`  - ${t.label}: not installed`); continue; }
    if (t.tool === 'codex') {
      console.log(`  ${t.healthy ? '✓' : '✗'} ${t.label}: ${t.note}`);
      for (const iss of (t.issues || [])) console.log(`      ✗ ${iss}`);
      for (const ue of (t.userEdited || [])) console.log(`      - ${ue}: user-edited (preserved)`);
      continue;
    }
    const d = t.tally;
    const flags = [];
    if (d['ours-stale']) flags.push(`${d['ours-stale']} STALE (source newer — re-run installer)`);
    if (d.user) flags.push(`${d.user} user-edited (preserved)`);
    if (d.legacy) flags.push(`${d.legacy} legacy format (migrate with installer)`);
    if (d.absent) flags.push(`${d.absent} absent (INCOMPLETE install)`);
    const bad = d['ours-stale'] > 0 || t.partial;
    console.log(`  ${bad ? '✗' : '✓'} ${t.label}: ${t.installed}/${src.skills} installed, ${d.current} current${flags.length ? '; ' + flags.join(', ') : ''}`);
    for (const x of t.details) console.log(`      - ${x.skill}: ${x.state}`);
  }

  console.log(`\n${exitCode === 0 ? 'OK — no source defects; no drifted installs.' : 'ISSUES FOUND (see ✗ above).'}`);
  console.log('Reminder: this verifies install integrity only. It does not certify that your own code is compliant.');
  process.exit(exitCode);
}

main();
