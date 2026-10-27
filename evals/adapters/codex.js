'use strict';
// Codex CLI adapter. Runs one task prompt non-interactively in an ISOLATED sandbox and
// returns a structured result. Timeout, non-zero exit, and empty output are DISTINCT
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

// Files copied into the clean CODEX_HOME. auth.json = credential; config.toml = the custom
// model-provider wiring the credential needs. Explicitly NOT copied: skills, rules, memories,
// plugins, sessions, history — anything that could inject global instructions.
const ISOLATED_ALLOW = ['auth.json', 'config.toml'];
const LEAK_NAMES = ['skills', 'rules', 'memories', 'plugins', 'AGENTS.md', 'instructions.md'];

// Build a clean CODEX_HOME under baseDir; returns its path. Throws if no global auth exists.
function prepareCodexHome(baseDir, globalHome = path.join(os.homedir(), '.codex')) {
  const dest = path.join(baseDir, 'codex-home');
  fs.mkdirSync(dest, { recursive: true });
  let copiedAuth = false;
  for (const name of ISOLATED_ALLOW) {
    const src = path.join(globalHome, name);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dest, name)); if (name === 'auth.json') copiedAuth = true; }
  }
  if (!copiedAuth) throw new Error(`no auth.json in ${globalHome}: cannot run an authenticated, isolated codex`);
  return dest;
}

// Assert the clean home carries no global instruction source. Returns the leaked names (empty = clean).
function assertNoGlobalLeak(codexHome) {
  return LEAK_NAMES.filter((n) => fs.existsSync(path.join(codexHome, n)));
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

function runCodex(promptFile, cwd, timeoutMs, codexHome) {
  return new Promise((resolve) => {
    const { cmd, args } = codexInvocation(promptFile, cwd);
    const env = { ...process.env };
    if (codexHome) env.CODEX_HOME = codexHome; // isolated config/credential home
    const child = spawn(cmd, args, { windowsHide: true, env });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => {
      if (done) return; done = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ state: 'TIMEOUT', output: out, stderr: err });
    }, timeoutMs);
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ state: 'SPAWN_ERROR', output: '', stderr: String(e) }); });
    child.on('close', (code, signal) => {
      if (done) return; done = true; clearTimeout(timer);
      if (signal) return resolve({ state: 'SIGNAL', output: out, stderr: err, signal });
      if (code !== 0) return resolve({ state: 'NONZERO_EXIT', output: out, stderr: err, code });
      const clean = out.trim();
      if (clean.length === 0) return resolve({ state: 'EMPTY', output: '', stderr: err });
      return resolve({ state: 'OK', output: clean, stderr: err, code });
    });
  });
}

module.exports = { runCodex, codexInvocation, prepareCodexHome, assertNoGlobalLeak, ISOLATED_ALLOW, LEAK_NAMES };
