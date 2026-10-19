import { useEffect, useMemo, useState } from 'preact/hooks';
import { analyze, type ApiModel, type Endpoint } from '../core/analyze';
import { toCurl } from '../core/curl';
import type { Har } from '../core/har';
import { toOpenApi } from '../core/openapi';
import type { JsonSchema } from '../core/shape';
import { toTypeScript } from '../core/typescript';
import { toYaml } from '../core/yaml';
import { SchemaView } from './SchemaView';

export interface Capture {
  name: string;
  har: Har;
}

type Doc = Record<string, unknown>;

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      class="btn small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

function Method({ m }: { m: string }) {
  return <span class={`method m-${m.toLowerCase()}`}>{m}</span>;
}

export function Explorer({ capture, onClose }: { capture: Capture; onClose: () => void }) {
  // First pass with every origin, to list them all (telemetry included, off by default).
  const all = useMemo(() => analyze(capture.har, { includeNoise: true }), [capture]);
  const defaults = useMemo(() => {
    const base = analyze(capture.har);
    return new Set(base.endpoints.flatMap((e) => e.servers.map((s) => new URL(s).origin)));
  }, [capture]);
  const [origins, setOrigins] = useState<Set<string>>(defaults);
  const [examples, setExamples] = useState(true);
  const [redact, setRedact] = useState(true);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'endpoint' | 'spec' | 'client'>('endpoint');

  useEffect(() => {
    setOrigins(defaults);
    setExcluded(new Set());
    setSelected(null);
  }, [defaults]);

  const model: ApiModel = useMemo(
    () => analyze(capture.har, { origins: [...origins] }),
    [capture, origins],
  );
  const include = useMemo(
    () => new Set(model.endpoints.filter((e) => !excluded.has(e.id)).map((e) => e.id)),
    [model, excluded],
  );
  const doc = useMemo(
    () => toOpenApi(model, { examples, redact, include }),
    [model, examples, redact, include],
  );
  const fullDoc = useMemo(() => toOpenApi(model, { examples, redact }), [model, examples, redact]);
  const yaml = useMemo(() => (view === 'spec' ? toYaml(doc) : ''), [doc, view]);
  const client = useMemo(
    () => (view === 'client' ? toTypeScript(model, { include }) : ''),
    [model, include, view],
  );

  const q = query.trim().toLowerCase();
  const visible = model.endpoints.filter(
    (e) => !q || `${e.method} ${e.path} ${e.operationId} ${e.site}`.toLowerCase().includes(q),
  );
  const current = model.endpoints.find((e) => e.id === selected) ?? visible[0];
  const tags = new Map<string, Endpoint[]>();
  for (const e of visible) {
    const key = `${e.site} · ${e.tag}`;
    tags.set(key, [...(tags.get(key) ?? []), e]);
  }
  const components = ((fullDoc.components as Doc | undefined)?.schemas ?? {}) as Record<
    string,
    JsonSchema
  >;
  const hostsUsed = new Set(model.endpoints.flatMap((e) => e.servers.map((s) => new URL(s).host)));

  return (
    <div class="explorer">
      <div class="xbar">
        <div class="xbar-title">
          <h1>
            <span class="file">{capture.name}</span>
          </h1>
          <p class="stats" data-testid="stats">
            {model.stats.apiCalls} API calls →{' '}
            <b>
              {model.endpoints.length} {model.endpoints.length === 1 ? 'endpoint' : 'endpoints'}
            </b>{' '}
            on {hostsUsed.size} {hostsUsed.size === 1 ? 'host' : 'hosts'} · {model.stats.entries}{' '}
            requests captured
          </p>
        </div>
        <div class="xbar-actions">
          <button
            type="button"
            class="btn primary"
            onClick={() => download('openapi.yaml', toYaml(doc), 'application/yaml')}
            disabled={include.size === 0}
          >
            Download openapi.yaml
          </button>
          <button
            type="button"
            class="btn"
            onClick={() =>
              download('openapi.json', `${JSON.stringify(doc, null, 2)}\n`, 'application/json')
            }
            disabled={include.size === 0}
          >
            JSON
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => download('client.ts', toTypeScript(model, { include }), 'text/plain')}
            disabled={include.size === 0}
          >
            client.ts
          </button>
          <button type="button" class="btn ghost" onClick={onClose}>
            Open another
          </button>
        </div>
      </div>

      <div class="controls">
        <fieldset class="origins">
          <legend>Hosts</legend>
          {all.origins.map((o) => {
            const on = origins.has(o.origin);
            return (
              <label key={o.origin} class={`chip ${on ? 'on' : ''} ${o.noise ? 'noise' : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const next = new Set(origins);
                    if (on) next.delete(o.origin);
                    else next.add(o.origin);
                    setOrigins(next);
                  }}
                />
                {new URL(o.origin).host}
                <span class="count">{o.calls}</span>
                {o.noise && <span class="tag">telemetry</span>}
              </label>
            );
          })}
        </fieldset>
        <div class="toggles">
          <label>
            <input type="checkbox" checked={examples} onChange={() => setExamples(!examples)} />{' '}
            Real examples
          </label>
          <label>
            <input type="checkbox" checked={redact} onChange={() => setRedact(!redact)} /> Redact
            secrets &amp; e-mails
          </label>
        </div>
      </div>

      {model.endpoints.length === 0 ? (
        <div class="empty" role="status">
          <h2>No API calls in this selection</h2>
          <p>
            Select a host above, or capture again with the Network tab open while you use the app.
            Only XHR/fetch calls and JSON responses count; pages, scripts and images are skipped.
          </p>
        </div>
      ) : (
        <div class="xgrid">
          <nav class="sidebar" aria-label="Endpoints">
            <label class="sr-only" for="ep-search">
              Filter endpoints
            </label>
            <input
              id="ep-search"
              type="search"
              placeholder="Filter endpoints…"
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <div class="tabs" role="tablist">
              {(['endpoint', 'spec', 'client'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  class={view === v ? 'on' : ''}
                  onClick={() => setView(v)}
                >
                  {v === 'endpoint' ? 'Endpoints' : v === 'spec' ? 'OpenAPI' : 'TypeScript'}
                </button>
              ))}
            </div>
            {[...tags].map(([tag, eps]) => (
              <div class="group" key={tag}>
                <h3>{tag}</h3>
                <ul>
                  {eps.map((e) => (
                    <li
                      key={e.id}
                      class={current?.id === e.id && view === 'endpoint' ? 'active' : ''}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Include ${e.method} ${e.path} in the export`}
                        checked={!excluded.has(e.id)}
                        onChange={() => {
                          const next = new Set(excluded);
                          if (next.has(e.id)) next.delete(e.id);
                          else next.add(e.id);
                          setExcluded(next);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(e.id);
                          setView('endpoint');
                        }}
                      >
                        <Method m={e.method} />
                        <span class="p">{e.path}</span>
                        <span class="n">{e.samples.length}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>

          <section class="detail" aria-live="polite">
            {view === 'spec' && (
              <div class="code-panel">
                <div class="code-head">
                  <span>openapi.yaml · {include.size} operations</span>
                  <CopyButton text={yaml} />
                </div>
                <pre data-testid="spec">{yaml}</pre>
              </div>
            )}
            {view === 'client' && (
              <div class="code-panel">
                <div class="code-head">
                  <span>client.ts · fetch-based, no dependencies</span>
                  <CopyButton text={client} />
                </div>
                <pre data-testid="client">{client}</pre>
              </div>
            )}
            {view === 'endpoint' && current && (
              <EndpointView
                ep={current}
                doc={fullDoc}
                components={components}
                redact={redact}
                security={model.security}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function EndpointView({
  ep,
  doc,
  components,
  redact,
  security,
}: {
  ep: Endpoint;
  security: ApiModel['security'];
  doc: Doc;
  components: Record<string, JsonSchema>;
  redact: boolean;
}) {
  const op = ((doc.paths as Doc)[ep.path] as Doc | undefined)?.[ep.method.toLowerCase()] as
    Doc | undefined;
  const okStatus = ep.responses.find((r) => r.status < 300)?.status ?? ep.responses[0]?.status;
  const [status, setStatus] = useState<number | undefined>(okStatus);
  const [showExample, setShowExample] = useState(false);
  useEffect(() => {
    setStatus(okStatus);
    setShowExample(false);
  }, [ep.id]);
  if (!op)
    return (
      <p class="muted">
        This operation conflicts with another site's path; export that site separately.
      </p>
    );
  const params = (op.parameters ?? []) as {
    name: string;
    in: string;
    required: boolean;
    schema: JsonSchema;
    example?: unknown;
  }[];
  const body = (op.requestBody as Doc | undefined)?.content as
    Record<string, { schema: JsonSchema; example?: unknown }> | undefined;
  const responses = op.responses as Record<
    string,
    { description: string; content?: Record<string, { schema?: JsonSchema; example?: unknown }> }
  >;
  const res = status !== undefined ? responses[String(status)] : undefined;
  const media = res?.content ? Object.entries(res.content)[0] : undefined;
  const curl = toCurl(ep);
  const call = usage(ep, security);

  return (
    <article class="endpoint" data-testid="endpoint">
      <header>
        <h2>
          <Method m={ep.method} />
          <code>{ep.path}</code>
        </h2>
        <p class="meta">
          <code>{ep.operationId}</code> · seen {ep.samples.length}×{' '}
          {ep.avgMs !== undefined && <>· avg {Math.round(ep.avgMs)} ms </>}·{' '}
          {ep.servers.length === 1 ? (
            <code>{ep.servers[0]}</code>
          ) : (
            <span title={ep.servers.join('\n')}>{ep.servers.length} servers</span>
          )}
        </p>
        {ep.security.length > 0 && (
          <p class="auth">
            🔒 Auth seen: {ep.security.join(', ')}{' '}
            {redact && <span class="muted">(values redacted)</span>}
          </p>
        )}
      </header>

      {params.length > 0 && (
        <section>
          <h3>Parameters</h3>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>In</th>
                  <th>Type</th>
                  <th>Example</th>
                </tr>
              </thead>
              <tbody>
                {params.map((p) => (
                  <tr key={`${p.in}:${p.name}`}>
                    <td>
                      <code>{p.name}</code>
                      {p.required && <span class="req">required</span>}
                    </td>
                    <td>{p.in}</td>
                    <td>
                      <SchemaView schema={p.schema} components={components} />
                    </td>
                    <td>
                      <code class="ex">{p.example === undefined ? '' : String(p.example)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {body && (
        <section>
          <h3>
            Request body <span class="muted">{Object.keys(body)[0]}</span>
          </h3>
          <SchemaView schema={Object.values(body)[0]!.schema} components={components} />
        </section>
      )}

      <section>
        <h3>Responses</h3>
        <div class="status-tabs" role="tablist" aria-label="Response status">
          {Object.keys(responses).map((code) => (
            <button
              key={code}
              type="button"
              role="tab"
              aria-selected={String(status) === code}
              class={`st st-${code[0]} ${String(status) === code ? 'on' : ''}`}
              onClick={() => setStatus(Number(code))}
            >
              {code} <span>{responses[code]!.description}</span>
            </button>
          ))}
        </div>
        {media?.[1].schema ? (
          <>
            <p class="muted small">{media[0]}</p>
            <SchemaView schema={media[1].schema} components={components} />
            {media[1].example !== undefined && (
              <div class="example">
                <button
                  type="button"
                  class="btn small"
                  onClick={() => setShowExample(!showExample)}
                  aria-expanded={showExample}
                >
                  {showExample ? 'Hide' : 'Show'} real example
                </button>
                {showExample && (
                  <pre data-testid="example">{JSON.stringify(media[1].example, null, 2)}</pre>
                )}
              </div>
            )}
          </>
        ) : (
          <p class="muted">No response body.</p>
        )}
      </section>

      <section>
        <h3>Try it</h3>
        <div class="code-panel">
          <div class="code-head">
            <span>curl {ep.security.length > 0 && '· set $TOKEN / $API_KEY / $COOKIE first'}</span>
            <CopyButton text={curl} />
          </div>
          <pre data-testid="curl">{curl}</pre>
        </div>
        <div class="code-panel">
          <div class="code-head">
            <span>TypeScript (client.ts)</span>
            <CopyButton text={call} />
          </div>
          <pre>{call}</pre>
        </div>
      </section>

      <section>
        <h3>Captured URLs</h3>
        <ul class="urls">
          {ep.examples.map((u) => (
            <li key={u}>
              <code>
                {redact
                  ? u.replace(/([?&][^=&]*(?:key|token|secret|sig)[^=&]*=)[^&]+/gi, '$1<redacted>')
                  : u}
              </code>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}

function usage(ep: Endpoint, security: ApiModel['security']): string {
  const args: string[] = [];
  for (const p of ep.params) {
    if (p.in === 'path' || p.required) {
      const ex = p.shape.items ? p.shape.items.example : p.shape.example;
      args.push(
        `${/^[A-Za-z_$][\w$]*$/.test(p.name) ? p.name : JSON.stringify(p.name)}: ${JSON.stringify(ex ?? '')}`,
      );
    }
  }
  if (ep.requestBody) args.push('body: { /* see request body */ }');
  const options: string[] = [];
  const headers: string[] = [];
  for (const key of ep.security) {
    const s = security[key];
    if (!s) continue;
    if (s.type === 'http' && s.scheme === 'bearer')
      headers.push('Authorization: `Bearer ${token}`');
    else if (s.type === 'http')
      headers.push('Authorization: `Basic ${btoa(`${user}:${password}`)}`');
    else if (s.in === 'header') headers.push(`${JSON.stringify(s.name)}: apiKey`);
    else if (s.in === 'cookie') headers.push(`cookie: \`${s.name}=\${session}\``);
    else if (s.in === 'query') options.push(`  query: { ${JSON.stringify(s.name)}: apiKey },`);
  }
  if (headers.length) options.unshift(`  init: { headers: { ${headers.join(', ')} } },`);
  const nl = String.fromCharCode(10);
  const opts = options.length ? ['{', ...options, '}'].join(nl) : '';
  const call = `const data = await api.${ep.operationId}(${args.length ? `{ ${args.join(', ')} }` : ''});`;
  return [
    "import { ApiClient } from './client';",
    '',
    `const api = new ApiClient(${opts});`,
    call,
  ].join(nl);
}
