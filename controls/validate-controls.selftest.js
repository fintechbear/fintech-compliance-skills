'use strict';
// Adversarial self-test for the zero-dep schema validator (R11). Proves the validator
// REJECTS known-bad inputs (missing field, wrong type, enum violation, extra field under
// additionalProperties:false, array minItems, $ref source_ref) and ACCEPTS the real catalog
// controls + profiles. Run: node controls/validate-controls.selftest.js  (also in CI).
const fs = require('fs');
const path = require('path');
const { validate } = require('./jsonschema.js');

const root = path.resolve(__dirname, '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const CONTROL = readJSON('controls/schema/control.schema.json');
const PROFILE = readJSON('controls/schema/profile.schema.json');

let n = 0, failed = 0;
const expectInvalid = (data, schema, label, needle) => {
  n++;
  const errs = validate(data, schema);
  if (errs.length === 0) { failed++; console.error(`  ✗ ${label}: expected INVALID but validator accepted it`); return; }
  if (needle && !errs.some((e) => e.includes(needle))) { failed++; console.error(`  ✗ ${label}: invalid but no error mentioned '${needle}': ${errs.join('; ')}`); return; }
  console.log(`  ✓ ${label}`);
};
const expectValid = (data, schema, label) => {
  n++;
  const errs = validate(data, schema);
  if (errs.length) { failed++; console.error(`  ✗ ${label}: expected VALID but got: ${errs.join('; ')}`); return; }
  console.log(`  ✓ ${label}`);
};

// A known-good control + profile to mutate.
const goodControl = {
  id: 'FCS-TEST-001', statement: 'A sufficiently long statement.', applicability: 'everywhere',
  control_type: 'preventive', source_refs: [{ kind: 'standard', label: 'X' }],
  review_status: 'needs_review', owner_role: 'engineering',
};
const goodProfile = readJSON('controls/profiles/tr-psp-postgres.json');

// ---- control schema ----
expectValid(goodControl, CONTROL, 'control: good control is valid');
expectInvalid({ ...goodControl, id: 'nope' }, CONTROL, 'control: bad id pattern', 'pattern');
expectInvalid({ ...goodControl, control_type: 'made_up' }, CONTROL, 'control: control_type not in enum', 'enum');
expectInvalid({ ...goodControl, review_status: 'green' }, CONTROL, 'control: review_status not in enum', 'enum');
expectInvalid({ ...goodControl, source_refs: [] }, CONTROL, 'control: source_refs below minItems', 'minItems');
expectInvalid({ ...goodControl, source_refs: [{ kind: 'gossip', label: 'x' }] }, CONTROL, 'control: source_ref kind not in enum ($ref enforced)', 'enum');
expectInvalid({ ...goodControl, source_refs: [{ kind: 'standard' }] }, CONTROL, 'control: source_ref missing required label ($ref enforced)', "required property 'label'");
expectInvalid({ ...goodControl, extra: 1 }, CONTROL, 'control: additionalProperties:false rejects extra field', "additional property 'extra'");
expectInvalid({ ...goodControl, statement: 'short' }, CONTROL, 'control: statement below minLength', 'minLength');
{ const c = { ...goodControl }; delete c.owner_role; expectInvalid(c, CONTROL, 'control: missing required owner_role', "required property 'owner_role'"); }
expectInvalid({ ...goodControl, statement: 123 }, CONTROL, 'control: wrong type for statement', 'expected type');

// ---- profile schema ----
expectValid(goodProfile, PROFILE, 'profile: real tr-psp profile is valid');
expectInvalid({ ...goodProfile, entity_role: { ...goodProfile.entity_role, kind: 'not-a-role' } }, PROFILE, 'profile: entity_role.kind not in enum', 'enum');
expectInvalid({ ...goodProfile, jurisdictions: ['NOPE'] }, PROFILE, 'profile: jurisdiction not in enum', 'enum');
expectInvalid({ ...goodProfile, unexpected_field: 123 }, PROFILE, 'profile: additionalProperties:false rejects extra field', "additional property 'unexpected_field'");
expectInvalid({ ...goodProfile, jurisdictions: [] }, PROFILE, 'profile: jurisdictions below minItems', 'minItems');
{ const p = JSON.parse(JSON.stringify(goodProfile)); delete p.entity_role; expectInvalid(p, PROFILE, 'profile: missing required entity_role', "required property 'entity_role'"); }
{ const p = JSON.parse(JSON.stringify(goodProfile)); delete p.entity_role.kind; expectInvalid(p, PROFILE, 'profile: entity_role missing required kind', "required property 'kind'"); }

// ---- R11 hardening: prototype names must NOT satisfy additionalProperties:false ----
// `'constructor' in props` is true for any object via Object.prototype; an own-property check
// is required or `constructor: 123` sails through. Same for toString/hasOwnProperty/__proto__.
for (const proto of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
  expectInvalid({ ...goodControl, [proto]: 123 }, CONTROL, `control: prototype name '${proto}' is an additional property, not a schema field`, `additional property '${proto}'`);
  expectInvalid({ ...goodProfile, [proto]: 123 }, PROFILE, `profile: prototype name '${proto}' is an additional property`, `additional property '${proto}'`);
}
// a schema that uses a keyword this validator does NOT enforce must be a hard failure,
// never a silent pass (R11: unknown keyword = clear boundary).
expectInvalid({ x: 1 }, { type: 'object', properties: { x: { type: 'integer', multipleOf: 2 } } }, 'schema: unsupported keyword multipleOf is refused, not ignored', "unsupported schema keyword 'multipleOf'");
expectInvalid({ x: 1 }, { type: 'object', not: { type: 'string' } }, 'schema: unsupported keyword not is refused', "unsupported schema keyword 'not'");

if (failed) { console.error(`\n${failed} of ${n} schema self-test checks FAILED.`); process.exit(1); }
console.log(`\nschema validator self-test: ${n} checks passed`);
