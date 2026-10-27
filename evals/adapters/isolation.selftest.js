'use strict';
// Config-isolation self-test (no LLM, deterministic). Proves prepareCodexHome() builds a
// CODEX_HOME that carries the credential + provider config but NONE of the global
// instruction sources (skills/rules/memories/plugins/AGENTS.md), closing the P02
// isolation prerequisite. If this passes, a BASELINE vs CANDIDATE run is not polluted by
// the host's personal codex state.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { prepareCodexHome, assertNoGlobalLeak } = require('./codex.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-iso-'));
let failures = 0;
const ok = (c, m) => { if (!c) { failures++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

try {
  // Build a FAKE global ~/.codex that looks like this host: auth + config + personal leaks.
  const fakeGlobal = path.join(tmp, 'global-codex');
  fs.mkdirSync(path.join(fakeGlobal, 'skills', 'personal'), { recursive: true });
  fs.mkdirSync(path.join(fakeGlobal, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(fakeGlobal, 'memories'), { recursive: true });
  fs.mkdirSync(path.join(fakeGlobal, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(fakeGlobal, 'auth.json'), '{"token":"FAKE"}');
  fs.writeFileSync(path.join(fakeGlobal, 'config.toml'), 'model = "x"\n');
  fs.writeFileSync(path.join(fakeGlobal, 'skills', 'personal', 'SKILL.md'), '# personal skill that MUST NOT leak');
  fs.writeFileSync(path.join(fakeGlobal, 'rules', 'house.md'), 'always do X');
  fs.writeFileSync(path.join(fakeGlobal, 'memories', 'notes.md'), 'personal memory');
  fs.writeFileSync(path.join(fakeGlobal, 'AGENTS.md'), 'global agent instructions');

  const clean = prepareCodexHome(path.join(tmp, 'run'), fakeGlobal);

  ok(fs.existsSync(path.join(clean, 'auth.json')), 'clean home carries auth.json (authenticated run possible)');
  ok(fs.existsSync(path.join(clean, 'config.toml')), 'clean home carries config.toml (provider wiring)');
  const leaks = assertNoGlobalLeak(clean);
  ok(leaks.length === 0, `clean home carries NO global instruction source (leaked: ${leaks.join(', ') || 'none'})`);
  ok(!fs.existsSync(path.join(clean, 'skills')), 'personal skills/ did not leak');
  ok(!fs.existsSync(path.join(clean, 'rules')), 'personal rules/ did not leak');
  ok(!fs.existsSync(path.join(clean, 'memories')), 'personal memories/ did not leak');
  ok(!fs.existsSync(path.join(clean, 'AGENTS.md')), 'global AGENTS.md did not leak');

  // Missing auth must be a hard error, never a silent unauthenticated run.
  let threw = false;
  try { prepareCodexHome(path.join(tmp, 'noauth'), path.join(tmp, 'empty-global')); } catch { threw = true; }
  ok(threw, 'missing global auth.json throws (no silent unauthenticated run)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} isolation check(s) failed.`); process.exit(1); }
console.log('\nconfig-isolation self-test: all checks passed.');
