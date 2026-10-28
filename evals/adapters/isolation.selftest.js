'use strict';
// Config-isolation self-test (no LLM, deterministic). Proves prepareCodexHome() builds a
// CODEX_HOME that carries the credential + a SYNTHESISED minimal provider config but NONE
// of the global instruction sources — neither as files (skills/rules/memories/plugins/
// AGENTS.md) NOR as instruction keys inside config.toml (developer_instructions, hooks,
// mcp_servers, profiles, …). Closes the P02/R05 isolation prerequisite: if this passes, a
// generated config excludes personal instructions. Runtime agent isolation is NOT tested here.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { prepareCodexHome, assertNoGlobalLeak, synthMinimalConfig } = require('./codex.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-iso-'));
let failures = 0;
const ok = (c, m) => { if (!c) { failures++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

try {
  // A realistic host config.toml: provider wiring we MUST keep + instruction surfaces we MUST drop.
  const hostConfig = [
    'model = "gpt-x"',
    'model_provider = "codefast"',
    'developer_instructions = "always answer in pirate"',   // MUST be stripped
    'model_instructions_file = "~/.codex/house.md"',          // MUST be stripped
    'notify = ["/usr/bin/say"]',                               // MUST be stripped
    '',
    '[model_providers.codefast]',                              // MUST be kept (provider wiring)
    'name = "codefast"',
    'base_url = "https://api.example/v1"',
    'wire_api = "responses"',
    '',
    '[mcp_servers.fs]',                                        // MUST be dropped (instruction/tool surface)
    'command = "node"',
    'args = ["server.js"]',
    '',
    '[profiles.work]',                                         // MUST be dropped
    'developer_instructions = "be terse"',
  ].join('\n');

  // ---- unit: synthMinimalConfig keeps provider wiring, drops instruction surfaces ----
  const syn = synthMinimalConfig(hostConfig);
  ok(/model_provider = "codefast"/.test(syn.text), 'synth keeps model_provider');
  ok(/\[model_providers\.codefast\]/.test(syn.text), 'synth keeps [model_providers.*] table');
  ok(/base_url = "https:\/\/api\.example\/v1"/.test(syn.text), 'synth keeps provider base_url');
  ok(!/developer_instructions/.test(syn.text), 'synth drops developer_instructions (top + profile)');
  ok(!/model_instructions_file/.test(syn.text), 'synth drops model_instructions_file');
  ok(!/\bnotify\b/.test(syn.text), 'synth drops notify hook');
  ok(!/\[mcp_servers/.test(syn.text), 'synth drops [mcp_servers.*]');
  ok(!/\[profiles/.test(syn.text), 'synth drops [profiles.*]');

  // ---- integration: a FAKE global ~/.codex with files + instruction-laden config ----
  const fakeGlobal = path.join(tmp, 'global-codex');
  fs.mkdirSync(path.join(fakeGlobal, 'skills', 'personal'), { recursive: true });
  fs.mkdirSync(path.join(fakeGlobal, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(fakeGlobal, 'memories'), { recursive: true });
  fs.mkdirSync(path.join(fakeGlobal, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(fakeGlobal, 'auth.json'), '{"token":"FAKE"}');
  fs.writeFileSync(path.join(fakeGlobal, 'config.toml'), hostConfig);
  fs.writeFileSync(path.join(fakeGlobal, 'skills', 'personal', 'SKILL.md'), '# personal skill that MUST NOT leak');
  fs.writeFileSync(path.join(fakeGlobal, 'rules', 'house.md'), 'always do X');
  fs.writeFileSync(path.join(fakeGlobal, 'memories', 'notes.md'), 'personal memory');
  fs.writeFileSync(path.join(fakeGlobal, 'AGENTS.md'), 'global agent instructions');

  const { dest: clean, kept } = prepareCodexHome(path.join(tmp, 'run'), fakeGlobal);

  ok(fs.existsSync(path.join(clean, 'auth.json')), 'clean home carries auth.json (authenticated run possible)');
  ok(fs.existsSync(path.join(clean, 'config.toml')), 'clean home carries a (synthesised) config.toml');
  ok(kept.providers.includes('model_providers.codefast'), 'kept report names the provider table');
  const leaks = assertNoGlobalLeak(clean);
  ok(leaks.length === 0, `clean home carries NO leak (files OR config keys) — leaked: ${leaks.join(', ') || 'none'}`);
  ok(!fs.existsSync(path.join(clean, 'skills')), 'personal skills/ did not leak');
  ok(!fs.existsSync(path.join(clean, 'rules')), 'personal rules/ did not leak');
  ok(!fs.existsSync(path.join(clean, 'memories')), 'personal memories/ did not leak');
  ok(!fs.existsSync(path.join(clean, 'AGENTS.md')), 'global AGENTS.md did not leak');
  // the synthesised config on disk is instruction-free
  const writtenCfg = fs.readFileSync(path.join(clean, 'config.toml'), 'utf8');
  ok(!/developer_instructions|model_instructions_file|mcp_servers|\[profiles/.test(writtenCfg),
    'written config.toml has no instruction surfaces');

  // ---- R05: a provider section with an INLINE COMMENT must still be kept ----
  const commented = [
    'model = "gpt-x"',
    'model_provider = "p"',
    'approval_policy = "never"            # global permissive — MUST NOT be inherited',
    'sandbox_mode = "danger-full-access"  # global permissive — MUST NOT be inherited',
    '[model_providers.p] # provider connection',   // inline comment broke the old section regex
    'name = "p"            # comment after a value',
    'base_url = "https://api.example/v1"',
  ].join('\n');
  const synC = synthMinimalConfig(commented);
  ok(/\[model_providers\.p\]/.test(synC.text), 'R05: commented [model_providers.p] section is kept (inline comment stripped)');
  ok(/base_url = "https:\/\/api\.example\/v1"/.test(synC.text), 'R05: provider base_url under a commented section is kept');
  ok(/name = "p"/.test(synC.text) && !/comment after a value/.test(synC.text), 'R05: inline comment stripped from a value line, value kept');
  ok(!/danger-full-access/.test(synC.text), 'R05: global permissive sandbox_mode is NOT inherited');
  ok(synC.text.includes('default_permissions = "fcs_eval"') && !synC.text.includes('sandbox_mode ='), 'R05: eval declares a filesystem permission profile, not broad read-only');
  ok(synC.text.includes('approval_policy = "never"') && synC.permissions.approval_policy === 'never', 'R05: eval declares its OWN approval_policy explicitly (not inherited)');

  // ---- negative: assertNoGlobalLeak MUST catch an instruction key if one survived ----
  const tampered = path.join(tmp, 'tampered-home');
  fs.mkdirSync(tampered, { recursive: true });
  fs.writeFileSync(path.join(tampered, 'auth.json'), '{"token":"FAKE"}');
  fs.writeFileSync(path.join(tampered, 'config.toml'), 'model = "x"\ndeveloper_instructions = "leak"\n');
  const tamperedLeaks = assertNoGlobalLeak(tampered);
  ok(tamperedLeaks.some((l) => l === 'config:developer_instructions'),
    'leak check CATCHES a surviving instruction key in config.toml (negative self-test)');

  // Missing auth must be a hard error, never a silent unauthenticated run.
  let threw = false;
  try { prepareCodexHome(path.join(tmp, 'noauth'), path.join(tmp, 'empty-global')); } catch { threw = true; }
  ok(threw, 'missing global auth.json throws (no silent unauthenticated run)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} isolation check(s) failed.`); process.exit(1); }
console.log('\nconfig-isolation self-test: all checks passed.');
