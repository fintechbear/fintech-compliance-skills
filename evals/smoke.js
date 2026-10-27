'use strict';
// Smoke runner: 3 representative tasks, ONE worker, condition WITHOUT_SKILLS, against the
// REAL codex CLI. Bounded: per-task timeout, no retries, no improvement loop. Writes a
// JSON result to the isolated run dir (path from FCS_RUN_DIR) — raw outputs stay there,
// not in the repo. This is a SMOKE, not the full 40-task eval.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runCodex } = require('./adapters/codex.js');
const { grade } = require('./grader.js');

const SMOKE_IDS = ['T016', 'T026', 'T036']; // dangerous / scope-ambiguity / off-topic
const TIMEOUT_MS = Number(process.env.FCS_TASK_TIMEOUT_MS || 120000);
const RUN_DIR = process.env.FCS_RUN_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-smoke-'));

function loadTasks() {
  const lines = fs.readFileSync(path.join(__dirname, 'tasks.jsonl'), 'utf8').split('\n').filter(Boolean);
  return lines.map(JSON.parse);
}

(async () => {
  const tasks = loadTasks().filter(t => SMOKE_IDS.includes(t.id));
  const results = [];
  for (const task of tasks) {
    // WITHOUT_SKILLS: a bare sandbox with ONLY the prompt. No skill files, no AGENTS.md.
    const sandbox = fs.mkdtempSync(path.join(RUN_DIR, `sb-${task.id}-`));
    const promptFile = path.join(sandbox, 'prompt.txt');
    fs.writeFileSync(promptFile, task.prompt, 'utf8');

    const started = Date.now();
    const r = await runCodex(promptFile, sandbox, TIMEOUT_MS);
    const elapsed = Date.now() - started;

    let graded;
    if (r.state !== 'OK') {
      graded = { status: 'NOT_RUN', reason: `adapter state ${r.state}` };
    } else {
      graded = grade(task, r.output);
    }
    // persist the raw output in the isolated run dir only
    fs.writeFileSync(path.join(sandbox, 'output.txt'), r.output || '', 'utf8');
    results.push({ id: task.id, category: task.category, condition: 'WITHOUT_SKILLS',
      adapter_state: r.state, grade: graded.status, reason: graded.reason, elapsed_ms: elapsed });
    console.log(`${task.id} [${task.category}] state=${r.state} grade=${graded.status} (${elapsed}ms) :: ${graded.reason}`);
  }
  const summary = { condition: 'WITHOUT_SKILLS', ran: results.length, run_dir: RUN_DIR, results };
  fs.writeFileSync(path.join(RUN_DIR, 'smoke-result.json'), JSON.stringify(summary, null, 2));
  console.log('\nSMOKE DONE -> ' + path.join(RUN_DIR, 'smoke-result.json'));
})();
