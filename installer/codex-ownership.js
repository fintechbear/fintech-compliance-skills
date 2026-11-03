'use strict';
// AUD-20261102-F05: ONE pure ownership contract for the Codex install tree.
//
// Codex installs raw package Markdown under <target>/.fintech-compliance-skills/skills/... plus a
// manifest (.fcs-manifest.json, v2: { version:2, managed:{relKey:hash}, userEdited:{relKey:hash} }).
// The flat SKILL.md hash stamp does NOT exist there, so the flat classify() must never be used on
// this tree. install, diff and uninstall all take their decisions from classifyCodexEntry().
//
// Inputs are plain data (no fs): the parsed manifest, the hash of the file on disk (or null), the
// hash of the current package file (or undefined when the path is not a package path), and a
// legacy recogniser. Output is one state + whether ownership is PROVEN (only proven-owned,
// unchanged files may ever be removed).

// States:
//   absent       package file not on disk                        -> install creates it
//   current      on disk == current package                      -> nothing to do
//   stale        on disk == our last managed baseline != package  -> ours, update
//   legacy       no manifest record, byte-exact known old output  -> ours, update
//   user_edited  differs from package and from our baseline       -> preserve
//   unknown      not a package path at all                       -> preserve
//   unverifiable manifest corrupt and file != package            -> preserve, report
const STATES = ['absent', 'current', 'stale', 'legacy', 'user_edited', 'unknown', 'unverifiable'];

// Parse raw manifest text into a normalised view. Never throws.
function readManifest(raw, normKey = (k) => k) {
  if (raw == null) return { status: 'absent', managed: {}, userEdited: {} };
  let m; try { m = JSON.parse(raw); } catch { return { status: 'corrupt', managed: {}, userEdited: {} }; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { status: 'corrupt', managed: {}, userEdited: {} };
  const managed = {}; const userEdited = {};
  if (m.version >= 2) {
    if (m.version !== 2) return { status: 'corrupt', managed: {}, userEdited: {} };
    for (const [k, v] of Object.entries(m.managed || {})) if (typeof v === 'string') managed[normKey(k)] = v;
    for (const [k, v] of Object.entries(m.userEdited || {})) if (typeof v === 'string') userEdited[normKey(k)] = v;
    return { status: 'v2', managed, userEdited };
  }
  for (const [k, v] of Object.entries(m)) if (typeof v === 'string') managed[normKey(k)] = v; // legacy flat map
  return { status: 'legacy-flat', managed, userEdited };
}

function classifyCodexEntry({ relKey, diskHash, pkgHash, manifest, isLegacy }) {
  const own = (o) => Object.prototype.hasOwnProperty.call(o, relKey);
  if (pkgHash === undefined) return { state: diskHash == null ? 'absent' : 'unknown', owned: false };
  if (diskHash == null) return { state: 'absent', owned: false };
  if (diskHash === pkgHash) {
    // identical to the package: removable only when the manifest proves we wrote it
    const owned = manifest.status !== 'corrupt' && own(manifest.managed) && manifest.managed[relKey] === diskHash;
    return { state: 'current', owned: owned || (manifest.status === 'absent' && !!(isLegacy && isLegacy())) };
  }
  if (manifest.status === 'corrupt') return { state: 'unverifiable', owned: false };
  if (own(manifest.managed) && manifest.managed[relKey] === diskHash) return { state: 'stale', owned: true };
  if (!own(manifest.managed) && !own(manifest.userEdited) && isLegacy && isLegacy()) return { state: 'legacy', owned: true };
  return { state: 'user_edited', owned: false };
}

// Plan actions for one entry. `mode` is 'install' (force=false), 'install-force' or 'uninstall'.
function actionFor(entry, mode) {
  const { state, owned } = entry;
  if (mode === 'uninstall') {
    if (owned && (state === 'current' || state === 'stale' || state === 'legacy')) return 'remove';
    if (state === 'absent') return 'none';
    return 'preserve';
  }
  if (state === 'absent') return 'create';
  if (state === 'current') return 'unchanged';
  if (state === 'stale' || state === 'legacy') return 'update';
  if (state === 'unknown') return 'preserve';
  return mode === 'install-force' ? 'overwrite' : 'preserve';
}

// Build a full plan from plain data: disk = {relKey: hash}, pkg = {relKey: hash}.
function planCodex({ disk, pkg, manifestRaw, normKey, isLegacyFor, mode }) {
  const manifest = readManifest(manifestRaw, normKey);
  const keys = new Set([...Object.keys(pkg), ...Object.keys(disk)]);
  const entries = [];
  for (const relKey of [...keys].sort()) {
    const e = classifyCodexEntry({ relKey, diskHash: disk[relKey] ?? null, pkgHash: pkg[relKey], manifest, isLegacy: isLegacyFor ? () => isLegacyFor(relKey) : null });
    entries.push({ relKey, ...e, action: actionFor(e, mode) });
  }
  return { manifest_status: manifest.status, entries };
}

module.exports = { STATES, readManifest, classifyCodexEntry, actionFor, planCodex };
