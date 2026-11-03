'use strict';
// AUD-20261102-F07: the package carries its SOURCE IDENTITY explicitly, so an installed skill can
// link repo resources (controls/, examples/) to an IMMUTABLE full-commit URL. Nothing here runs git
// or touches the network; a missing identity is reported, never guessed. We never fall back to a
// version tag (it may not exist) or to a mutable branch such as main.
//
// Identity sources, in order:
//   installer/source.generated.json — written by `npm run stamp-source` (npm `prepare`, so it runs
//     when npm packs a git checkout: publish, and `npx github:owner/repo#ref` installs). It records
//     the checkout's HEAD only when the shipped content (skills/, controls/, examples/) is clean.
//   installer/source.json — committed default: repo URL, commit null (= not pinned).
const fs = require('fs');
const path = require('path');

const FULL_SHA = /^[0-9a-f]{40}$/;
const DEFAULT = { repo: 'https://github.com/fintechbear/fintech-compliance-skills', commit: null };

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function resolveSource(installerDir = __dirname) {
  for (const [file, origin] of [['source.generated.json', 'stamped'], ['source.json', 'committed']]) {
    const j = readJson(path.join(installerDir, file));
    if (!j || typeof j !== 'object') continue;
    const repo = typeof j.repo === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(j.repo) ? j.repo : DEFAULT.repo;
    if (typeof j.commit === 'string' && FULL_SHA.test(j.commit)) return { repo, commit: j.commit, origin };
    if (origin === 'committed') return { repo, commit: null, origin: 'none' };
  }
  return { ...DEFAULT, origin: 'none' };
}

// Immutable URL for a repo-relative resource, or null when the build is not pinned.
function resourceUrl(source, relPath) {
  if (!source || !source.commit || !FULL_SHA.test(source.commit)) return null;
  const clean = relPath.replace(/^\.?\/+/, '');
  const kind = clean.endsWith('/') ? 'tree' : 'blob';
  return `${source.repo}/${kind}/${source.commit}/${clean.replace(/\/+$/, '')}`;
}

module.exports = { resolveSource, resourceUrl, FULL_SHA };
