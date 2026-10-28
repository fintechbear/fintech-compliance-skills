// FAILING-FIRST probe for R10-B1 (webhook short/garbled signature => RangeError).
// Loads the BASE (654018e) webhook.ts with its auto-run main() stripped (the function
// bodies are the ORIGINAL code — logic is not rewritten), then calls the base
// receiveWebhook with a too-short signature and asserts it THROWS a RangeError that
// escapes to the caller (the bug). Exits 0 only if the bug is reproduced.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const BL = process.env.BL!;
const src = fs.readFileSync(path.join(BL, 'webhook.ts'), 'utf8');

// Strip the module's own `main()` auto-invocation so importing it does not run the suite.
// We keep every function body verbatim; we only neutralise the trailing `main().catch(...)`.
let patched = src.replace(/main\(\)\.catch\([\s\S]*$/, '');
// Re-export receiveWebhook + provider so the probe can call them (base did not export them).
patched += `\nexport { receiveWebhook, provider };\n`;

const tmp = path.join(BL, '_probe_webhook_base.ts');
fs.writeFileSync(tmp, patched, 'utf8');

const mod = await import(url.pathToFileURL(tmp).href);
const { receiveWebhook, provider } = mod as any;

const ts = 1_000_000;
const raw = JSON.stringify({ event_id: 'bp1', business_id: 'biz1', tenant_id: 'T1' });

let reproduced = false;
let detail = '';
try {
  // base signature verb: receiveWebhook(provider, rawBody, ts, sig, nowTs)
  await receiveWebhook('double', raw, ts, 'ab', ts); // too-short signature
  detail = 'base returned normally (no throw) — if it returned bad_signature the bug is already fixed';
} catch (e: any) {
  if (e && e.constructor && /RangeError/.test(e.constructor.name)) {
    reproduced = true;
    detail = `base threw ${e.constructor.name}: ${e.message}`;
  } else {
    detail = `base threw a non-RangeError: ${e && e.message}`;
  }
}

fs.rmSync(tmp, { force: true });
console.log(`  [r10] ${detail}`);
process.exit(reproduced ? 0 : 1);
