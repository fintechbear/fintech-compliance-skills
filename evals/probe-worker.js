'use strict';
// Trusted host runner. Candidate JavaScript executes ONLY in a QuickJS WASM VM.
// No host callbacks, module loader, process, filesystem, network or console are exposed.
// The candidate never receives expected answers and cannot write the host result channel.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { getQuickJS } = require('quickjs-emscripten');

async function main() {
  const { code, probe } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const engine = await getQuickJS();
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  const deadline = Date.now() + 1000;
  let interrupted = false;
  runtime.setInterruptHandler(() => { interrupted ||= Date.now() > deadline; return interrupted; });
  const vm = runtime.newContext();
  let exportsHandle, fn;
  try {
    exportsHandle = vm.unwrapResult(vm.evalCode(code, 'candidate.mjs', { type: 'module' }));
    fn = vm.getProp(exportsHandle, probe.export);
    if (vm.typeof(fn) !== 'function') throw new Error('required synchronous function export missing');
    for (const test of probe.cases) {
      const args = test.args.map(value => vm.unwrapResult(vm.evalCode(`(${JSON.stringify(value)})`)));
      try {
        const result = vm.callFunction(fn, vm.undefined, ...args);
        if (result.error) {
          result.error.dispose();
          if (!test.throws || interrupted) throw new Error('candidate threw unexpectedly or exceeded budget');
        } else {
          try {
            if (test.throws) throw new Error('candidate did not reject the input');
            // QuickJS dump can call guest toJSON. Check the actual guest primitive type
            // first, so an object masquerading as the expected number cannot pass.
            const expectedType = test.expected === null ? 'object' : typeof test.expected;
            if (test.expected === null && !vm.eq(result.value, vm.null)) throw new Error('wrong null return');
            if (test.expected !== null && expectedType === 'object') throw new Error('only primitive expected results are supported');
            if (vm.typeof(result.value) !== expectedType) throw new Error('wrong return type');
            assert.deepStrictEqual(vm.dump(result.value), test.expected);
          } finally { result.value.dispose(); }
        }
      } finally { args.forEach(arg => arg.dispose()); }
    }
    if (interrupted) throw new Error('candidate exceeded budget');
    process.stdout.write(JSON.stringify({ passed: true }));
  } finally {
    fn?.dispose(); exportsHandle?.dispose(); vm.dispose(); runtime.dispose();
  }
}
main().catch(() => { process.stderr.write('behavioural probe failed\n'); process.exitCode = 1; });
