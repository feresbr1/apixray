/**
 * Learn the shape of JSON values from many samples, then turn it into a JSON Schema
 * (OpenAPI 3.1 flavour). Samples are merged incrementally: a field is required only when every
 * object had it, nullable when any sample was null, and so on.
 */

export type Kind = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';

export interface Shape {
  /** Values observed at this position (including nulls). */
  count: number;
  nulls: number;
  kinds: Set<Kind>;
  strings?: {
    values: Map<string, number>;
    formats: Map<string, number>;
    n: number;
    overflow: boolean;
  };
  objects?: number;
  props?: Map<string, Shape>;
  /** Objects whose keys are data (ids, dates) rather than field names. */
  map?: Shape;
  items?: Shape;
  example?: unknown;
  /** This position repeats an enclosing object (a tree): refer to it instead of nesting. */
  ref?: Shape;
  /** Set on shapes that are referenced: the component name. */
  refName?: string;
}

export interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema | boolean;
  items?: JsonSchema;
  examples?: unknown[];
  description?: string;
}

const MAX_TRACKED_STRINGS = 40;
const ID_KEY =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}.*|[0-9a-f]{24})$/i;

export function emptyShape(): Shape {
  return { count: 0, nulls: 0, kinds: new Set() };
}

export function detectFormat(s: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s))
    return 'date-time';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'date';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return 'uuid';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'email';
  if (/^https?:\/\/\S+$/.test(s)) return 'uri';
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return 'ipv4';
  return undefined;
}

/** Add one JSON value to a shape. */
export function observe(shape: Shape, value: unknown, depth = 0): Shape {
  shape.count++;
  if (value === null || value === undefined) {
    shape.nulls++;
    return shape;
  }
  if (shape.example === undefined) shape.example = value;
  if (depth > 40) return shape;
  if (Array.isArray(value)) {
    shape.kinds.add('array');
    shape.items ??= emptyShape();
    for (const item of value.slice(0, 200)) observe(shape.items, item, depth + 1);
    return shape;
  }
  switch (typeof value) {
    case 'string': {
      shape.kinds.add('string');
      const st = (shape.strings ??= {
        values: new Map(),
        formats: new Map(),
        n: 0,
        overflow: false,
      });
      st.n++;
      const f = detectFormat(value);
      if (f) st.formats.set(f, (st.formats.get(f) ?? 0) + 1);
      if (st.values.has(value)) st.values.set(value, st.values.get(value)! + 1);
      else if (st.values.size < MAX_TRACKED_STRINGS) st.values.set(value, 1);
      else st.overflow = true;
      return shape;
    }
    case 'number':
      shape.kinds.add(Number.isInteger(value) ? 'integer' : 'number');
      return shape;
    case 'boolean':
      shape.kinds.add('boolean');
      return shape;
    case 'object': {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);
      shape.kinds.add('object');
      // Keys that are ids or dates: a dictionary, not a record type.
      if (keys.length >= 2 && keys.every((k) => ID_KEY.test(k))) {
        shape.map ??= emptyShape();
        for (const k of keys) observe(shape.map, obj[k], depth + 1);
        shape.objects = (shape.objects ?? 0) + 1;
        return shape;
      }
      shape.objects = (shape.objects ?? 0) + 1;
      shape.props ??= new Map();
      for (const k of keys) {
        let p = shape.props.get(k);
        if (!p) {
          p = emptyShape();
          shape.props.set(k, p);
        }
        observe(p, obj[k], depth + 1);
      }
      return shape;
    }
  }
  return shape;
}

export function shapeOf(values: unknown[]): Shape {
  const s = emptyShape();
  for (const v of values) observe(s, v);
  return s;
}

/** Merge b into a (both describe the same position). */
export function mergeShapes(a: Shape, b: Shape): Shape {
  a.count += b.count;
  a.nulls += b.nulls;
  for (const k of b.kinds) a.kinds.add(k);
  if (a.example === undefined) a.example = b.example;
  if (b.strings) {
    const st = (a.strings ??= { values: new Map(), formats: new Map(), n: 0, overflow: false });
    st.n += b.strings.n;
    st.overflow ||= b.strings.overflow;
    for (const [f, n] of b.strings.formats) st.formats.set(f, (st.formats.get(f) ?? 0) + n);
    for (const [v, n] of b.strings.values) {
      if (st.values.has(v)) st.values.set(v, st.values.get(v)! + n);
      else if (st.values.size < MAX_TRACKED_STRINGS) st.values.set(v, n);
      else st.overflow = true;
    }
  }
  if (b.objects) a.objects = (a.objects ?? 0) + b.objects;
  if (b.props) {
    a.props ??= new Map();
    for (const [k, p] of b.props) {
      const mine = a.props.get(k);
      if (mine) mergeShapes(mine, p);
      else a.props.set(k, cloneShape(p));
    }
  }
  if (b.map) a.map = a.map ? mergeShapes(a.map, b.map) : cloneShape(b.map);
  if (b.items) a.items = a.items ? mergeShapes(a.items, b.items) : cloneShape(b.items);
  return a;
}

export function cloneShape(s: Shape): Shape {
  return mergeShapes(emptyShape(), s);
}

export interface SchemaOptions {
  /** Include an example value on leaf schemas. */
  examples?: boolean;
  /** Called on every example before it is written; return a replacement (redaction). */
  redact?: (key: string, value: unknown) => unknown;
  /** Receives named schemas for recursive structures (components/schemas). */
  components?: Map<string, JsonSchema>;
  /** Prefix for $ref values (default #/components/schemas/). */
  refPrefix?: string;
}

function refTo(target: Shape, opts: SchemaOptions): JsonSchema {
  const name = target.refName!;
  const components = (opts.components ??= new Map());
  if (!components.has(name)) {
    components.set(name, {}); // placeholder: stops infinite recursion
    components.set(name, toSchema(target, opts, '', true));
  }
  return { $ref: `${opts.refPrefix ?? '#/components/schemas/'}${name}` };
}

/** Convert a learned shape to JSON Schema. */
export function toSchema(
  shape: Shape,
  opts: SchemaOptions = {},
  key = '',
  asComponent = false,
): JsonSchema {
  if (shape.ref) return refTo(shape.ref, opts);
  if (shape.refName && !asComponent) return refTo(shape, opts);
  const kinds = [...shape.kinds];
  // integer + number is just number
  const types: string[] = kinds.includes('number') ? kinds.filter((k) => k !== 'integer') : kinds;
  const nullable = shape.nulls > 0;
  if (types.length === 0) return nullable ? { type: 'null' } : {};
  const schema: JsonSchema = {};
  const all = nullable ? [...types, 'null'] : types;
  schema.type = all.length === 1 ? all[0] : all;

  if (types.length === 1 && types[0] === 'string' && shape.strings) {
    const st = shape.strings;
    const formats = [...st.formats];
    if (formats.length === 1 && formats[0]![1] === st.n) schema.format = formats[0]![0];
    const distinct = st.values.size;
    const looksEnum =
      !st.overflow &&
      !schema.format &&
      distinct >= 2 &&
      distinct <= 8 &&
      st.n >= Math.max(4, distinct * 2) &&
      [...st.values.keys()].every((v) => v.length > 0 && v.length <= 32 && !/\s{2,}/.test(v));
    if (looksEnum && !isSensitiveKey(key)) schema.enum = [...st.values.keys()].sort();
  }

  if (types.includes('object')) {
    if (shape.map && !shape.props) {
      schema.additionalProperties = toSchema(shape.map, opts, key);
    } else if (shape.props) {
      schema.properties = {};
      const required: string[] = [];
      for (const [k, p] of shape.props) {
        schema.properties[k] = toSchema(p, opts, k);
        if (p.count === shape.objects) required.push(k);
      }
      if (required.length) schema.required = required;
    }
  }
  if (types.includes('array')) {
    schema.items =
      shape.items && shape.items.kinds.size + shape.items.nulls > 0
        ? toSchema(shape.items, opts, key)
        : {};
  }
  const leaf = !types.includes('object') && !types.includes('array');
  if (opts.examples && leaf && shape.example !== undefined && !schema.enum) {
    const ex = opts.redact ? opts.redact(key, shape.example) : shape.example;
    schema.examples = [ex];
  }
  return schema;
}

const SENSITIVE =
  /password|passwd|passphrase|^pass$|secret|token|api[-_]?key|apikey|^auth$|auth[-_]?(token|key|code)|authorization|session|cookie|credential|private[-_]?key|signature|^ssn$|cvv|card[-_]?number/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE.test(key);
}

function objectKeys(s: Shape): Set<string> {
  return new Set(s.props ? s.props.keys() : []);
}

/**
 * Trees (comments with replies, folders with children) nest the same object again and again.
 * Fold each repetition into its ancestor so the schema says "children: Comment[]" instead of
 * nesting 10 levels deep. Names come from the key that holds the repeating object.
 */
export function foldRecursion(root: Shape, rootName: string, names: Set<string>): void {
  const ancestors: { shape: Shape; key: string }[] = [];
  const nameFor = (key: string) => {
    let base = pascalName(singularWord(key)) || rootName;
    if (!/^[A-Za-z]/.test(base)) base = `T${base}`;
    let n = base;
    for (let i = 2; names.has(n); i++) n = `${base}${i}`;
    names.add(n);
    return n;
  };
  const visit = (shape: Shape, key: string, depth: number) => {
    if (depth > 60 || shape.ref) return;
    if (shape.props && shape.props.size >= 3) {
      const keys = objectKeys(shape);
      const match = ancestors.find((a) => similarity(objectKeys(a.shape), keys) >= 0.7);
      if (match) {
        // Merge the field names/types learned at this level, then point back at the ancestor.
        const copy = cloneShape(shape);
        copy.count = 0; // presence counts belong to the ancestor's parent, not to this level
        mergeShapes(match.shape, copy);
        match.shape.refName ??= nameFor(match.key || rootName);
        shape.ref = match.shape;
        delete shape.props;
        delete shape.items;
        delete shape.map;
        return;
      }
      ancestors.push({ shape, key });
      for (const [k, p] of shape.props) visit(p, k, depth + 1);
      ancestors.pop();
    } else if (shape.props) {
      for (const [k, p] of shape.props) visit(p, k, depth + 1);
    }
    if (shape.items) visit(shape.items, key, depth + 1);
    if (shape.map) visit(shape.map, key, depth + 1);
  };
  visit(root, '', 0);
}

function singularWord(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + 'y';
  if (/(ss|us|is)$/i.test(word)) return word;
  if (/(x|ch|sh)es$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word)) return word.slice(0, -1);
  return word;
}

function pascalName(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('');
}

/** Flattened "path:type" fingerprint of a shape, used to compare responses of different URLs. */
export function fingerprint(
  shape: Shape,
  prefix = '',
  depth = 0,
  out = new Set<string>(),
): Set<string> {
  if (depth > 3) return out;
  for (const k of shape.kinds) out.add(`${prefix}:${k === 'integer' ? 'number' : k}`);
  if (shape.props)
    for (const [k, p] of shape.props) fingerprint(p, `${prefix}.${k}`, depth + 1, out);
  if (shape.map) fingerprint(shape.map, `${prefix}.*`, depth + 1, out);
  if (shape.items) fingerprint(shape.items, `${prefix}[]`, depth + 1, out);
  return out;
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
