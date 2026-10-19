import type { JsonSchema } from '../core/shape';

type Components = Record<string, JsonSchema>;

function refName(ref: string): string {
  return ref.split('/').pop()!;
}

function typeLabel(s: JsonSchema, components: Components): string {
  if (s.$ref) return refName(s.$ref);
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  const nonNull = types.filter((t) => t !== 'null');
  let label = nonNull
    .map((t) => {
      if (t === 'array') {
        const item = s.items ?? {};
        return `${typeLabel(item, components) || 'any'}[]`;
      }
      if (t === 'object' && s.additionalProperties && typeof s.additionalProperties === 'object') {
        return `map<string, ${typeLabel(s.additionalProperties, components) || 'any'}>`;
      }
      return t;
    })
    .join(' | ');
  if (!label) label = types.includes('null') ? 'null' : 'any';
  return label;
}

function children(s: JsonSchema, components: Components): JsonSchema | undefined {
  if (s.properties) return s;
  if (s.items) return children(s.items, components);
  if (s.additionalProperties && typeof s.additionalProperties === 'object') {
    return children(s.additionalProperties, components);
  }
  return undefined;
}

/** A schema as a readable tree: name, type, format, enum values, required and nullable marks. */
export function SchemaView({
  schema,
  components,
  depth = 0,
  seen = new Set<string>(),
}: {
  schema: JsonSchema;
  components: Components;
  depth?: number;
  seen?: Set<string>;
}) {
  const resolved = schema.$ref ? components[refName(schema.$ref)] : schema;
  if (!resolved) return <span class="muted">unknown</span>;
  const node = children(resolved, components);
  if (!node?.properties) {
    return (
      <div class="schema-root">
        <Type schema={schema} components={components} />
      </div>
    );
  }
  return (
    <ul class={`schema ${depth === 0 ? 'schema-top' : ''}`}>
      {depth === 0 && (
        <li class="schema-head">
          <Type schema={schema} components={components} />
        </li>
      )}
      {Object.entries(node.properties).map(([name, prop]) => (
        <Field
          key={name}
          name={name}
          schema={prop}
          required={node.required?.includes(name) ?? false}
          components={components}
          depth={depth}
          seen={seen}
        />
      ))}
    </ul>
  );
}

function Type({ schema, components }: { schema: JsonSchema; components: Components }) {
  const resolved = schema.$ref ? (components[refName(schema.$ref)] ?? schema) : schema;
  const types =
    resolved.type === undefined
      ? []
      : Array.isArray(resolved.type)
        ? resolved.type
        : [resolved.type];
  return (
    <span class="type">
      <code class="t">{typeLabel(schema, components)}</code>
      {resolved.format && <span class="fmt">{resolved.format}</span>}
      {types.includes('null') && types.length > 1 && <span class="nullable">nullable</span>}
      {resolved.enum && (
        <span class="enum">
          {resolved.enum.map((v) => (
            <code key={String(v)}>{JSON.stringify(v)}</code>
          ))}
        </span>
      )}
    </span>
  );
}

function Field({
  name,
  schema,
  required,
  components,
  depth,
  seen,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  components: Components;
  depth: number;
  seen: Set<string>;
}) {
  const ref = schema.$ref ?? (schema.items?.$ref as string | undefined);
  const resolved = schema.$ref ? (components[refName(schema.$ref)] ?? schema) : schema;
  const nested = children(resolved, components);
  const recursive = ref ? seen.has(ref) : false;
  const head = (
    <>
      <code class="name">{name}</code>
      {!required && (
        <span class="opt" title="Missing in some captured samples">
          optional
        </span>
      )}
      <Type schema={schema} components={components} />
    </>
  );
  if (!nested?.properties || depth > 8) return <li class="field">{head}</li>;
  if (recursive) {
    return (
      <li class="field">
        {head} <span class="muted">(same shape as above)</span>
      </li>
    );
  }
  const nextSeen = new Set(seen);
  if (ref) nextSeen.add(ref);
  return (
    <li class="field">
      <details open={depth < 1}>
        <summary>{head}</summary>
        <SchemaView schema={nested} components={components} depth={depth + 1} seen={nextSeen} />
      </details>
    </li>
  );
}
