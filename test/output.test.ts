import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { Validator } from '@seriousme/openapi-schema-validator';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { analyze } from '../src/core/analyze';
import { toCurl } from '../src/core/curl';
import { parseHar } from '../src/core/har';
import { toOpenApi } from '../src/core/openapi';
import { toTypeScript } from '../src/core/typescript';
import { toYaml } from '../src/core/yaml';
import { har } from './helpers';
// @ts-expect-error plain JS fixture
import { start } from './fixtures/server.mjs';

const demo = analyze(parseHar(readFileSync('examples/hn-search.har', 'utf8')));

async function validate(doc: unknown) {
  const v = new Validator();
  const res = await v.validate(doc as Parameters<Validator['validate']>[0]);
  return res;
}

describe('OpenAPI output', () => {
  it('is a valid OpenAPI 3.1 document for a real capture', async () => {
    const doc = toOpenApi(demo);
    const res = await validate(doc);
    expect(res.errors ?? []).toEqual([]);
    expect(res.valid).toBe(true);
    expect(Object.keys(doc.paths as object)).toEqual(
      expect.arrayContaining([
        '/items/{itemId}',
        '/users/{userName}',
        '/indexes/{indexName}/query',
      ]),
    );
  });

  it('round-trips through YAML unchanged', () => {
    const doc = toOpenApi(demo);
    expect(parseYaml(toYaml(doc))).toEqual(JSON.parse(JSON.stringify(doc)));
  });

  it('writes YAML for awkward values correctly', () => {
    const value = {
      empty: '',
      colon: 'a: b',
      hash: 'x #y',
      numberish: '0123',
      bool: 'true',
      multiline: 'one\ntwo',
      unicode: 'héllo ✓',
      nested: [[1, 2], [], {}, { a: [{ b: null }] }],
      'odd key': 1,
      '200': 'ok',
    };
    expect(parseYaml(toYaml(value))).toEqual(value);
  });

  it('never writes captured credentials', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJl';
    const m = analyze(
      har([
        {
          method: 'POST',
          url: 'https://api.test/login?api_key=SECRETKEY123',
          headers: { authorization: `Bearer ${jwt}`, cookie: 'sessionid=SESSIONVALUE' },
          reqBody: { email: 'ada@lovelace.test', password: 'hunter2' },
          body: { token: jwt, user: { email: 'ada@lovelace.test', name: 'Ada' } },
        },
      ]),
    );
    const out = [toYaml(toOpenApi(m)), toTypeScript(m), toCurl(m.endpoints[0]!)].join('\n');
    for (const secret of [jwt, 'SECRETKEY123', 'SESSIONVALUE', 'hunter2', 'ada@lovelace.test']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('bearerAuth');
    expect(toCurl(m.endpoints[0]!)).toContain('Authorization: Bearer $TOKEN');
    // Without redaction, examples keep the real values (opt-in).
    expect(toYaml(toOpenApi(m, { redact: false }))).toContain('hunter2');
  });
});

describe('TypeScript client', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = await start(0);
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => server.close());

  function compile(source: string): { diagnostics: string[]; js: string } {
    const file = 'client.ts';
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: true,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      noEmit: true,
      skipLibCheck: true,
    };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile;
    host.getSourceFile = (name, lang) =>
      name === file ? ts.createSourceFile(file, source, lang) : original.call(host, name, lang);
    const program = ts.createProgram([file], options, host);
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    const js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    return { diagnostics, js };
  }

  it('type-checks for a real capture', () => {
    expect(compile(toTypeScript(demo)).diagnostics).toEqual([]);
  });

  it('calls the real API it was inferred from', async () => {
    // Capture-like traffic against the fixture server...
    const get = async (path: string, init?: RequestInit) => {
      const res = await fetch(base + path, init);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };
    const calls = [];
    for (const path of [
      '/api/v1/users?page=1&limit=10',
      '/api/v1/users/1',
      '/api/v1/users/3',
      '/api/v1/users/99',
    ]) {
      const r = await get(path);
      calls.push({ url: base + path, status: r.status, body: r.body });
    }
    const created = await get('/api/v1/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Margaret', email: 'm@x.test', role: 'member' }),
    });
    calls.push({
      method: 'POST',
      url: `${base}/api/v1/users`,
      reqBody: { name: 'Margaret', email: 'm@x.test', role: 'member' },
      status: created.status,
      body: created.body,
    });

    // ...becomes a client that works against the same API.
    const model = analyze(har(calls));
    const source = toTypeScript(model);
    const { diagnostics, js } = compile(source);
    expect(diagnostics).toEqual([]);
    expect(source).toContain('listUsers(params: { page?: number; limit?: number } = {}');
    const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
    const api = new mod.ApiClient();
    const list = await api.listUsers({ page: 1, limit: 10 });
    expect(list.items).toHaveLength(3);
    const user = await api.getUser({ userId: 2 });
    expect(user.name).toBe('Linus');
    const made = await api.createUser({ body: { name: 'Bob', email: 'b@x.test', role: 'member' } });
    expect(made.id).toBe(4);
    await expect(api.getUser({ userId: 99 })).rejects.toMatchObject({ status: 404 });
  });
});

describe('client auth options', () => {
  it('sends query-string API keys on every request', async () => {
    const m = analyze(har([{ url: 'https://api.test/v1/things?api_key=K', body: [{ id: 1 }] }]));
    const source = toTypeScript(m);
    expect(source).toContain('query?: Record<string, string>;');
    const js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
    let seen = '';
    const api = new mod.ApiClient({
      query: { api_key: 'secret' },
      fetch: async (url: URL) => {
        seen = String(url);
        return new Response('[]', { status: 200 });
      },
    });
    await api.listThings();
    expect(seen).toBe('https://api.test/v1/things?api_key=secret');
  });
});
