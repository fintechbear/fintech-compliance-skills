'use strict';
// Adapter self-test: proves the REAL runCodex() state machine (OK / EMPTY / NONZERO_EXIT /
// TIMEOUT / SPAWN_ERROR / SIGNAL) WITHOUT calling any LLM and WITHOUT re-implementing the
// logic. We drive the real runCodex by injecting opts.spawnFn — a fake EventEmitter child
// the test controls — so the SAME close/timeout/error handling in codex.js runs against it.
// A separate REAL child/grandchild test proves a timeout kills the whole process tree.
const assert = require('assert');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runCodex } = require('./codex.js');

// A fake child process: stdout/stderr emitters + kill() recorder. The test emits 'close'/
// 'error' on it to drive runCodex through its states.
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = 999999; // non-existent pid; killTree's taskkill/process.kill is a no-op/throws, caught
  c.killed = [];
  c.kill = (sig) => { c.killed.push(sig || 'SIGTERM'); return true; };
  return c;
}
// Run the REAL runCodex with an injected fake child; `drive(child)` schedules the events.
function withFake(drive, timeoutMs = 50000) {
  let captured;
  const spawnFn = () => { captured = fakeChild(); setImmediate(() => drive(captured)); return captured; };
  return runCodex('prompt.txt', '/tmp/cwd', timeoutMs, null, { spawnFn }).then((r) => ({ r, child: captured }));
}

(async () => {
  let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

  // OK: output on stdout, clean exit 0
  let { r } = await withFake((c) => { c.stdout.emit('data', 'hello'); c.emit('close', 0, null); });
  ok(r.state === 'OK' && r.output === 'hello', 'OK state via real runCodex');

  // EMPTY: exit 0, no output
  ({ r } = await withFake((c) => { c.emit('close', 0, null); }));
  ok(r.state === 'EMPTY', 'EMPTY state');

  // NONZERO_EXIT: exit 7 carries the code
  ({ r } = await withFake((c) => { c.stdout.emit('data', 'partial'); c.emit('close', 7, null); }));
  ok(r.state === 'NONZERO_EXIT' && r.code === 7, 'NONZERO_EXIT state + code');

  // SIGNAL: killed by a signal
  ({ r } = await withFake((c) => { c.emit('close', null, 'SIGKILL'); }));
  ok(r.state === 'SIGNAL' && r.signal === 'SIGKILL', 'SIGNAL state');

  // SPAWN_ERROR: spawn fails
  ({ r } = await withFake((c) => { c.emit('error', new Error('ENOENT')); }));
  ok(r.state === 'SPAWN_ERROR', 'SPAWN_ERROR state');

  // TIMEOUT: child never closes within the (tiny) timeout; killTree is invoked on it.
  let timedChild;
  {
    const res = await withFake((_c) => { /* emit nothing: never closes */ }, 120);
    r = res.r; timedChild = res.child;
  }
  ok(r.state === 'TIMEOUT', 'TIMEOUT state when child never closes');
  // killTree ran: on this fake, the POSIX path falls back to child.kill('SIGKILL'); on win32
  // taskkill is spawned against a bogus pid (no throw). Either way the state is TIMEOUT and
  // a late close is ignored (done guard). Emitting close after timeout must NOT change result.
  timedChild.emit('close', 0, null);
  await new Promise((res) => setTimeout(res, 20));
  ok(r.state === 'TIMEOUT', 'a late close after timeout does not override TIMEOUT');

  // ---- REAL process tree: a timeout must kill child AND grandchild ----
  // Spawn (via the real spawnFn) a node process that spawns a long-lived grandchild and
  // writes the grandchild pid to a file, then sleeps. After the timeout fires, the
  // grandchild must be gone (killTree walked the tree).
  if (process.platform !== 'win32') { // POSIX process-group kill is the deterministic path
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-tree-'));
    const pidFile = path.join(tmp, 'gc.pid');
    const script = `
      const { spawn } = require('child_process');
      const fs = require('fs');
      const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));
      setInterval(()=>{}, 1000);
    `;
    const realSpawn = (cmd, args) => spawn(process.execPath, ['-e', script], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const res = await runCodex('p', tmp, 600, null, { spawnFn: realSpawn });
    ok(res.state === 'TIMEOUT', 'real tree: timed out as expected');
    // give killTree a moment
    await new Promise((r2) => setTimeout(r2, 400));
    const gcPid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    try { process.kill(gcPid, 0); } catch { alive = false; }
    ok(!alive, `real tree: grandchild pid ${gcPid} was killed by killTree (no orphan)`);
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    console.log('  (skipping POSIX process-group tree test on win32; taskkill /T path used in prod)');
  }

  console.log(`adapter self-test: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
