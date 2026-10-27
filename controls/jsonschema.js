'use strict';
// Minimal JSON Schema (draft-07 SUBSET) validator — zero dependencies, Node built-ins only.
// Supports exactly the keywords the FCS catalog/profile schemas use:
//   type (incl. ["string","null"]), required, properties, additionalProperties:false,
//   enum, pattern, minLength, minItems, items, $ref ("#/definitions/..."), default (ignored).
// It is intentionally small and strict: an unsupported keyword is ignored, but the keywords
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
    node = node[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`$ref not found: ${ref}`);
  }
  return node;
}

function validateNode(data, schema, root, pathStr, errors) {
  if (schema.$ref) { validateNode(data, resolveRef(schema.$ref, root), root, pathStr, errors); return; }

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
    if (schema.items) data.forEach((item, i) => validateNode(item, schema.items, root, `${pathStr}[${i}]`, errors));
  }
  // object facets
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const req of (schema.required || [])) {
      if (!(req in data)) errors.push(`${pathStr}: missing required property '${req}'`);
    }
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!(key in props)) errors.push(`${pathStr}: additional property '${key}' is not allowed`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in data) validateNode(data[key], sub, root, `${pathStr === '' ? '' : pathStr}/${key}`, errors);
    }
  }
}

// Validate `data` against `schema`. Returns an array of error messages ([] = valid).
function validate(data, schema) {
  const errors = [];
  validateNode(data, schema, schema, '', errors);
  return errors;
}

module.exports = { validate };
