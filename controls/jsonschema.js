'use strict';
// Minimal JSON Schema (draft-07 SUBSET) validator — zero dependencies, Node built-ins only.
// Supports exactly the keywords the FCS catalog/profile schemas use:
//   type (incl. ["string","null"]), required, properties, additionalProperties:false,
//   enum, pattern, minLength, minItems, items, $ref ("#/definitions/..."), default (ignored).
// It is intentionally small and strict: an unsupported keyword is rejected, but the keywords
// above are ENFORCED (unlike the old ad-hoc checks). Returns an array of error strings
// ([] = valid). Paths are JSON-pointer-ish for readable messages.
//
// This is NOT a general-purpose validator; it is enough to actually enforce these schemas,
// which the previous hand-rolled shape checks did not (R11).

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v; // string | number | boolean | object
}
function matchesType(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  if (t === 'integer') return actual === 'integer';
  return actual === t;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
  let node = root;
  for (const seg of ref.slice(2).split('/')) {
    const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    node = node && Object.prototype.hasOwnProperty.call(node, key) ? node[key] : undefined;
    if (node === undefined) throw new Error(`$ref not found: ${ref}`);
  }
  return node;
}

// Own-property test that is immune to the prototype chain: `'constructor' in obj` is TRUE for
// any plain object (Object.prototype), which let `constructor: 123` sail through an
// additionalProperties:false check that used `key in props`. (R11)
const owns = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Keywords this SUBSET validator actually enforces. Anything else in a schema is NOT silently
// ignored — it is a hard error, so a schema that relies on an unsupported keyword cannot pass
// by accident (R11: "unknown keyword / unsupported schema must be a clear boundary/failure").
const SUPPORTED_KEYWORDS = new Set([
  '$ref', '$id', '$schema', '$comment', 'title', 'description', 'default',
  'type', 'required', 'properties', 'additionalProperties',
  'enum', 'pattern', 'minLength', 'minItems', 'items', 'definitions',
]);
function assertSupportedSchema(schema, where, errors) {
  if (!schema || typeof schema !== 'object') return;
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      errors.push(`${where}: unsupported schema keyword '${key}' (this validator does not enforce it — refusing to pass silently)`);
    }
    if (key === 'additionalProperties' && schema.additionalProperties !== false && typeof schema.additionalProperties === 'object') {
      errors.push(`${where}: additionalProperties as a subschema is not supported (only false)`);
    }
  }
}

function validateNode(data, schema, root, pathStr, errors) {
  if (schema === true) return;
  if (schema === false) { errors.push(`${pathStr}: false schema rejects every value`); return; }
  if (schema.$ref) { validateNode(data, resolveRef(schema.$ref, root), root, pathStr, errors); return; }
  // R11: refuse to pass a schema that leans on a keyword we do not enforce.
  assertSupportedSchema(schema, `schema@${pathStr || '#'}`, errors);

  // type
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(data, t))) {
      errors.push(`${pathStr}: expected type ${types.join('|')}, got ${typeOf(data)}`);
      return; // further checks are meaningless on the wrong type
    }
  }
  // enum
  if (schema.enum !== undefined && !schema.enum.some((e) => e === data)) {
    errors.push(`${pathStr}: value ${JSON.stringify(data)} not in enum [${schema.enum.join(', ')}]`);
  }
  // string facets
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) errors.push(`${pathStr}: shorter than minLength ${schema.minLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(data)) errors.push(`${pathStr}: does not match pattern ${schema.pattern}`);
  }
  // array facets
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) errors.push(`${pathStr}: fewer than minItems ${schema.minItems}`);
    if (schema.items !== undefined) data.forEach((item, i) => validateNode(item, schema.items, root, `${pathStr}[${i}]`, errors));
  }
  // object facets — all property tests use OWN-property checks so a prototype name
  // (constructor, toString, hasOwnProperty, __proto__) can never masquerade as a schema field.
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const req of (schema.required || [])) {
      if (!owns(data, req)) errors.push(`${pathStr}: missing required property '${req}'`);
    }
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) { // Object.keys = own enumerable only
        if (!owns(props, key)) errors.push(`${pathStr}: additional property '${key}' is not allowed`);
      }
    }
    for (const key of Object.keys(props)) {
      if (owns(data, key)) validateNode(data[key], props[key], root, `${pathStr === '' ? '' : pathStr}/${key}`, errors);
    }
  }
}

// Preflight the entire schema, including optional/unvisited branches, so unsupported
// constraints never disappear just because today's data omitted the affected property.
function checkSchema(schema, where, errors, seen = new Set()) {
  if (typeof schema === 'boolean') return;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) { errors.push(`${where}: invalid schema`); return; }
  if (seen.has(schema)) return;
  seen.add(schema);
  assertSupportedSchema(schema, where, errors);
  for (const key of ['properties', 'definitions']) {
    for (const [name, sub] of Object.entries(schema[key] || {})) checkSchema(sub, `${where}/${key}/${name}`, errors, seen);
  }
  if (schema.items !== undefined) checkSchema(schema.items, `${where}/items`, errors, seen);
}
function validate(data, schema) {
  const errors = [];
  checkSchema(schema, '#', errors);
  if (errors.length) return errors;
  try { validateNode(data, schema, schema, '', errors); }
  catch (e) { errors.push(`invalid/unsupported schema: ${e.message}`); }
  return errors;
}

module.exports = { validate };
