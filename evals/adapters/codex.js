'use strict';
// Codex CLI adapter. Runs one task prompt non-interactively in an ISOLATED sandbox and
// returns a structured result. Timeout, non-zero exit, and empty output are DISTINCT
// states — never silently treated as success. Does NOT call any LLM itself; it shells
// out to the real `codex exec` the operator already has configured.
//
// Conditions:
//   WITHOUT_SKILLS   : sandbox has ONLY the task prompt (no skill files, no AGENTS.md)
//   CURRENT_BASELINE : sandbox has the baseline skill tree installed
//   CANDIDATE        : sandbox has the candidate skill tree installed
// The adapter is given the condition's prepared sandbox dir; it never sees expected
// results, grader code, other conditions, or the repo history.

const { spawn } = require('child_process');

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

function runCodex(promptFile, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const { cmd, args } = codexInvocation(promptFile, cwd);
    const child = spawn(cmd, args, { windowsHide: true });
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

module.exports = { runCodex, codexInvocation };
