'use strict';
// Validate every eval task against evals/task.schema.json using the SAME hardened zero-dep
// validator the control catalog uses (R11/D4: eval tasks are validated by a real schema, not
// trusted by hand). Also enforces a couple of cross-field invariants the schema cannot express:
//   - a code_invariant task SHOULD carry an exec_probe OR be explicitly review-only,
//   - ids are unique and sequential-ish (no duplicates),
//   - an exec_probe harness must import ./candidate.mjs (so it actually runs the model's code).
const fs = require('fs');
const path = require('path');
const { validate } = require('../controls/jsonschema.js');

const here = __dirname;
const schema = JSON.parse(fs.readFileSync(path.join(here, 'task.schema.json'), 'utf8'));
const lines = fs.readFileSync(path.join(here, 'tasks.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);

const errors = [];
const seen = new Set();
let count = 0;
for (const line of lines) {
  count++;
  let t;
  try { t = JSON.parse(line); } catch (e) { errors.push(`line ${count}: not valid JSON: ${e.message}`); continue; }
  for (const e of validate(t, schema)) errors.push(`${t.id || `line ${count}`}${e}`);
  if (seen.has(t.id)) errors.push(`duplicate task id ${t.id}`);
  seen.add(t.id);
  if (t.grader && t.grader.kind === 'code_invariant') {
    if (!t.grader.exec_probe) errors.push(`${t.id}: code_invariant without an exec_probe (a keyword probe is not accepted — R04)`);
    else if (!/candidate\.mjs/.test(t.grader.exec_probe.harness)) errors.push(`${t.id}: exec_probe harness does not import ./candidate.mjs (it would not run the model's code)`);
  }
}

if (errors.length) {
  console.error(`eval-task validation FAILED (${errors.length}):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`eval-task validation: ${count} tasks valid against task.schema.json`);
