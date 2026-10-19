import { detectAuth, type SecurityScheme } from './auth';
import { bodyKind, isApiCall, isNoiseHost, tryJson, type BodyKind } from './classify';
import { header, responseText, type Har, type HarEntry, type HarHeader } from './har';
import { emptyShape, fingerprint, foldRecursion, observe, similarity, type Shape } from './shape';

export interface Sample {
  entry: HarEntry;
  method: string;
  origin: string;
  host: string;
  segments: string[];
  query: [string, string][];
  requestHeaders: HarHeader[];
  reqKind: BodyKind;
  reqMime?: string;
  reqBody?: unknown;
  reqFields?: [string, string][];
  status: number;
  resKind: BodyKind;
  resMime?: string;
  resBody?: unknown;
  hasResBody: boolean;
  durationMs?: number;
  security: SecurityScheme[];
  /** Credential-bearing header/query names, kept out of the parameter lists. */
  secretHeaders: Set<string>;
  secretQuery: Set<string>;
}

export type ParamKind = 'integer' | 'uuid' | 'hex' | 'date' | 'token' | 'id' | 'string';

export interface Param {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  shape: Shape;
  kind?: ParamKind;
}

export interface ResponseInfo {
  status: number;
  count: number;
  mime?: string;
  kind: BodyKind;
  shape?: Shape;
}

export interface Endpoint {
  id: string;
  method: string;
  /** Registrable domain the endpoint belongs to, e.g. example.com */
  site: string;
  /** The origin most of its calls went to. */
  origin: string;
  /** Every origin + basePath it was called on. */
  servers: string[];
  basePath: string;
  /** Template relative to basePath, e.g. /users/{userId} */
  path: string;
  tag: string;
  operationId: string;
  params: Param[];
  requestBody?: { mime: string; kind: BodyKind; shape: Shape };
  responses: ResponseInfo[];
  samples: Sample[];
  security: string[];
  /** Concrete URLs seen (a few), for display. */
  examples: string[];
  avgMs?: number;
}

export interface OriginInfo {
  origin: string;
  calls: number;
  endpoints: number;
  noise: boolean;
  basePath: string;
}

export interface ApiModel {
  endpoints: Endpoint[];
  origins: OriginInfo[];
  security: Record<string, SecurityScheme>;
  stats: {
    entries: number;
    apiCalls: number;
    skippedStatic: number;
    noiseCalls: number;
    withoutBodies: number;
  };
}

export interface AnalyzeOptions {
  /** Include known analytics/telemetry hosts (default false). */
  includeNoise?: boolean;
  /** Only these origins (e.g. https://api.example.com). Default: all non-noise origins. */
  origins?: string[];
}

// ---------------------------------------------------------------------------------------------
// Samples

function toSample(entry: HarEntry): Sample | null {
  let url: URL;
  try {
    url = new URL(entry.request.url);
  } catch {
    return null;
  }
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const query: [string, string][] = [...url.searchParams.entries()];
  const reqMime = entry.request.postData?.mimeType || header(entry.request.headers, 'content-type');
  const reqKind = entry.request.postData ? bodyKind(reqMime) : 'none';
  let reqBody: unknown;
  let reqFields: [string, string][] | undefined;
  const text = entry.request.postData?.text;
  if (reqKind === 'json' || (reqKind === 'text' && text)) {
    const j = tryJson(text);
    if (j.ok) reqBody = j.value;
  } else if (reqKind === 'form') {
    reqFields = entry.request.postData?.params?.length
      ? entry.request.postData.params.map((p) => [p.name, p.value ?? ''])
      : [...new URLSearchParams(text ?? '').entries()];
  } else if (reqKind === 'multipart') {
    reqFields = (entry.request.postData?.params ?? []).map((p) => [p.name, p.value ?? '']);
  }
  const resMime =
    entry.response.content?.mimeType || header(entry.response.headers, 'content-type');
  const body = responseText(entry);
  const parsed = tryJson(body);
  const resKind = parsed.ok ? 'json' : bodyKind(resMime);
  const auth = detectAuth(entry.request.headers, query);
  return {
    entry,
    method: entry.request.method.toUpperCase(),
    origin: url.origin,
    host: url.host,
    segments,
    query,
    requestHeaders: entry.request.headers,
    reqKind: reqBody !== undefined ? 'json' : reqKind,
    reqMime: reqMime?.split(';')[0]?.trim(),
    reqBody,
    reqFields,
    status: entry.response.status,
    resKind,
    resMime: resMime?.split(';')[0]?.trim(),
    resBody: parsed.ok ? parsed.value : undefined,
    hasResBody: body !== undefined && body.length > 0,
    durationMs: typeof entry.time === 'number' && entry.time >= 0 ? entry.time : undefined,
    security: auth.schemes,
    secretHeaders: auth.headers,
    secretQuery: auth.query,
  };
}

// ---------------------------------------------------------------------------------------------
// Path templating

export function segmentKind(seg: string): ParamKind | null {
  if (/^\d+$/.test(seg)) return 'integer';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return 'uuid';
  if (/^\d{4}-\d{2}-\d{2}$/.test(seg)) return 'date';
  if (/^[0-9a-f]{12,}$/i.test(seg) && /\d/.test(seg) && /[a-f]/i.test(seg)) return 'hex';
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(seg)) return 'token'; // ULID
  if (/^[A-Za-z0-9_-]{16,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return 'token';
  if (/^[A-Za-z_-]{0,12}\d{3,}[A-Za-z0-9_-]*$/.test(seg) && /\d{3,}/.test(seg)) return 'id';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(seg)) return 'string';
  return null;
}

/** Literal path words that are actions or singletons, never values. */
const RESERVED = new Set(
  'me self current search new count all latest list batch bulk export import stats settings config login logout signin signup register auth token refresh health status version info details summary feed graphql query mine recent popular trending top default random'.split(
    ' ',
  ),
);

interface Node {
  samples: Sample[];
  children: Map<string, Node>;
  param?: Node;
  paramKinds: Set<ParamKind>;
  values: string[];
}

function newNode(): Node {
  return { samples: [], children: new Map(), paramKinds: new Set(), values: [] };
}

function insert(root: Node, sample: Sample): void {
  let node = root;
  for (const [i, seg] of sample.segments.entries()) {
    // A short number at the start of the path is an API version (/1/indexes), not an id.
    const kind = i === 0 && /^\d{1,2}$/.test(seg) ? null : segmentKind(seg);
    if (kind) {
      node.param ??= newNode();
      node = node.param;
      node.paramKinds.add(kind);
      if (node.values.length < 50) node.values.push(seg);
    } else {
      let child = node.children.get(seg);
      if (!child) {
        child = newNode();
        node.children.set(seg, child);
      }
      node = child;
    }
  }
  node.samples.push(sample);
}

function mergeInto(target: Node, src: Node, srcValue?: string): void {
  target.samples.push(...src.samples);
  for (const k of src.paramKinds) target.paramKinds.add(k);
  if (srcValue !== undefined) {
    target.paramKinds.add('string');
    if (target.values.length < 50) target.values.push(srcValue);
  }
  for (const v of src.values) if (target.values.length < 50) target.values.push(v);
  for (const [seg, child] of src.children) {
    const mine = target.children.get(seg);
    if (mine) mergeInto(mine, child);
    else target.children.set(seg, child);
  }
  if (src.param) {
    if (target.param) mergeInto(target.param, src.param);
    else target.param = src.param;
  }
}

/** Response shapes + relative sub-paths: what a URL "looks like" from the outside. */
function nodeFingerprint(node: Node): Set<string> {
  const fp = new Set<string>();
  const walk = (n: Node, rel: string, depth: number) => {
    for (const s of n.samples) {
      if (s.status >= 200 && s.status < 300 && s.resBody !== undefined) {
        const shape = observe(emptyShape(), s.resBody);
        for (const f of fingerprint(shape)) fp.add(`${rel}${s.method}${f}`);
      } else {
        fp.add(`${rel}${s.method}#${s.status}`);
      }
    }
    if (depth > 3) return;
    for (const [seg, c] of n.children) walk(c, `${rel}/${seg}`, depth + 1);
    if (n.param) walk(n.param, `${rel}/{}`, depth + 1);
  };
  walk(node, '', 0);
  return fp;
}

/**
 * Literal siblings that behave the same (same response structure, same sub-paths) are values of
 * one parameter: /pokemon/pikachu and /pokemon/bulbasaur become /pokemon/{pokemonName}.
 */
function generalize(node: Node): void {
  const literals = [...node.children].filter(([seg]) => !RESERVED.has(seg.toLowerCase()));
  if (literals.length >= 2 || (literals.length >= 1 && node.param)) {
    const fps = new Map(literals.map(([seg, c]) => [seg, nodeFingerprint(c)]));
    const groups: { segs: string[]; fp: Set<string> }[] = [];
    if (node.param) groups.push({ segs: ['{param}'], fp: nodeFingerprint(node.param) });
    for (const [seg] of literals) {
      const fp = fps.get(seg)!;
      if (fp.size < 3) continue;
      // Plain lowercase words are usually resource names, so they need near-identical responses;
      // names that look like data (Item_dev, user42, Mixed-Case) need less.
      const threshold = /^[a-z]+(-[a-z]+)*$/.test(seg) ? 0.8 : 0.5;
      const g = groups.find((x) => similarity(x.fp, fp) >= threshold);
      if (g) g.segs.push(seg);
      else groups.push({ segs: [seg], fp });
    }
    for (const g of groups) {
      const values = g.segs.filter((s) => s !== '{param}');
      const hasParam = g.segs.includes('{param}');
      if (values.length + (hasParam ? 1 : 0) < 2) continue;
      node.param ??= newNode();
      for (const seg of values) {
        mergeInto(node.param, node.children.get(seg)!, seg);
        node.children.delete(seg);
      }
    }
  }
  for (const c of node.children.values()) generalize(c);
  if (node.param) generalize(node.param);
}

function singular(word: string): string {
  const w = word.toLowerCase();
  if (/ies$/.test(w)) return word.slice(0, -3) + 'y';
  if (/(ss|us|is)$/.test(w)) return word;
  if (/(x|ch|sh|ses)es$/.test(w)) return word.slice(0, -2);
  if (/s$/.test(w)) return word.slice(0, -1);
  return word;
}

function camel(words: string[]): string {
  const parts = words.flatMap((w) => w.split(/[^A-Za-z0-9]+/)).filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p[0]!.toLowerCase() + p.slice(1) : p[0]!.toUpperCase() + p.slice(1)))
    .join('');
}

function pascal(words: string[]): string {
  const c = camel(words);
  return c ? c[0]!.toUpperCase() + c.slice(1) : '';
}

function paramName(prev: string | undefined, kinds: Set<ParamKind>, used: Set<string>): string {
  const idLike = [...kinds].some((k) => k !== 'string' && k !== 'date');
  let base: string;
  if (!prev || /^v\d+$/i.test(prev) || prev === 'api') base = idLike ? 'id' : 'name';
  else if ([...kinds].every((k) => k === 'date')) base = camel([singular(prev), 'date']);
  else base = camel([singular(prev), idLike ? 'id' : 'name']);
  if (!/^[A-Za-z_]/.test(base)) base = `p${base}`;
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}${i}`;
  used.add(name);
  return name;
}

interface Template {
  segments: { literal?: string; param?: string; kinds?: Set<ParamKind>; values?: string[] }[];
  samples: Sample[];
}

function collect(node: Node, prefix: Template['segments'], out: Template[]): void {
  if (node.samples.length) out.push({ segments: prefix, samples: node.samples });
  for (const [seg, c] of node.children) collect(c, [...prefix, { literal: seg }], out);
  if (node.param) {
    const usedHere = new Set(prefix.filter((s) => s.param).map((s) => s.param!));
    const name = paramName(prefix.at(-1)?.literal, node.param.paramKinds, usedHere);
    collect(
      node.param,
      [...prefix, { param: name, kinds: node.param.paramKinds, values: node.param.values }],
      out,
    );
  }
}

const BASE_SEGMENT = /^(api|apis|rest|v\d+(\.\d+)*|\d{1,2}|public|internal)$/i;

// ---------------------------------------------------------------------------------------------
// Values -> shapes

function coerce(value: string): unknown {
  if (/^-?\d+$/.test(value) && value.length < 16) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  if (value === 'true' || value === 'false') return value === 'true';
  return value;
}

const IGNORED_HEADERS = new Set(
  'accept accept-encoding accept-language cache-control connection content-length content-type cookie host origin pragma referer user-agent te priority dnt upgrade-insecure-requests if-none-match if-modified-since x-requested-with x-client-data purpose'.split(
    ' ',
  ),
);

function customHeaders(s: Sample): HarHeader[] {
  return s.requestHeaders.filter((h) => {
    const n = h.name.toLowerCase();
    if (n.startsWith(':') || n.startsWith('sec-') || IGNORED_HEADERS.has(n)) return false;
    if (s.secretHeaders.has(n)) return false;
    return n.startsWith('x-') || /^(api-|client-|app-)/.test(n);
  });
}

// ---------------------------------------------------------------------------------------------
// Main

export function analyze(har: Har, opts: AnalyzeOptions = {}): ApiModel {
  const entries = har.log.entries;
  const stats = {
    entries: entries.length,
    apiCalls: 0,
    skippedStatic: 0,
    noiseCalls: 0,
    withoutBodies: 0,
  };
  const samples: Sample[] = [];
  const originCalls = new Map<string, { calls: number; noise: boolean }>();
  for (const entry of entries) {
    if (!isApiCall(entry)) {
      stats.skippedStatic++;
      continue;
    }
    const s = toSample(entry);
    if (!s) continue;
    const noise = isNoiseHost(s.host);
    const o = originCalls.get(s.origin) ?? { calls: 0, noise };
    o.calls++;
    originCalls.set(s.origin, o);
    if (noise) stats.noiseCalls++;
    if (opts.origins ? !opts.origins.includes(s.origin) : noise && !opts.includeNoise) continue;
    stats.apiCalls++;
    if (!s.hasResBody && s.status !== 204 && s.method !== 'HEAD') stats.withoutBodies++;
    samples.push(s);
  }

  // Hosts of one site (api.x.com, eu.x.com, x.com) are templated together: the same path on
  // several hosts is one endpoint with several servers.
  const bySite = new Map<string, Sample[]>();
  for (const s of samples) {
    const key = siteOf(s.host);
    const list = bySite.get(key) ?? [];
    list.push(s);
    bySite.set(key, list);
  }

  const endpoints: Endpoint[] = [];
  const security: Record<string, SecurityScheme> = {};
  for (const [site, list] of bySite) {
    const root = newNode();
    for (const s of list) insert(root, s);
    generalize(root);
    const templates: Template[] = [];
    collect(root, [], templates);

    // Strip a shared /api/v1-style prefix into the server URL.
    let base: string[] = [];
    const first = templates[0]?.segments ?? [];
    for (let i = 0; i < first.length; i++) {
      const lit = first[i]!.literal;
      if (!lit || !BASE_SEGMENT.test(lit)) break;
      if (!templates.every((t) => t.segments[i]?.literal === lit && t.segments.length > i + 1))
        break;
      base.push(lit);
    }
    if (templates.length === 0) base = [];
    const basePath = base.length ? `/${base.join('/')}` : '';

    for (const t of templates) {
      const rel = t.segments.slice(base.length);
      const path =
        '/' + rel.map((s) => (s.param ? `{${s.param}}` : encodeSegment(s.literal!))).join('/');
      const byMethod = new Map<string, Sample[]>();
      for (const s of t.samples) {
        const l = byMethod.get(s.method) ?? [];
        l.push(s);
        byMethod.set(s.method, l);
      }
      for (const [method, ms] of byMethod) {
        const ep = buildEndpoint(site, basePath, path, rel, method, ms);
        for (const sc of ms.flatMap((s) => s.security)) security[sc.key] = sc;
        endpoints.push(ep);
      }
    }
  }

  const origins: OriginInfo[] = [...originCalls].map(([origin, o]) => {
    const own = endpoints.filter((e) => e.servers.some((sv) => sv.startsWith(origin)));
    return {
      origin,
      calls: o.calls,
      endpoints: own.length,
      noise: o.noise,
      basePath: own[0]?.basePath ?? '',
    };
  });
  origins.sort((a, b) => b.calls - a.calls);

  uniqueOperationIds(endpoints);
  // Name recursive structures (comment trees, folders) once, across the whole API.
  const names = new Set<string>();
  for (const ep of endpoints) {
    const root = pascal([singular(ep.tag)]) || 'Item';
    for (const r of ep.responses) if (r.shape) foldRecursion(r.shape, root, names);
    if (ep.requestBody) foldRecursion(ep.requestBody.shape, root, names);
  }
  endpoints.sort((a, b) =>
    a.site !== b.site
      ? a.site < b.site
        ? -1
        : 1
      : a.origin !== b.origin
        ? a.origin < b.origin
          ? -1
          : 1
        : a.path === b.path
          ? METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method)
          : a.path < b.path
            ? -1
            : 1,
  );
  return { endpoints, origins, security, stats };
}

const METHOD_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** Registrable-domain approximation: api.eu.example.co.uk -> example.co.uk */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  if (/^[\d.]+$/.test(h) || h === 'localhost' || !h.includes('.')) return host.toLowerCase();
  const labels = h.split('.');
  const second = labels.at(-2) ?? '';
  const take =
    labels.at(-1)!.length === 2 && /^(co|com|net|org|gov|ac|edu|ne|or|go)$/.test(second) ? 3 : 2;
  return labels.slice(-take).join('.');
}

function encodeSegment(s: string): string {
  return s.replace(/[{}?#\s]/g, (c) => encodeURIComponent(c));
}

function buildEndpoint(
  site: string,
  basePath: string,
  path: string,
  rel: Template['segments'],
  method: string,
  samples: Sample[],
): Endpoint {
  const params: Param[] = [];
  // Path parameters: values come from the matching segment of each sample.
  const offset = samples[0]!.segments.length - rel.length;
  rel.forEach((seg, i) => {
    if (!seg.param) return;
    const shape = emptyShape();
    for (const s of samples) {
      const v = s.segments[offset + i];
      if (v !== undefined) observe(shape, coerce(v));
    }
    const kinds = [...(seg.kinds ?? [])];
    params.push({
      name: seg.param,
      in: 'path',
      required: true,
      shape,
      kind: kinds.length === 1 ? kinds[0] : kinds.includes('string') ? 'string' : kinds[0],
    });
  });

  // Query parameters.
  const query = new Map<string, { shape: Shape; present: number; repeated: boolean }>();
  for (const s of samples) {
    const seen = new Map<string, number>();
    for (const [k] of s.query) seen.set(k, (seen.get(k) ?? 0) + 1);
    for (const [k, n] of seen) {
      if (s.secretQuery.has(k)) continue;
      const q = query.get(k) ?? { shape: emptyShape(), present: 0, repeated: false };
      q.present++;
      if (n > 1) q.repeated = true;
      for (const [qk, qv] of s.query) if (qk === k) observe(q.shape, coerce(qv));
      query.set(k, q);
    }
  }
  for (const [name, q] of query) {
    let shape = q.shape;
    if (q.repeated) {
      shape = emptyShape();
      shape.count = q.present;
      shape.kinds.add('array');
      shape.items = q.shape;
    }
    params.push({
      name,
      in: 'query',
      required: q.present === samples.length && samples.length > 1,
      shape,
    });
  }

  // Custom request headers.
  const headers = new Map<string, { shape: Shape; present: number }>();
  for (const s of samples) {
    for (const h of customHeaders(s)) {
      const e = headers.get(h.name.toLowerCase()) ?? { shape: emptyShape(), present: 0 };
      e.present++;
      observe(e.shape, h.value);
      headers.set(h.name.toLowerCase(), e);
    }
  }
  for (const [name, h] of headers) {
    params.push({
      name,
      in: 'header',
      required: h.present === samples.length && samples.length > 1,
      shape: h.shape,
    });
  }

  // Request body.
  let requestBody: Endpoint['requestBody'];
  const withBody = samples.filter((s) => s.reqBody !== undefined || s.reqFields);
  if (withBody.length) {
    const shape = emptyShape();
    for (const s of withBody) {
      if (s.reqBody !== undefined) observe(shape, s.reqBody);
      else observe(shape, Object.fromEntries(s.reqFields!.map(([k, v]) => [k, coerce(v)])));
    }
    const first = withBody[0]!;
    requestBody = {
      mime:
        first.reqKind === 'json'
          ? 'application/json'
          : first.reqKind === 'form'
            ? 'application/x-www-form-urlencoded'
            : first.reqKind === 'multipart'
              ? 'multipart/form-data'
              : (first.reqMime ?? 'application/octet-stream'),
      kind: first.reqKind,
      shape,
    };
  }

  // Responses per status.
  const responses = new Map<number, ResponseInfo>();
  for (const s of samples) {
    const r = responses.get(s.status) ?? {
      status: s.status,
      count: 0,
      kind: s.resKind,
      mime: s.resMime,
    };
    r.count++;
    if (s.resBody !== undefined) {
      r.shape ??= emptyShape();
      observe(r.shape, s.resBody);
      r.kind = 'json';
      r.mime = s.resMime && /json/i.test(s.resMime) ? s.resMime : 'application/json';
    }
    responses.set(s.status, r);
  }

  const literals = rel.filter((s) => s.literal).map((s) => s.literal!);
  const tag = literals.find((l) => !BASE_SEGMENT.test(l)) ?? literals[0] ?? 'root';
  const times = samples.map((s) => s.durationMs).filter((t): t is number => t !== undefined);
  const securityKeys = [...new Set(samples.flatMap((s) => s.security.map((x) => x.key)))];
  const examples = [...new Set(samples.map((s) => s.entry.request.url.split('#')[0]!))].slice(0, 5);
  const originCount = new Map<string, number>();
  for (const s of samples) originCount.set(s.origin, (originCount.get(s.origin) ?? 0) + 1);
  const origin = [...originCount].sort((a, b) => b[1] - a[1])[0]![0];
  const servers = [...originCount.keys()].sort().map((o) => `${o}${basePath}`);

  return {
    id: `${method} ${site}${basePath}${path}`,
    method,
    site,
    origin,
    servers,
    basePath,
    path,
    tag,
    operationId: operationName(method, rel, responses),
    params,
    requestBody,
    responses: [...responses.values()].sort((a, b) => a.status - b.status),
    samples,
    security: securityKeys,
    examples,
    avgMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : undefined,
  };
}

const ACTIONS = new Set(
  'query search cancel login logout signin signout refresh publish unpublish archive approve reject send verify reset upload import export sync validate execute run start stop restart resolve close open like unlike follow unfollow subscribe unsubscribe confirm complete submit retry checkout pay'.split(
    ' ',
  ),
);

function operationName(
  method: string,
  rel: Template['segments'],
  responses: Map<number, ResponseInfo>,
): string {
  const last = rel.at(-1);
  const lits = rel.filter((s) => s.literal && !BASE_SEGMENT.test(s.literal)).map((s) => s.literal!);
  const resource = lits.at(-1) ?? 'root';
  // Parent resources give context: /users/{id}/posts -> UserPosts
  const parents = lits.slice(0, -1).map(singular);
  const endsWithParam = Boolean(last?.param);
  const ok = [...responses.values()].find((r) => r.status >= 200 && r.status < 300);
  // A list is a JSON array, or an envelope like { items: [...], total } / { data: [...] }.
  const returnsArray = ok?.shape
    ? ok.shape.kinds.has('array') ||
      [...(ok.shape.props ?? [])].some(
        ([k, p]) =>
          /^(items|data|results|hits|records|entries|list|rows|nodes|edges|content)$/i.test(k) &&
          p.kinds.has('array'),
      )
    : false;
  let verb: string;
  let noun: string;
  switch (method) {
    case 'GET':
      // GET /search, GET /products/search -> search, searchProduct
      if (!endsWithParam && (resource === 'search' || resource === 'query')) {
        return camel([resource, ...lits.slice(0, -1).map(singular)]);
      }
      verb = endsWithParam || !returnsArray ? 'get' : 'list';
      noun = endsWithParam ? singular(resource) : resource;
      break;
    case 'POST':
      if (!endsWithParam && lits.length >= 2 && ACTIONS.has(resource.toLowerCase())) {
        // POST /indexes/products/query -> queryProduct, POST /auth/login -> loginAuth
        return camel([resource, singular(lits.at(-2)!)]) || 'post';
      }
      if (!endsWithParam && rel.length >= 2 && rel.at(-2)?.param) {
        // POST /orders/{id}/cancel -> cancelOrder
        verb = resource;
        noun = singular(lits.at(-2) ?? '');
        return camel([verb, noun]) || 'post';
      }
      verb = 'create';
      noun = singular(resource);
      break;
    case 'PUT':
    case 'PATCH':
      verb = method === 'PUT' ? 'replace' : 'update';
      noun = singular(resource);
      break;
    case 'DELETE':
      verb = 'delete';
      noun = singular(resource);
      break;
    default:
      verb = method.toLowerCase();
      noun = resource;
  }
  return camel([verb, ...parents, noun]) || method.toLowerCase();
}

function uniqueOperationIds(endpoints: Endpoint[]): void {
  const groups = new Map<string, Endpoint[]>();
  for (const ep of endpoints) {
    const g = groups.get(ep.operationId) ?? [];
    g.push(ep);
    groups.set(ep.operationId, g);
  }
  const taken = new Set(groups.keys());
  for (const [id, group] of groups) {
    if (group.length < 2) continue;
    const multiOrigin = new Set(group.map((e) => e.site)).size === group.length;
    for (const [i, ep] of group.entries()) {
      if (i === 0 && !multiOrigin) continue;
      let candidate: string;
      if (multiOrigin) {
        const label = ep.site.split('.')[0]!;
        candidate = `${id}${pascal([label])}`;
      } else {
        const params = ep.params.filter((p) => p.in === 'path').map((p) => p.name);
        candidate = params.length ? `${id}By${pascal(params)}` : `${id}${i + 1}`;
      }
      let unique = candidate;
      for (let n = 2; taken.has(unique); n++) unique = `${candidate}${n}`;
      taken.add(unique);
      ep.operationId = unique;
    }
  }
}
