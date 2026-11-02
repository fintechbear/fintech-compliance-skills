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

const VALID_TYPE_NAMES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

// Validate the CONTRACT of each supported keyword in a schema node, in EVERY branch, so an
// unenforceable constraint (a dangling $ref, an invalid regex, a non-numeric minLength) fails
// closed at preflight instead of silently passing when today's data happens to omit that
// property (F12). This runs once over the whole schema tree before any data is checked.
function checkKeywordContracts(schema, where, root, errors) {
  // $ref must resolve against the root document, and (F12 round 3) the declared subset only
  // supports refs into #/definitions/<name> whose target is itself a schema (object or boolean).
  // A ref to '#/title', '#/default' or '#/definitions/x/type' points at a non-schema value and
  // would otherwise enforce nothing.
  if (owns(schema, '$ref')) {
    if (typeof schema.$ref !== 'string') errors.push(`${where}: $ref must be a string`);
    else if (!/^#\/definitions\/[^/]+$/.test(schema.$ref)) errors.push(`${where}: unsupported $ref '${schema.$ref}' (only '#/definitions/<name>' is supported)`);
    else {
      try {
        const target = resolveRef(schema.$ref, root);
        const isSchema = typeof target === 'boolean' || (target !== null && typeof target === 'object' && !Array.isArray(target));
        if (!isSchema) errors.push(`${where}: $ref '${schema.$ref}' does not point at a schema (got ${typeOf(target)})`);
      } catch (e) { errors.push(`${where}: ${e.message}`); }
    }
  }
  // type must name real JSON types.
  if (owns(schema, 'type')) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const t of types) if (!VALID_TYPE_NAMES.has(t)) errors.push(`${where}: unknown type '${t}'`);
  }
  // pattern must be a string that compiles to a valid RegExp.
  if (owns(schema, 'pattern')) {
    if (typeof schema.pattern !== 'string') errors.push(`${where}: pattern must be a string`);
    else { try { new RegExp(schema.pattern); } catch (e) { errors.push(`${where}: invalid pattern /${schema.pattern}/ (${e.message})`); } }
  }
  // minLength / minItems must be non-negative integers.
  for (const k of ['minLength', 'minItems']) {
    if (owns(schema, k) && !(Number.isInteger(schema[k]) && schema[k] >= 0)) errors.push(`${where}: ${k} must be a non-negative integer`);
  }
  // enum must be a non-empty array; required must be an array of strings.
  if (owns(schema, 'enum') && !(Array.isArray(schema.enum) && schema.enum.length)) errors.push(`${where}: enum must be a non-empty array`);
  if (owns(schema, 'required') && !(Array.isArray(schema.required) && schema.required.every((r) => typeof r === 'string'))) errors.push(`${where}: required must be an array of strings`);
  // F12 round 3: the SHAPE of every remaining supported keyword. A wrong-typed keyword would
  // otherwise make its constraint silently disappear (properties: [] enforces nothing).
  const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  for (const k of ['properties', 'definitions']) {
    if (owns(schema, k) && !isMap(schema[k])) errors.push(`${where}: ${k} must be an object map of subschemas (got ${typeOf(schema[k])})`);
  }
  if (owns(schema, 'additionalProperties')) {
    const ap = schema.additionalProperties;
    // true/false are enforced; an object subschema is reported by assertSupportedSchema as an
    // explicit unsupported boundary. Anything else (a string, a number, null, an array) is invalid.
    if (typeof ap !== 'boolean' && !isMap(ap)) errors.push(`${where}: additionalProperties must be a boolean (got ${typeOf(ap)})`);
  }
  if (owns(schema, 'type') && Array.isArray(schema.type) && schema.type.length === 0) errors.push(`${where}: type array must not be empty`);
  if (owns(schema, 'type') && !Array.isArray(schema.type) && typeof schema.type !== 'string') errors.push(`${where}: type must be a string or an array of strings`);
  if (owns(schema, 'items') && Array.isArray(schema.items)) errors.push(`${where}: tuple-form items (array) is not supported`);
  for (const k of ['$id', '$schema', '$comment', 'title', 'description']) {
    if (owns(schema, k) && typeof schema[k] !== 'string') errors.push(`${where}: ${k} must be a string`);
  }
}

// Preflight the entire schema, including optional/unvisited branches, so unsupported
// constraints never disappear just because today's data omitted the affected property.
function checkSchema(schema, where, root, errors, seen = new Set()) {
  if (typeof schema === 'boolean') return;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) { errors.push(`${where}: invalid schema`); return; }
  if (seen.has(schema)) return;
  seen.add(schema);
  assertSupportedSchema(schema, where, errors);
  checkKeywordContracts(schema, where, root, errors);
  for (const key of ['properties', 'definitions']) {
    const map = schema[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue; // shape error already reported
    for (const [name, sub] of Object.entries(map)) checkSchema(sub, `${where}/${key}/${name}`, root, errors, seen);
  }
  if (schema.items !== undefined && !Array.isArray(schema.items)) checkSchema(schema.items, `${where}/items`, root, errors, seen);
}
function validate(data, schema) {
  const errors = [];
  checkSchema(schema, '#', schema, errors);
  if (errors.length) return errors;
  try { validateNode(data, schema, schema, '', errors); }
  catch (e) { errors.push(`invalid/unsupported schema: ${e.message}`); }
  return errors;
}

module.exports = { validate };
