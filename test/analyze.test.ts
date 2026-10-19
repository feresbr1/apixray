import { describe, expect, it } from 'vitest';
import { analyze, segmentKind, siteOf } from '../src/core/analyze';
import { detectAuth } from '../src/core/auth';
import { isApiCall, isNoiseHost } from '../src/core/classify';
import { HarError, parseHar } from '../src/core/har';
import { redactDeep, redactValue } from '../src/core/redact';
import { foldRecursion, shapeOf, toSchema } from '../src/core/shape';
import { entry, har } from './helpers';

const API = 'https://api.shop.test/v1';

describe('parseHar', () => {
  it('accepts HAR files, with or without a BOM', () => {
    const text = JSON.stringify(har([{ url: `${API}/a`, body: {} }]));
    expect(parseHar(text).log.entries).toHaveLength(1);
    expect(parseHar(String.fromCharCode(0xfeff) + text).log.entries).toHaveLength(1);
  });
  it('explains what is wrong', () => {
    expect(() => parseHar('nope')).toThrow(HarError);
    expect(() => parseHar('{"foo":1}')).toThrow(/log.entries/);
  });
});

describe('isApiCall', () => {
  it('keeps JSON and API mutations, skips assets, pages and preflights', () => {
    expect(isApiCall(entry({ url: `${API}/users`, body: [] }))).toBe(true);
    expect(isApiCall(entry({ method: 'DELETE', url: `${API}/users/1`, status: 204 }))).toBe(true);
    expect(isApiCall(entry({ method: 'OPTIONS', url: `${API}/users`, status: 204 }))).toBe(false);
    expect(
      isApiCall(
        entry({
          url: 'https://shop.test/app.js',
          body: 'x',
          resMime: 'text/javascript',
          type: 'script',
        }),
      ),
    ).toBe(false);
    expect(
      isApiCall(
        entry({
          url: 'https://shop.test/',
          body: '<html>',
          resMime: 'text/html',
          type: 'document',
        }),
      ),
    ).toBe(false);
    expect(
      isApiCall(entry({ url: 'https://shop.test/logo.png', resMime: 'image/png', type: 'image' })),
    ).toBe(false);
    // JSON served as text/plain still counts.
    expect(isApiCall(entry({ url: `${API}/odd`, body: '{"a":1}', resMime: 'text/plain' }))).toBe(
      true,
    );
  });
  it('recognises telemetry hosts', () => {
    expect(isNoiseHost('www.google-analytics.com')).toBe(true);
    expect(isNoiseHost('o123.ingest.sentry.io')).toBe(true);
    expect(isNoiseHost('telemetry.example.com')).toBe(true);
    expect(isNoiseHost('api.example.com')).toBe(false);
  });
});

describe('segmentKind and siteOf', () => {
  it('spots values in paths', () => {
    expect(segmentKind('42')).toBe('integer');
    expect(segmentKind('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('uuid');
    expect(segmentKind('507f1f77bcf86cd799439011')).toBe('hex');
    expect(segmentKind('2026-10-19')).toBe('date');
    expect(segmentKind('ord_10023')).toBe('id');
    expect(segmentKind('users')).toBeNull();
    expect(segmentKind('v2')).toBeNull();
  });
  it('groups hosts by site', () => {
    expect(siteOf('eu.api.example.com')).toBe('example.com');
    expect(siteOf('api.example.co.uk')).toBe('example.co.uk');
    expect(siteOf('localhost:3000')).toBe('localhost:3000');
    expect(siteOf('127.0.0.1:8080')).toBe('127.0.0.1:8080');
  });
});

describe('analyze', () => {
  it('templates ids, keeps singletons, strips the /v1 base path and names operations', () => {
    const user = (id: number) => ({ id, name: `u${id}`, email: `u${id}@shop.test` });
    const m = analyze(
      har([
        { url: `${API}/users?page=1`, body: { items: [user(1), user(2)], total: 2 } },
        { url: `${API}/users?page=2`, body: { items: [], total: 2 } },
        { url: `${API}/users/1`, body: user(1) },
        { url: `${API}/users/2`, body: user(2) },
        { url: `${API}/users/me`, body: { ...user(1), plan: 'pro' } },
        { url: `${API}/users/2/orders`, body: [{ id: 'ord_10023', total: 9.5 }] },
        { method: 'POST', url: `${API}/users`, reqBody: { name: 'x' }, status: 201, body: user(3) },
        { method: 'DELETE', url: `${API}/users/3`, status: 204 },
        { method: 'POST', url: `${API}/orders/ord_10023/cancel`, body: { ok: true } },
      ]),
    );
    const ids = Object.fromEntries(
      m.endpoints.map((e) => [`${e.method} ${e.path}`, e.operationId]),
    );
    expect(ids).toEqual({
      'GET /users': 'listUsers',
      'POST /users': 'createUser',
      'GET /users/me': 'getUserMe',
      'GET /users/{userId}': 'getUser',
      'DELETE /users/{userId}': 'deleteUser',
      'GET /users/{userId}/orders': 'listUserOrders',
      'POST /orders/{orderId}/cancel': 'cancelOrder',
    });
    expect(m.endpoints[0]!.servers).toEqual(['https://api.shop.test/v1']);
    const list = m.endpoints.find((e) => e.operationId === 'listUsers')!;
    expect(list.params).toMatchObject([{ name: 'page', in: 'query', required: true }]);
  });

  it('merges word-like values when their responses have the same shape', () => {
    const mon = (name: string) => ({
      name,
      height: 4,
      types: [{ slot: 1, type: { name: 'electric' } }],
      stats: [],
    });
    const m = analyze(
      har([
        { url: 'https://pokeapi.test/api/v2/pokemon/pikachu', body: mon('pikachu') },
        { url: 'https://pokeapi.test/api/v2/pokemon/eevee', body: mon('eevee') },
        { url: 'https://pokeapi.test/api/v2/pokemon/snorlax', body: mon('snorlax') },
        {
          url: 'https://pokeapi.test/api/v2/berry',
          body: { count: 64, results: [{ name: 'cheri', url: 'x' }] },
        },
        { url: 'https://pokeapi.test/api/v2/type', body: { count: 20, next: null, results: [] } },
      ]),
    );
    expect(m.endpoints.map((e) => e.path).sort()).toEqual([
      '/berry',
      '/pokemon/{pokemonName}',
      '/type',
    ]);
  });

  it('does not merge different resources that happen to be siblings', () => {
    const m = analyze(
      har([
        { url: `${API}/products`, body: [{ sku: 'a', price: 1, stock: 3 }] },
        { url: `${API}/customers`, body: [{ email: 'a@b.c', name: 'x', since: '2020-01-01' }] },
      ]),
    );
    expect(m.endpoints.map((e) => e.path).sort()).toEqual(['/customers', '/products']);
  });

  it('merges the same path on several hosts of one site into one endpoint', () => {
    const m = analyze(
      har([
        { url: 'https://eu.api.example.com/1/ping', body: { ok: true } },
        { url: 'https://us.api.example.com/1/ping', body: { ok: true } },
        { url: 'https://other.test/1/ping', body: { ok: true } },
      ]),
    );
    expect(m.endpoints).toHaveLength(2);
    const ex = m.endpoints.find((e) => e.site === 'example.com')!;
    expect(ex.servers).toEqual(['https://eu.api.example.com/1', 'https://us.api.example.com/1']);
    expect(new Set(m.endpoints.map((e) => e.operationId)).size).toBe(2);
  });

  it('skips telemetry unless asked, and can restrict origins', () => {
    const h = har([
      { url: `${API}/a`, body: {} },
      {
        method: 'POST',
        url: 'https://www.google-analytics.com/g/collect',
        reqBody: { e: 1 },
        body: {},
      },
    ]);
    expect(analyze(h).endpoints).toHaveLength(1);
    expect(analyze(h).stats.noiseCalls).toBe(1);
    expect(analyze(h, { includeNoise: true }).endpoints).toHaveLength(2);
    expect(analyze(h, { origins: ['https://www.google-analytics.com'] }).endpoints).toHaveLength(1);
  });

  it('collects request bodies, custom headers and responses per status', () => {
    const m = analyze(
      har([
        {
          method: 'POST',
          url: `${API}/login`,
          reqBody: { email: 'a@b.c', password: 'hunter2' },
          status: 200,
          body: { token: 't' },
          headers: { 'x-client-version': '3.1' },
        },
        {
          method: 'POST',
          url: `${API}/login`,
          reqBody: { email: 'a@b.c', password: 'no' },
          status: 401,
          body: { error: 'bad_credentials' },
          headers: { 'x-client-version': '3.1' },
        },
      ]),
    );
    const ep = m.endpoints[0]!;
    expect(ep.requestBody?.mime).toBe('application/json');
    expect(ep.responses.map((r) => r.status)).toEqual([200, 401]);
    expect(ep.params).toMatchObject([{ name: 'x-client-version', in: 'header', required: true }]);
  });

  it('parses form bodies', () => {
    const m = analyze(
      har([
        {
          method: 'POST',
          url: `${API}/search`,
          reqText: 'q=shoes&limit=10',
          reqMime: 'application/x-www-form-urlencoded',
          body: [],
        },
      ]),
    );
    expect(m.endpoints[0]!.requestBody?.mime).toBe('application/x-www-form-urlencoded');
    expect(toSchema(m.endpoints[0]!.requestBody!.shape).properties).toMatchObject({
      q: { type: 'string' },
      limit: { type: 'integer' },
    });
  });
});

describe('shapes', () => {
  it('infers required, optional, nullable, enums and formats', () => {
    const s = toSchema(
      shapeOf([
        {
          id: 1,
          status: 'open',
          at: '2026-01-01T00:00:00Z',
          note: null,
          mail: 'a@b.c',
          site: 'https://x.test',
        },
        {
          id: 2,
          status: 'closed',
          at: '2026-01-02T00:00:00Z',
          note: 'hi',
          mail: 'c@d.e',
          site: 'https://y.test',
        },
        {
          id: 3,
          status: 'open',
          at: '2026-01-03T00:00:00Z',
          mail: 'e@f.g',
          site: 'https://z.test',
        },
        {
          id: 4.5,
          status: 'closed',
          at: '2026-01-04T00:00:00Z',
          note: null,
          mail: 'g@h.i',
          site: 'https://w.test',
        },
      ]),
    );
    expect(s.required).toEqual(['id', 'status', 'at', 'mail', 'site']);
    expect(s.properties!.id).toEqual({ type: 'number' });
    expect(s.properties!.status).toEqual({ type: 'string', enum: ['closed', 'open'] });
    expect(s.properties!.at!.format).toBe('date-time');
    expect(s.properties!.note!.type).toEqual(['string', 'null']);
    expect(s.properties!.mail!.format).toBe('email');
    expect(s.properties!.site!.format).toBe('uri');
  });

  it('treats objects keyed by ids as maps', () => {
    const s = toSchema(shapeOf([{ '101': { n: 1 }, '102': { n: 2 } }]));
    expect(s.additionalProperties).toMatchObject({
      type: 'object',
      properties: { n: { type: 'integer' } },
    });
  });

  it('folds trees into a recursive reference', () => {
    const node = (d: number): unknown => ({
      id: d,
      author: 'a',
      text: 't',
      children: d < 4 ? [node(d + 1)] : [],
    });
    const shape = shapeOf([node(0)]);
    foldRecursion(shape, 'Comment', new Set());
    const components = new Map();
    const s = toSchema(shape, { components });
    expect(s).toEqual({ $ref: '#/components/schemas/Comment' });
    expect(components.get('Comment').properties.children).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/Comment' },
    });
  });
});

describe('auth and redaction', () => {
  it('detects credentials', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';
    const a = detectAuth(
      [
        { name: 'Authorization', value: `Bearer ${jwt}` },
        { name: 'X-Api-Key', value: 'k' },
        { name: 'Cookie', value: 'theme=dark; session_id=abc' },
      ],
      [['api_key', 'q']],
    );
    expect(a.schemes).toEqual([
      { key: 'bearerAuth', type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      { key: 'xApiKey', type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      { key: 'cookieAuth', type: 'apiKey', in: 'cookie', name: 'session_id' },
      { key: 'apiKeyQuery', type: 'apiKey', in: 'query', name: 'api_key' },
    ]);
    expect(
      detectAuth([{ name: 'authorization', value: 'Basic eDp5' }], []).schemes[0]!.scheme,
    ).toBe('basic');
  });

  it('redacts secrets, JWTs and e-mail addresses but keeps ordinary data', () => {
    expect(
      redactDeep({
        user: { email: 'ada@x.test', name: 'Ada', author: 'pg' },
        accessToken: 'abc',
        credentials: { key: 'k' },
        session: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
        list: ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln'],
      }),
    ).toEqual({
      user: { email: 'user@example.com', name: 'Ada', author: 'pg' },
      accessToken: '<redacted>',
      credentials: '<redacted>',
      session: '<redacted>',
      list: ['<redacted-jwt>'],
    });
    expect(redactValue('count', 3)).toBe(3);
  });
});
