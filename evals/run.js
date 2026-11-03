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
// R05: the sandbox is the agent's CWD. Baseline materialisation (git archive + tar + the
// baseline installer source) is done in `prepDir`, which lives OUTSIDE the sandbox so the
// agent can never read the baseline source tree, the grader, answers, or other conditions.
// Only the INSTALLED output (AGENTS.md + tree) ever lands in the sandbox.
function installSkills(condition, sandbox, prepDir) {
  if (condition === 'WITHOUT_SKILLS') return;
  if (condition === 'CANDIDATE') {
    execFileSync(process.execPath, [INSTALLER, '--tool', 'codex', '--target', sandbox], { stdio: 'pipe' });
    return;
  }
  // CURRENT_BASELINE: materialize the baseline skills/ from git into prepDir (NOT the sandbox),
  // then run THAT commit's installer with --target the sandbox so only the install lands there.
  const blRepo = path.join(prepDir, 'baseline_src');
  fs.mkdirSync(blRepo, { recursive: true });
  const tar = path.join(prepDir, 'bl.tar');
  execFileSync('git', ['-C', REPO, 'archive', BASELINE_COMMIT], { stdio: ['ignore', fs.openSync(tar, 'w'), 'pipe'] });
  execFileSync('tar', ['-xf', tar, '-C', blRepo], { stdio: 'pipe' });
  const blInstaller = path.join(blRepo, 'installer', 'index.js');
  execFileSync(process.execPath, [blInstaller, '--tool', 'codex', '--target', sandbox], { stdio: 'pipe' });
}

// Best-effort provenance for the run manifest. Missing values are null, never invented.
function gitRev(ref) { try { return execFileSync('git', ['-C', REPO, 'rev-parse', ref], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } }
function codexVersion() { try { return execFileSync(process.platform === 'win32' ? 'powershell.exe' : 'bash', process.platform === 'win32' ? ['-NoProfile', '-Command', 'codex --version'] : ['-lc', 'codex --version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } }
function treeHash(dir) {
  // stable hash of the installed skill surface the agent saw (sorted rel path + content hash)
  const crypto = require('crypto'); const h = crypto.createHash('sha256'); const files = [];
  const walk = (d, rel) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const r = rel ? `${rel}/${e.name}` : e.name; const abs = path.join(d, e.name); if (e.isDirectory()) walk(abs, r); else files.push([r, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16)]); } };
  walk(dir, ''); for (const [r, hh] of files) h.update(`${r}:${hh}\n`); return files.length ? h.digest('hex').slice(0, 16) : null;
}

(async () => {
  const tasks = loadTasks();
  const idsArg = arg('--ids', null);
  const ids = idsArg ? idsArg.split(',').map((s) => s.trim()) : (process.argv.includes('--all') ? tasks.map((t) => t.id) : null);
  if (!ids) { console.error('refusing to run: pass --ids T001,... or --all (a large paid run)'); process.exit(2); }
  const condsArg = arg('--conditions', null);
  const conditions = condsArg ? condsArg.split(',').map((s) => s.trim()) : ALL_CONDITIONS;
  const selected = tasks.filter((t) => ids.includes(t.id));

  // Provenance pinned ONCE for the whole run (same for every task/condition).
  const candidateSha = gitRev('HEAD');
  const baselineSha = gitRev(BASELINE_COMMIT) || BASELINE_COMMIT;
  const cliVersion = codexVersion();
  const startedRun = new Date().toISOString();

  // Prove isolation ONCE up front against a representative home (fail fast before any paid
  // call), then give EACH run its OWN fresh home so no state carries between conditions.
  {
    const probe = prepareCodexHome(path.join(RUN_DIR, 'home-probe'));
    const leaks = assertNoGlobalLeak(probe.dest);
    if (leaks.length) { console.error('ABORT: global instruction leak into CODEX_HOME:', leaks.join(', ')); process.exit(3); }
  }
  console.log(`isolated CODEX_HOME verified clean. baseline=${baselineSha.slice(0, 7)} candidate=${(candidateSha || '?').slice(0, 7)} cli=${cliVersion || 'unknown'} timeout=${TIMEOUT_MS}ms`);

  const results = [];
  let runIdx = 0;
  for (const task of selected) {
    for (const condition of conditions) {
      runIdx++;
      // Per-run roots: sandbox = agent CWD; prep (baseline source) and home are SEPARATE
      // and never under the sandbox, so the agent cannot read them. Fresh home EACH run.
      const runRoot = fs.mkdtempSync(path.join(RUN_DIR, `run-${runIdx}-${task.id}-${condition}-`));
      const sandbox = path.join(runRoot, 'sandbox'); fs.mkdirSync(sandbox, { recursive: true });
      const prepDir = path.join(runRoot, 'prep'); fs.mkdirSync(prepDir, { recursive: true });
      const home = prepareCodexHome(runRoot); // fresh, isolated, per-run
      const homeLeaks = assertNoGlobalLeak(home.dest);

      fs.writeFileSync(path.join(sandbox, 'prompt.txt'), task.prompt, 'utf8');
      let setupErr = homeLeaks.length ? `CODEX_HOME leak: ${homeLeaks.join(', ')}` : null;
      if (!setupErr) { try { installSkills(condition, sandbox, prepDir); } catch (e) { setupErr = String(e.message || e); } }

      let adapterState, gradeStatus, reason, elapsed = 0;
      const surfaceHash = treeHash(path.join(sandbox, '.fintech-compliance-skills'));
      if (setupErr) { adapterState = 'SETUP_ERROR'; gradeStatus = 'NOT_RUN'; reason = setupErr; }
      else {
        const started = Date.now();
        const r = await runCodex(path.join(sandbox, 'prompt.txt'), sandbox, TIMEOUT_MS, home.dest);
        elapsed = Date.now() - started;
        adapterState = r.state;
        fs.writeFileSync(path.join(sandbox, 'output.txt'), r.output || '', 'utf8');
        if (r.state !== 'OK') { gradeStatus = 'NOT_RUN'; reason = `adapter state ${r.state}`; }
        else { const g = grade(task, r.output); gradeStatus = g.status; reason = g.reason; }
      }
      results.push({
        id: task.id, category: task.category, critical: !!task.critical, condition,
        adapter_state: adapterState, grade: gradeStatus, reason, elapsed_ms: elapsed,
        candidate_sha: candidateSha, baseline_sha: baselineSha,
        installed_surface_hash: surfaceHash, // what skill surface the agent actually saw
        cli_version: cliVersion,
        token_usage: null, // not reported by this adapter path -> null, never invented
        home_kept_config: home.kept,
      });
      console.log(`${task.id} [${task.category}${task.critical ? '/CRIT' : ''}] ${condition} state=${adapterState} grade=${gradeStatus} (${elapsed}ms) surface=${surfaceHash || 'none'} :: ${reason}`);
    }
  }

  const manifest = {
    schema: 'fcs-eval-run/1',
    started_at: startedRun, finished_at: new Date().toISOString(),
    candidate_sha: candidateSha, baseline_sha: baselineSha, baseline_commit: BASELINE_COMMIT,
    cli_version: cliVersion, timeout_ms: TIMEOUT_MS,
    conditions, ids, ran: results.length, run_dir: RUN_DIR,
    token_usage_available: false, // this adapter path does not surface token counts
    results,
  };
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `scored-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2));
  console.log('\nDONE -> ' + outFile + '  (raw outputs in ' + RUN_DIR + ')');
})();
