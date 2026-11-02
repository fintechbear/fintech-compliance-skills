'use strict';
// Writes installer/source.generated.json with the full commit of this checkout — but ONLY when
// git is available and the content that ships (skills/, controls/, examples/) has no uncommitted
// change, so the recorded commit really contains what is packed. Never fails the install: if git
// is missing or the tree is dirty it records commit:null and the reason (links stay unpinned).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'source.generated.json');
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'source.json'), 'utf8'));
let commit = null; let reason = '';
try {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const head = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--', 'skills', 'controls', 'examples');
  if (!/^[0-9a-f]{40}$/.test(head)) reason = 'HEAD is not a full commit';
  else if (dirty) reason = 'shipped content has uncommitted changes';
  else commit = head;
} catch { reason = 'git unavailable or not a git checkout'; }
fs.writeFileSync(out, JSON.stringify({ repo: base.repo, commit, reason: commit ? undefined : reason }, null, 2) + '\n');
// stderr: npm pack/publish --json write machine output on stdout
console.error(`stamp-source: ${commit ? `pinned ${commit}` : `not pinned (${reason})`}`);
