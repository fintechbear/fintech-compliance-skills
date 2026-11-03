'use strict';
// Pure test for AUD-20261102-F07 (installed resource references). No install, no CLI, no network.
// Run: node installer/resource-refs.selftest.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const i = require('./index');
const { resolveSource } = require('./source');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const ROOT = path.join(__dirname, '..');
const SHA = 'a'.repeat(40);
const pinned = { repo: 'https://github.com/fintechbear/fintech-compliance-skills', commit: SHA };
const unpinned = { repo: pinned.repo, commit: null };
const fences = (t) => (t.match(/```[\s\S]*?```/g) || []);
const linksIn = (t) => (t.match(/\[[^\]\n]*\]\([^)\n]*\)/g) || []);

// 1. Every reference in every skill, for both targets (Codex tree via codexFileContent, flat via
//    managedContent), resolves to a full-SHA URL of a path that really exists in the source tree —
//    never a version tag, never main. The identity is supplied the way a build supplies it: by
//    writing installer/source.generated.json (restored afterwards).
const GEN = path.join(__dirname, 'source.generated.json');
const hadGen = fs.existsSync(GEN) ? fs.readFileSync(GEN) : null;
function withIdentity(src, fn) {
  if (src) fs.writeFileSync(GEN, JSON.stringify(src)); else if (fs.existsSync(GEN)) fs.rmSync(GEN);
  try { return fn(); } finally { if (hadGen) fs.writeFileSync(GEN, hadGen); else if (fs.existsSync(GEN)) fs.rmSync(GEN); }
}
const render = (s) => i.codexFileContent(`skills/${s.group}/${s.file}`, fs.readFileSync(s.abs)).toString('utf8');

const skills = i.listSkillFiles();
let refsSeen = 0;
withIdentity(pinned, () => {
  for (const s of skills) {
    const raw = fs.readFileSync(s.abs, 'utf8');
    for (const out of [render(s), i.managedContent(s)]) {
      ok(!/fintech-compliance-skills\/(blob|tree)\/(v\d[^/]*|main|master)\//.test(out), `${s.file}: no version-tag or main link to this repo`);
      for (const m of out.matchAll(/https:\/\/github\.com\/fintechbear\/fintech-compliance-skills\/(blob|tree)\/([0-9a-f]+)\/([^)\s]+)/g)) {
        refsSeen++;
        ok(m[2] === SHA, `${s.file}: link is pinned to the full commit`);
        ok(fs.existsSync(path.join(ROOT, m[3])), `${s.file}: linked resource ${m[3]} exists in the source tree`);
      }
      // fenced code untouched
      const rawF = fences(raw); const outF = fences(out);
      ok(rawF.every((f) => outF.includes(f)), `${s.file}: fenced code blocks unchanged`);
      // no nested links like [[x](u)](v) or ](u)(v)
      const prose = out.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
      ok(!/\]\([^)\n]*\[/.test(prose) && !/\[\[/.test(prose), `${s.file}: no nested links in prose`);
      // existing markdown links survive verbatim (flat target may rewrite sibling .md links by design)
      if (out === render(s)) ok(linksIn(raw).every((l) => out.includes(l)), `${s.file}: existing links kept`);
    }
  }
});
ok(refsSeen > 0, 'some resource references were rendered as pinned links');

// 2. Unpinned build: no fabricated link at all; one explicit note per file instead.
withIdentity({ repo: pinned.repo, commit: null }, () => {
  for (const s of skills) {
    const out = render(s);
    ok(!/fintech-compliance-skills\/(blob|tree)\//.test(out), `${s.file}: unpinned build invents no link`);
    const raw = fs.readFileSync(s.abs, 'utf8');
    if (/(controls|examples)\//.test(raw.replace(/```[\s\S]*?```/g, ''))) ok(/not pinned to a commit/.test(out), `${s.file}: unpinned note present`);
  }
});

// 3. Synthetic install target with NO repo checkout: identity resolves from the shipped files only.
const tgt = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-f07-'));
try {
  fs.copyFileSync(path.join(__dirname, 'source.json'), path.join(tgt, 'source.json'));
  const r = resolveSource(tgt);
  ok(r.commit === null && r.origin === 'none', 'no checkout + committed default -> explicitly not pinned');
  fs.writeFileSync(path.join(tgt, 'source.generated.json'), JSON.stringify({ repo: pinned.repo, commit: SHA }));
  ok(resolveSource(tgt).commit === SHA, 'stamped identity is used without any git call');
  fs.writeFileSync(path.join(tgt, 'source.generated.json'), JSON.stringify({ repo: pinned.repo, commit: 'v1.0.0' }));
  ok(resolveSource(tgt).commit === null, 'a tag or short ref is never accepted as an immutable source');
} finally { fs.rmSync(tgt, { recursive: true, force: true }); }

console.log(`resource-refs self-test: ${n} checks passed`);
