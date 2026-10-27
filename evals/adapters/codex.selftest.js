'use strict';
// Adapter self-test: proves the state machine (OK / EMPTY / NONZERO_EXIT / TIMEOUT /
// SPAWN_ERROR) WITHOUT calling any LLM, by swapping in fake commands. This validates that
// a failed/slow/empty run is NEVER reported as success.
const assert = require('assert');
const { spawn } = require('child_process');

// Re-implement the same close/timeout logic against an injectable command, mirroring
// adapters/codex.js runCodex, so we can drive it with deterministic fakes.
function runCmd(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => { if (done) return; done = true; try { child.kill('SIGKILL'); } catch {} resolve({ state: 'TIMEOUT' }); }, timeoutMs);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', () => { if (done) return; done = true; clearTimeout(timer); resolve({ state: 'SPAWN_ERROR' }); });
    child.on('close', (code, signal) => {
      if (done) return; done = true; clearTimeout(timer);
      if (signal) return resolve({ state: 'SIGNAL' });
      if (code !== 0) return resolve({ state: 'NONZERO_EXIT', code });
      const clean = out.trim();
      resolve(clean.length === 0 ? { state: 'EMPTY' } : { state: 'OK', output: clean });
    });
  });
}

const isWin = process.platform === 'win32';
const node = process.execPath;

(async () => {
  let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

  // OK: prints text, exit 0
  let r = await runCmd(node, ['-e', 'process.stdout.write("hello")'], 5000);
  ok(r.state === 'OK' && r.output === 'hello', 'OK state');

  // EMPTY: exit 0, no output
  r = await runCmd(node, ['-e', 'process.exit(0)'], 5000);
  ok(r.state === 'EMPTY', 'EMPTY state');

  // NONZERO_EXIT: exit 7
  r = await runCmd(node, ['-e', 'process.exit(7)'], 5000);
  ok(r.state === 'NONZERO_EXIT' && r.code === 7, 'NONZERO_EXIT state');

  // TIMEOUT: sleeps longer than the timeout
  r = await runCmd(node, ['-e', 'setTimeout(()=>{}, 10000)'], 500);
  ok(r.state === 'TIMEOUT', 'TIMEOUT state');

  // SPAWN_ERROR: command does not exist
  r = await runCmd('this-command-does-not-exist-xyz', [], 3000);
  ok(r.state === 'SPAWN_ERROR', 'SPAWN_ERROR state');

  console.log(`adapter self-test: ${n} checks passed`);
})();
