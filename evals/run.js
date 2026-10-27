#!/usr/bin/env node
'use strict';
// Scored eval runner: tasks × conditions against the REAL codex CLI, deterministic grader.
// BOUNDED and honest: one worker, per-task timeout, no retries, no improvement loop. Every
// run uses an ISOLATED CODEX_HOME (credential + provider config only; no personal
// skills/rules/memories) so BASELINE vs CANDIDATE is comparable. Raw agent outputs stay in
// the run dir (not committed); a cleaned summary is written to evals/results/.
//
// Conditions:
//   WITHOUT_SKILLS   : sandbox CWD has only prompt.txt
//   CURRENT_BASELINE : sandbox CWD has the baseline skill tree installed (codex format: AGENTS.md + tree)
//   CANDIDATE        : sandbox CWD has the CURRENT (candidate) skill tree installed the same way
//
// Usage:
//   node evals/run.js --ids T001,T016 --conditions WITHOUT_SKILLS,CANDIDATE [--timeout-ms 180000]
//   node evals/run.js --all   (every task × 3 conditions — a LARGE paid run; opt-in)
//
// A missing/limited runtime, or a non-OK adapter state, is recorded as NOT_RUN — never a PASS.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { runCodex, prepareCodexHome, assertNoGlobalLeak } = require('./adapters/codex.js');
const { grade } = require('./grader.js');

const REPO = path.resolve(__dirname, '..');
const INSTALLER = path.join(REPO, 'installer', 'index.js');
const BASELINE_COMMIT = JSON.parse(fs.readFileSync(path.join(__dirname, 'CURRENT_BASELINE.json'), 'utf8')).baseline_commit;
const ALL_CONDITIONS = ['WITHOUT_SKILLS', 'CURRENT_BASELINE', 'CANDIDATE'];

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def; }
const TIMEOUT_MS = Number(arg('--timeout-ms', 180000));
const RUN_DIR = process.env.FCS_RUN_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-eval-'));

function loadTasks() {
  return fs.readFileSync(path.join(__dirname, 'tasks.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

// Install the candidate (current working tree) or baseline (git archive of BASELINE_COMMIT)
// skills into a sandbox in codex format (AGENTS.md + .fintech-compliance-skills/ tree).
function installSkills(condition, sandbox) {
  if (condition === 'WITHOUT_SKILLS') return;
  if (condition === 'CANDIDATE') {
    execFileSync(process.execPath, [INSTALLER, '--tool', 'codex', '--target', sandbox], { stdio: 'pipe' });
    return;
  }
  // CURRENT_BASELINE: materialize the baseline skills/ from git, run that commit's installer.
  const blRepo = path.join(sandbox, '_baseline_src');
  fs.mkdirSync(blRepo, { recursive: true });
  // export the baseline tree (skills/ + installer/) without touching the working tree
  execFileSync('git', ['-C', REPO, 'archive', BASELINE_COMMIT], { stdio: ['ignore', fs.openSync(path.join(sandbox, '_bl.tar'), 'w'), 'pipe'] });
  execFileSync('tar', ['-xf', path.join(sandbox, '_bl.tar'), '-C', blRepo], { stdio: 'pipe' });
  const blInstaller = path.join(blRepo, 'installer', 'index.js');
  execFileSync(process.execPath, [blInstaller, '--tool', 'codex', '--target', sandbox], { stdio: 'pipe' });
}

(async () => {
  const tasks = loadTasks();
  const idsArg = arg('--ids', null);
  const ids = idsArg ? idsArg.split(',').map((s) => s.trim()) : (process.argv.includes('--all') ? tasks.map((t) => t.id) : null);
  if (!ids) { console.error('refusing to run: pass --ids T001,... or --all (a large paid run)'); process.exit(2); }
  const condsArg = arg('--conditions', null);
  const conditions = condsArg ? condsArg.split(',').map((s) => s.trim()) : ALL_CONDITIONS;
  const selected = tasks.filter((t) => ids.includes(t.id));

  // Isolated CODEX_HOME, proven clean before any paid call.
  const codexHome = prepareCodexHome(RUN_DIR);
  const leaks = assertNoGlobalLeak(codexHome);
  if (leaks.length) { console.error('ABORT: global instruction leak into CODEX_HOME:', leaks.join(', ')); process.exit(3); }
  console.log(`isolated CODEX_HOME ready (no global leak). baseline=${BASELINE_COMMIT.slice(0, 7)}  timeout=${TIMEOUT_MS}ms`);

  const results = [];
  for (const task of selected) {
    for (const condition of conditions) {
      const sandbox = fs.mkdtempSync(path.join(RUN_DIR, `sb-${task.id}-${condition}-`));
      fs.writeFileSync(path.join(sandbox, 'prompt.txt'), task.prompt, 'utf8');
      let setupErr = null;
      try { installSkills(condition, sandbox); } catch (e) { setupErr = String(e.message || e); }

      let adapterState, gradeStatus, reason, elapsed = 0;
      if (setupErr) { adapterState = 'SETUP_ERROR'; gradeStatus = 'NOT_RUN'; reason = setupErr; }
      else {
        const started = Date.now();
        const r = await runCodex(path.join(sandbox, 'prompt.txt'), sandbox, TIMEOUT_MS, codexHome);
        elapsed = Date.now() - started;
        adapterState = r.state;
        fs.writeFileSync(path.join(sandbox, 'output.txt'), r.output || '', 'utf8');
        if (r.state !== 'OK') { gradeStatus = 'NOT_RUN'; reason = `adapter state ${r.state}`; }
        else { const g = grade(task, r.output); gradeStatus = g.status; reason = g.reason; }
      }
      results.push({ id: task.id, category: task.category, critical: !!task.critical, condition, adapter_state: adapterState, grade: gradeStatus, reason, elapsed_ms: elapsed });
      console.log(`${task.id} [${task.category}${task.critical ? '/CRIT' : ''}] ${condition} state=${adapterState} grade=${gradeStatus} (${elapsed}ms) :: ${reason}`);
    }
  }

  const summary = { baseline_commit: BASELINE_COMMIT, conditions, ids, ran: results.length, run_dir: RUN_DIR, results };
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `scored-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log('\nDONE -> ' + outFile + '  (raw outputs in ' + RUN_DIR + ')');
})();
