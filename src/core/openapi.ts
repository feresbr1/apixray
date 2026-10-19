import type { ApiModel, Endpoint, Param } from './analyze';
import { redactDeep, redactValue } from './redact';
import { toSchema, type JsonSchema, type SchemaOptions } from './shape';

export interface OpenApiOptions {
  title?: string;
  /** Include real (redacted) examples from the captured traffic. Default true. */
  examples?: boolean;
  /** Redact credentials, tokens and e-mail addresses in examples. Default true. */
  redact?: boolean;
  /** Only these endpoint ids. */
  include?: Set<string>;
}

type Doc = Record<string, unknown>;

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export function summaryOf(operationId: string): string {
  const words = operationId.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Trim big example payloads: first 3 array items, 6 levels deep. */
export function trimExample(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.slice(0, 3).map((v) => trimExample(v, depth + 1));
  if (value && typeof value === 'object') {
    if (depth >= 6) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = trimExample(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 297)}...`;
  return value;
}

function paramSchema(p: Param): JsonSchema {
  const schema = toSchema(p.shape);
  // Parameters are never null; a missing value is "not required" instead.
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => t !== 'null');
    schema.type = types.length === 1 ? types[0] : types;
  }
  if (p.kind === 'uuid') schema.format = 'uuid';
  if (p.kind === 'date') schema.format = 'date';
  return schema;
}

export function endpointOperation(
  ep: Endpoint,
  multiOrigin: boolean,
  options: OpenApiOptions = {},
  schemaOpts: SchemaOptions = {},
): Doc {
  const opts = { examples: options.examples ?? true, redact: options.redact ?? true };
  const redact = opts.redact ? redactValue : (_k: string, v: unknown) => v;
  const op: Doc = {
    operationId: ep.operationId,
    summary: summaryOf(ep.operationId),
    tags: [ep.tag],
  };
  if (multiOrigin) op.servers = ep.servers.map((url) => ({ url }));
  const params = ep.params.map((p) => {
    const out: Doc = {
      name: p.name,
      in: p.in,
      required: p.in === 'path' ? true : p.required,
      schema: paramSchema(p),
    };
    const example = p.shape.items ? p.shape.items.example : p.shape.example;
    if (opts.examples && example !== undefined) out.example = redact(p.name, example);
    return out;
  });
  if (params.length) op.parameters = params;
  if (ep.requestBody) {
    const schema = toSchema(ep.requestBody.shape, schemaOpts);
    const media: Doc = { schema };
    const sample = ep.samples.find((s) => s.reqBody !== undefined);
    if (opts.examples && sample) {
      media.example = trimExample(opts.redact ? redactDeep(sample.reqBody) : sample.reqBody);
    }
    op.requestBody = { required: true, content: { [ep.requestBody.mime]: media } };
  }
  const responses: Doc = {};
  for (const r of ep.responses) {
    const res: Doc = { description: STATUS_TEXT[r.status] ?? `Status ${r.status}` };
    if (r.shape) {
      const media: Doc = { schema: toSchema(r.shape, schemaOpts) };
      const sample = ep.samples.find((s) => s.status === r.status && s.resBody !== undefined);
      if (opts.examples && sample) {
        media.example = trimExample(opts.redact ? redactDeep(sample.resBody) : sample.resBody);
      }
      res.content = { [r.mime ?? 'application/json']: media };
    } else if (r.mime && r.status !== 204 && r.status !== 304) {
      res.content = { [r.mime]: {} };
    }
    responses[String(r.status)] = res;
  }
  if (!ep.responses.length) responses.default = { description: 'No response captured' };
  op.responses = responses;
  if (ep.security.length) op.security = ep.security.map((k) => ({ [k]: [] }));
  const ext: Doc = { calls: ep.samples.length };
  if (ep.avgMs !== undefined) ext.avgMs = Math.round(ep.avgMs);
  op['x-apixray'] = ext;
  return op;
}

/** Build an OpenAPI 3.1 document from the inferred model. */
export function toOpenApi(model: ApiModel, options: OpenApiOptions = {}): Doc {
  const endpoints = options.include
    ? model.endpoints.filter((e) => options.include!.has(e.id))
    : model.endpoints;
  const origins = [...new Set(endpoints.flatMap((e) => e.servers))];
  const multiOrigin = origins.length > 1;
  const paths: Record<string, Doc> = {};
  const tags = new Set<string>();
  let conflicts = 0;
  const schemaOpts: SchemaOptions = { components: new Map() };
  for (const ep of endpoints) {
    const item = (paths[ep.path] ??= {});
    const method = ep.method.toLowerCase();
    // The same path and method on two unrelated sites cannot share one OpenAPI document.
    if (item[method]) {
      conflicts++;
      continue;
    }
    item[method] = endpointOperation(ep, multiOrigin, options, schemaOpts);
    tags.add(ep.tag);
  }
  const usedSchemes = new Set(endpoints.flatMap((e) => e.security));
  const securitySchemes: Doc = {};
  for (const key of usedSchemes) {
    const s = model.security[key];
    if (!s) continue;
    const out: Doc = { type: s.type };
    if (s.scheme) out.scheme = s.scheme;
    if (s.bearerFormat) out.bearerFormat = s.bearerFormat;
    if (s.in) out.in = s.in;
    if (s.name) out.name = s.name;
    securitySchemes[key] = out;
  }
  const siteCalls = new Map<string, number>();
  for (const e of endpoints) siteCalls.set(e.site, (siteCalls.get(e.site) ?? 0) + e.samples.length);
  const sites = [...siteCalls].sort((a, b) => b[1] - a[1]).map(([site]) => site);
  const defaultTitle =
    sites.length === 0
      ? 'Captured API'
      : sites.length === 1
        ? `${sites[0]} API`
        : `${sites[0]} API (and ${sites.length - 1} more ${sites.length === 2 ? 'site' : 'sites'})`;
  const doc: Doc = {
    openapi: '3.1.0',
    info: {
      title: options.title ?? defaultTitle,
      version: '0.1.0',
      description: `Inferred by apixray from ${model.stats.apiCalls} captured API calls. Generated from observed traffic, not from official documentation: fields that never appeared in the capture are missing, and optional fields may look required.${conflicts ? ` ${conflicts} operation(s) were left out because another site uses the same path; export each site separately to keep them.` : ''}`,
    },
    servers: origins.map((url) => ({ url })),
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
  };
  const components: Doc = {};
  if (schemaOpts.components!.size) {
    components.schemas = Object.fromEntries(
      [...schemaOpts.components!].sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  if (Object.keys(securitySchemes).length) components.securitySchemes = securitySchemes;
  if (Object.keys(components).length) doc.components = components;
  return doc;
}
