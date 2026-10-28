'use strict';
// Codex CLI adapter. Runs one task prompt non-interactively in an ISOLATED sandbox and
// returns a structured result. Runtime CLI validation is excluded from this release. Timeout, non-zero exit, and empty output are DISTINCT
// states — never silently treated as success. Does NOT call any LLM itself; it shells
// out to the real `codex exec` the operator already has configured.
//
// CONFIG ISOLATION (the P02 prerequisite): the global CODEX_HOME (~/.codex) on this host is
// not a bare CLI — it carries personal skills/, rules/, memories/ that would leak into a run
// and make BASELINE vs CANDIDATE incomparable. prepareCodexHome() builds a CLEAN CODEX_HOME
// that copies ONLY the credential (auth.json) and the provider config (config.toml, needed
// for the custom model provider the auth is bound to) and NOTHING ELSE — no skills, rules,
// memories, plugins. assertNoGlobalLeak() proves the clean home carries none of them.
//
// Conditions:
//   WITHOUT_SKILLS   : sandbox has ONLY the task prompt (no skill files, no AGENTS.md)
//   CURRENT_BASELINE : sandbox has the baseline skill tree installed
//   CANDIDATE        : sandbox has the candidate skill tree installed
// The adapter is given the condition's prepared sandbox dir; it never sees expected
// results, grader code, other conditions, or the repo history.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Files copied into the clean CODEX_HOME. auth.json = credential (copied VERBATIM).
// config.toml is NOT copied verbatim — it is SYNTHESISED down to only the keys needed to
// reach the provider the credential is bound to (see synthMinimalConfig). Explicitly never
// carried: skills, rules, memories, plugins, sessions, history — any global instruction source.
const ISOLATED_ALLOW = ['auth.json'];
const LEAK_NAMES = ['skills', 'rules', 'memories', 'plugins', 'AGENTS.md', 'instructions.md'];

// config.toml keys that carry INSTRUCTIONS/behaviour the agent would pick up — these must
// never survive into the isolated home, or BASELINE vs CANDIDATE stops being comparable.
// Matched at top level AND inside any [table]. Credential/provider wiring is allow-listed
// separately (CONFIG_ALLOW_KEYS); everything else is dropped.
const CONFIG_INSTRUCTION_KEYS = [
  'developer_instructions', 'model_instructions', 'model_instructions_file',
  'instructions', 'instructions_file', 'system_prompt', 'prompt', 'prompt_file',
  'notify', 'hooks', 'hook', 'mcp_servers', 'mcp', 'profiles', 'profile',
  'projects', 'trust', 'plugins', 'skills', 'rules', 'memories',
];
// The only top-level scalar keys we keep from the GLOBAL config: provider selection + model.
// Provider CONNECTION details live in a [model_providers.*] table, kept wholesale (minus
// instruction keys). NOTE: approval_policy and sandbox_mode are deliberately NOT carried from
// the global config — the eval must define its OWN explicit, auditable permissions rather than
// inherit a permissive personal setting (R05). synthMinimalConfig adds them with safe defaults.
const CONFIG_ALLOW_KEYS = ['model', 'model_provider', 'model_reasoning_effort'];

// Parse TOML before allow-listing; quoted provider names, escaped strings, inline tables
// and comments retain their meaning. Never copy arbitrary provider/instruction tables.
function synthMinimalConfig(tomlText, sandbox) {
  const TOML = require('@iarna/toml');
  const src = TOML.parse(String(tomlText));
  const cfg = {};
  const kept = { providers: [], topKeys: [] };
  for (const key of CONFIG_ALLOW_KEYS) if (Object.hasOwn(src, key)) { cfg[key] = src[key]; kept.topKeys.push(key); }
  const providerKeys = ['name', 'base_url', 'env_key', 'http_headers', 'env_http_headers', 'wire_api', 'query_params', 'requires_openai_auth', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms', 'supports_websockets'];
  if (src.model_providers && typeof src.model_providers === 'object') {
    cfg.model_providers = {};
    for (const [name, source] of Object.entries(src.model_providers)) {
      if (!source || typeof source !== 'object') continue;
      const dest = {};
      for (const key of providerKeys) if (Object.hasOwn(source, key)) dest[key] = source[key];
      Object.defineProperty(cfg.model_providers, name, { value: dest, enumerable: true });
      kept.providers.push(`model_providers.${name}`);
    }
  }
  // A read-only legacy sandbox does not restrict reads to the workspace. Use an explicit
  // filesystem profile: runtime files + this exact sandbox, no other condition/prep/grader.
  cfg.approval_policy = 'never';
  cfg.default_permissions = 'fcs_eval';
  const filesystem = { ':minimal': 'read' };
  if (sandbox) filesystem[path.resolve(sandbox)] = 'read';
  cfg.permissions = { fcs_eval: { filesystem, network: { enabled: false } } };
  return { text: TOML.stringify(cfg), kept, permissions: { approval_policy: 'never', default_permissions: 'fcs_eval' } };
}

// Build a clean CODEX_HOME under baseDir; returns { dest, kept }. Throws if no global auth.
function prepareCodexHome(baseDir, globalHome = path.join(os.homedir(), '.codex')) {
  const dest = path.join(baseDir, 'codex-home');
  fs.mkdirSync(dest, { recursive: true });
  // credential: verbatim
  const authSrc = path.join(globalHome, 'auth.json');
  if (!fs.existsSync(authSrc)) throw new Error(`no auth.json in ${globalHome}: cannot run an authenticated, isolated codex`);
  fs.copyFileSync(authSrc, path.join(dest, 'auth.json'));
  // config: SYNTHESISED minimal (provider wiring only; instruction surfaces stripped)
  const cfgSrc = path.join(globalHome, 'config.toml');
  let kept = { providers: [], topKeys: [] };
  if (fs.existsSync(cfgSrc)) {
    const syn = synthMinimalConfig(fs.readFileSync(cfgSrc, 'utf8'), path.join(baseDir, 'sandbox'));
    fs.writeFileSync(path.join(dest, 'config.toml'), syn.text, 'utf8');
    kept = syn.kept;
  } else {
    fs.writeFileSync(path.join(dest, 'config.toml'), synthMinimalConfig('', path.join(baseDir, 'sandbox')).text);
  }
  return { dest, kept };
}

// Assert the clean home carries no global instruction source — BOTH as files on disk AND
// as instruction keys inside the synthesised config.toml. Never logs the credential.
// Returns the leaked indicators (empty array = clean).
function assertNoGlobalLeak(codexHome) {
  const leaks = LEAK_NAMES.filter((n) => fs.existsSync(path.join(codexHome, n)));
  const cfg = path.join(codexHome, 'config.toml');
  if (fs.existsSync(cfg)) {
    const text = fs.readFileSync(cfg, 'utf8');
    for (const k of CONFIG_INSTRUCTION_KEYS) {
      // a surviving instruction key assignment (k = ... or k.sub = ...)
      if (new RegExp(`(^|\\n)\\s*${k.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(\\.[A-Za-z0-9_-]+)?\\s*=`).test(text)) {
        leaks.push(`config:${k}`);
      }
    }
  }
  return leaks;
}

// Resolve the codex invocation per OS (Windows uses the .ps1 shim via powershell).
function codexInvocation(promptFile, cwd) {
  if (process.platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-Command',
        `Get-Content -Raw "${promptFile}" | codex exec --skip-git-repo-check -C "${cwd}" -`],
    };
  }
  return { cmd: 'bash', args: ['-lc', `codex exec --skip-git-repo-check -C "${cwd}" - < "${promptFile}"`] };
}

// Kill the whole process tree of `child` so a timeout cannot leave a grandchild (the real
// codex process behind the shell shim) running. Windows: taskkill /T /F; POSIX: negative
// pid kills the process group (child is spawned detached so it leads its own group).
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { try { child.kill('SIGKILL'); } catch {} }
}

// runCodex with an INJECTABLE process runner. The real logic (state classification,
// timeout, tree-kill) is NEVER rewritten by a test: a test passes opts.spawnFn to supply a
// fake child process, and the SAME close/timeout/error handling below runs against it.
function runCodex(promptFile, cwd, timeoutMs, codexHome, opts = {}) {
  const spawnFn = opts.spawnFn || ((cmd, args) =>
    spawn(cmd, args, { windowsHide: true, env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : { ...process.env },
      detached: process.platform !== 'win32' }));
  return new Promise((resolve) => {
    const { cmd, args } = codexInvocation(promptFile, cwd);
    const child = spawnFn(cmd, args);
    let out = '', err = '', done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      if (done) return; done = true;
      killTree(child);
      resolve({ state: 'TIMEOUT', output: out, stderr: err });
    }, timeoutMs);
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', (e) => finish({ state: 'SPAWN_ERROR', output: '', stderr: String(e) }));
    child.on('close', (code, signal) => {
      if (signal) return finish({ state: 'SIGNAL', output: out, stderr: err, signal });
      if (code !== 0) return finish({ state: 'NONZERO_EXIT', output: out, stderr: err, code });
      const clean = out.trim();
      if (clean.length === 0) return finish({ state: 'EMPTY', output: '', stderr: err });
      return finish({ state: 'OK', output: clean, stderr: err, code });
    });
  });
}

module.exports = { runCodex, codexInvocation, prepareCodexHome, assertNoGlobalLeak,
  synthMinimalConfig, killTree, ISOLATED_ALLOW, LEAK_NAMES, CONFIG_INSTRUCTION_KEYS, CONFIG_ALLOW_KEYS };
