#!/usr/bin/env node
// Migrate broken numbered "refusal rule N" citations in skill files to permanent
// FCS control ids, using the context-verified mapping in refusal-citation-migration.json.
// Idempotent: a citation already carrying an FCS id is left alone.
'use strict';
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const mapPath = path.join(repoRoot, 'controls', 'refusal-citation-migration.json');
const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

// "FCS-AML-001" -> that; "FCS-SECRET-001 / FCS-CRYPTO-001" -> both.
function fcsPhrase(fcsField) {
  const ids = fcsField.split('/').map((s) => s.trim());
  return ids.join(', ');
}

// Match the old citation text robustly: "refusal rule 5", "refusal policy rule 6",
// "refusal rule 2/4", "refusal rule 4, 7". Capture leading phrase to preserve it.
function oldRegex(oldText) {
  // oldText like "refusal rule 5" or "refusal rule 2/4" or "refusal rule 4, 7"
  // Build a tolerant regex from it.
  const esc = oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(esc);
}

const dryRun = process.argv.includes('--check');
let changed = 0;
let missing = 0;
const perFile = {};

for (const e of map.entries) {
  const abs = path.join(repoRoot, e.file.replace(/\//g, path.sep));
  if (!fs.existsSync(abs)) { console.error('MISSING FILE: ' + e.file); missing++; continue; }
  let text = fs.readFileSync(abs, 'utf8');
  const re = oldRegex(e.old);
  const replacement = fcsPhrase(e.fcs);
  if (!re.test(text)) {
    // Already migrated? check for the fcs id presence near nothing — report if the old text is simply gone.
    if (text.includes(replacement)) { continue; } // idempotent: already done
    console.error(`NO MATCH for "${e.old}" in ${e.file} (meaning: ${e.meaning})`);
    missing++;
    continue;
  }
  const next = text.replace(re, replacement);
  if (next !== text) {
    if (!dryRun) fs.writeFileSync(abs, next, 'utf8');
    changed++;
    perFile[e.file] = (perFile[e.file] || 0) + 1;
  }
}

console.log(JSON.stringify({ mode: dryRun ? 'check' : 'apply', changed, missing, perFile }, null, 2));
process.exit(missing > 0 ? 1 : 0);
