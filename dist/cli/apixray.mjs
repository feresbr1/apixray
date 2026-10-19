#!/usr/bin/env node

// src/cli/main.ts
import { mkdirSync, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

// src/core/auth.ts
var JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
var KEY_HEADER = /^(x-)?(api[-_]?key|apikey|auth[-_]?token|access[-_]?token|token|x-auth|x-access-key|x-functions-key|subscription-key|ocp-apim-subscription-key|x-[\w-]*-(key|token|secret))$/i;
var KEY_QUERY = /((^|[-_])(api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|secret|client[-_]?secret|signature|sig)|^key)$/i;
var SESSION_COOKIE = /sess|sid$|^sid|auth|token|jwt|login|remember/i;
function isJwt(value) {
  return JWT.test(value);
}
function detectAuth(headers, query) {
  const found = { schemes: [], headers: /* @__PURE__ */ new Set(), query: /* @__PURE__ */ new Set() };
  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (name === "authorization" || name === "proxy-authorization") {
      const [scheme = "", token = ""] = h.value.split(/\s+/, 2);
      found.headers.add(name);
      if (/^bearer$/i.test(scheme)) {
        found.schemes.push({
          key: "bearerAuth",
          type: "http",
          scheme: "bearer",
          ...isJwt(token) ? { bearerFormat: "JWT" } : {}
        });
      } else if (/^basic$/i.test(scheme)) {
        found.schemes.push({ key: "basicAuth", type: "http", scheme: "basic" });
      } else {
        found.schemes.push({
          key: "authorizationHeader",
          type: "apiKey",
          in: "header",
          name: "Authorization"
        });
      }
    } else if (KEY_HEADER.test(name) && !/^x-(csrf|xsrf)/.test(name)) {
      found.headers.add(name);
      found.schemes.push({ key: camelKey(h.name), type: "apiKey", in: "header", name: h.name });
    } else if (name === "cookie") {
      const names = h.value.split(";").map((c) => c.split("=")[0].trim()).filter((n) => n && SESSION_COOKIE.test(n));
      if (names.length) {
        found.headers.add(name);
        found.schemes.push({ key: "cookieAuth", type: "apiKey", in: "cookie", name: names[0] });
      } else {
        found.headers.add(name);
      }
    }
  }
  for (const [k] of query) {
    if (KEY_QUERY.test(k)) {
      found.query.add(k);
      found.schemes.push({ key: camelKey(`${k} query`), type: "apiKey", in: "query", name: k });
    }
  }
  return found;
}
function camelKey(s) {
  const parts = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return parts.map((p, i) => i === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase()).join("");
}

// src/core/har.ts
var HarError = class extends Error {
  name = "HarError";
};
function parseHar(text) {
  let data;
  try {
    data = JSON.parse(text.charCodeAt(0) === 65279 ? text.slice(1) : text);
  } catch {
    throw new HarError(
      'This is not JSON, so it is not a HAR file. In DevTools, open the Network tab and use "Save all as HAR" (or "Export HAR").'
    );
  }
  return toHar(data);
}
function toHar(data) {
  const log = data?.log;
  if (!log || !Array.isArray(log.entries)) {
    throw new HarError(
      'No "log.entries" found. Is this a HAR file exported from a browser or proxy?'
    );
  }
  const entries = log.entries.filter(
    (e) => typeof e?.request?.url === "string" && typeof e.request.method === "string" && typeof e.response?.status === "number"
  );
  return {
    log: {
      ...log,
      entries: entries.map((e) => ({
        ...e,
        request: { ...e.request, headers: e.request.headers ?? [] },
        response: { ...e.response, headers: e.response.headers ?? [] }
      }))
    }
  };
}
function header(headers, name) {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}
function responseText(entry) {
  const content = entry.response.content;
  if (!content?.text) return void 0;
  if (content.encoding === "base64") {
    try {
      const bin = atob(content.text);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return void 0;
    }
  }
  return content.text;
}

// src/core/classify.ts
var NOISE_HOSTS = [
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "facebook.com",
  "facebook.net",
  "connect.facebook.net",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "hotjar.com",
  "hotjar.io",
  "clarity.ms",
  "sentry.io",
  "ingest.sentry.io",
  "datadoghq.com",
  "browser-intake-datadoghq.com",
  "nr-data.net",
  "newrelic.com",
  "fullstory.com",
  "intercom.io",
  "intercomcdn.com",
  "launchdarkly.com",
  "optimizely.com",
  "bugsnag.com",
  "logrocket.io",
  "heap.io",
  "heapanalytics.com",
  "posthog.com",
  "plausible.io",
  "cloudflareinsights.com",
  "linkedin.com",
  "ads-twitter.com",
  "bing.com",
  "stripe.network",
  "recaptcha.net",
  "gstatic.com"
];
var NOISE_LABEL = /^(telemetry|analytics|metrics|tracking|tracker|stats|beacon|collector|collect|rum|insights|events?-?intake|log-?intake|pixel)[.-]/i;
function isNoiseHost(host) {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return NOISE_LABEL.test(h) || NOISE_HOSTS.some((n) => h === n || h.endsWith(`.${n}`));
}
var STATIC_EXT = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|wasm|pdf|zip)$/i;
var STATIC_TYPES = /* @__PURE__ */ new Set([
  "image",
  "stylesheet",
  "script",
  "font",
  "media",
  "manifest",
  "texttrack",
  "websocket",
  "ping",
  "preflight"
]);
function bodyKind(mime) {
  const m = (mime ?? "").toLowerCase();
  if (!m) return "none";
  if (m.includes("json")) return "json";
  if (m.includes("x-www-form-urlencoded")) return "form";
  if (m.includes("multipart/")) return "multipart";
  if (m.includes("xml")) return "xml";
  if (m.startsWith("text/")) return "text";
  return "other";
}
function tryJson(text) {
  if (text === void 0) return { ok: false };
  const t = text.trim();
  if (!t || t[0] !== "{" && t[0] !== "[") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false };
  }
}
function isApiCall(entry) {
  const { request, response } = entry;
  const method = request.method.toUpperCase();
  if (method === "OPTIONS" || method === "CONNECT") return false;
  if (!/^https?:/i.test(request.url)) return false;
  if (entry._resourceType && STATIC_TYPES.has(entry._resourceType)) return false;
  let path;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return false;
  }
  if (STATIC_EXT.test(path)) return false;
  const resMime = response.content?.mimeType ?? header(response.headers, "content-type");
  const reqMime = request.postData?.mimeType ?? header(request.headers, "content-type");
  const resKind = bodyKind(resMime);
  if (resKind === "json" || resKind === "xml") return true;
  const reqKind = bodyKind(reqMime);
  if (reqKind === "json") return true;
  if (method !== "GET" && method !== "HEAD" && (reqKind === "form" || reqKind === "multipart")) {
    return entry._resourceType !== "document";
  }
  if (resKind === "text" || resKind === "none" || resKind === "other") {
    if (entry._resourceType === "document") return false;
    if (tryJson(responseText(entry)).ok) return true;
  }
  if (method !== "GET" && method !== "HEAD" && entry._resourceType !== "document") {
    return entry._resourceType === "xhr" || entry._resourceType === "fetch" || response.status === 204;
  }
  return entry._resourceType === "xhr" || entry._resourceType === "fetch" ? resKind !== "other" && !/text\/html/i.test(resMime ?? "") : false;
}

// src/core/shape.ts
var MAX_TRACKED_STRINGS = 40;
var ID_KEY = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}.*|[0-9a-f]{24})$/i;
function emptyShape() {
  return { count: 0, nulls: 0, kinds: /* @__PURE__ */ new Set() };
}
function detectFormat(s) {
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s))
    return "date-time";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "date";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return "uuid";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "email";
  if (/^https?:\/\/\S+$/.test(s)) return "uri";
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return "ipv4";
  return void 0;
}
function observe(shape, value, depth = 0) {
  shape.count++;
  if (value === null || value === void 0) {
    shape.nulls++;
    return shape;
  }
  if (shape.example === void 0) shape.example = value;
  if (depth > 40) return shape;
  if (Array.isArray(value)) {
    shape.kinds.add("array");
    shape.items ??= emptyShape();
    for (const item of value.slice(0, 200)) observe(shape.items, item, depth + 1);
    return shape;
  }
  switch (typeof value) {
    case "string": {
      shape.kinds.add("string");
      const st = shape.strings ??= {
        values: /* @__PURE__ */ new Map(),
        formats: /* @__PURE__ */ new Map(),
        n: 0,
        overflow: false
      };
      st.n++;
      const f = detectFormat(value);
      if (f) st.formats.set(f, (st.formats.get(f) ?? 0) + 1);
      if (st.values.has(value)) st.values.set(value, st.values.get(value) + 1);
      else if (st.values.size < MAX_TRACKED_STRINGS) st.values.set(value, 1);
      else st.overflow = true;
      return shape;
    }
    case "number":
      shape.kinds.add(Number.isInteger(value) ? "integer" : "number");
      return shape;
    case "boolean":
      shape.kinds.add("boolean");
      return shape;
    case "object": {
      const obj = value;
      const keys = Object.keys(obj);
      shape.kinds.add("object");
      if (keys.length >= 2 && keys.every((k) => ID_KEY.test(k))) {
        shape.map ??= emptyShape();
        for (const k of keys) observe(shape.map, obj[k], depth + 1);
        shape.objects = (shape.objects ?? 0) + 1;
        return shape;
      }
      shape.objects = (shape.objects ?? 0) + 1;
      shape.props ??= /* @__PURE__ */ new Map();
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
function mergeShapes(a, b) {
  a.count += b.count;
  a.nulls += b.nulls;
  for (const k of b.kinds) a.kinds.add(k);
  if (a.example === void 0) a.example = b.example;
  if (b.strings) {
    const st = a.strings ??= { values: /* @__PURE__ */ new Map(), formats: /* @__PURE__ */ new Map(), n: 0, overflow: false };
    st.n += b.strings.n;
    st.overflow ||= b.strings.overflow;
    for (const [f, n] of b.strings.formats) st.formats.set(f, (st.formats.get(f) ?? 0) + n);
    for (const [v, n] of b.strings.values) {
      if (st.values.has(v)) st.values.set(v, st.values.get(v) + n);
      else if (st.values.size < MAX_TRACKED_STRINGS) st.values.set(v, n);
      else st.overflow = true;
    }
  }
  if (b.objects) a.objects = (a.objects ?? 0) + b.objects;
  if (b.props) {
    a.props ??= /* @__PURE__ */ new Map();
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
function cloneShape(s) {
  return mergeShapes(emptyShape(), s);
}
function refTo(target, opts) {
  const name = target.refName;
  const components = opts.components ??= /* @__PURE__ */ new Map();
  if (!components.has(name)) {
    components.set(name, {});
    components.set(name, toSchema(target, opts, "", true));
  }
  return { $ref: `${opts.refPrefix ?? "#/components/schemas/"}${name}` };
}
function toSchema(shape, opts = {}, key2 = "", asComponent = false) {
  if (shape.ref) return refTo(shape.ref, opts);
  if (shape.refName && !asComponent) return refTo(shape, opts);
  const kinds = [...shape.kinds];
  const types = kinds.includes("number") ? kinds.filter((k) => k !== "integer") : kinds;
  const nullable = shape.nulls > 0;
  if (types.length === 0) return nullable ? { type: "null" } : {};
  const schema = {};
  const all = nullable ? [...types, "null"] : types;
  schema.type = all.length === 1 ? all[0] : all;
  if (types.length === 1 && types[0] === "string" && shape.strings) {
    const st = shape.strings;
    const formats = [...st.formats];
    if (formats.length === 1 && formats[0][1] === st.n) schema.format = formats[0][0];
    const distinct = st.values.size;
    const looksEnum = !st.overflow && !schema.format && distinct >= 2 && distinct <= 8 && st.n >= Math.max(4, distinct * 2) && [...st.values.keys()].every((v) => v.length > 0 && v.length <= 32 && !/\s{2,}/.test(v));
    if (looksEnum && !isSensitiveKey(key2)) schema.enum = [...st.values.keys()].sort();
  }
  if (types.includes("object")) {
    if (shape.map && !shape.props) {
      schema.additionalProperties = toSchema(shape.map, opts, key2);
    } else if (shape.props) {
      schema.properties = {};
      const required = [];
      for (const [k, p] of shape.props) {
        schema.properties[k] = toSchema(p, opts, k);
        if (p.count === shape.objects) required.push(k);
      }
      if (required.length) schema.required = required;
    }
  }
  if (types.includes("array")) {
    schema.items = shape.items && shape.items.kinds.size + shape.items.nulls > 0 ? toSchema(shape.items, opts, key2) : {};
  }
  const leaf = !types.includes("object") && !types.includes("array");
  if (opts.examples && leaf && shape.example !== void 0 && !schema.enum) {
    const ex = opts.redact ? opts.redact(key2, shape.example) : shape.example;
    schema.examples = [ex];
  }
  return schema;
}
var SENSITIVE = /password|passwd|passphrase|^pass$|secret|token|api[-_]?key|apikey|^auth$|auth[-_]?(token|key|code)|authorization|session|cookie|credential|private[-_]?key|signature|^ssn$|cvv|card[-_]?number/i;
function isSensitiveKey(key2) {
  return SENSITIVE.test(key2);
}
function objectKeys(s) {
  return new Set(s.props ? s.props.keys() : []);
}
function foldRecursion(root, rootName, names) {
  const ancestors = [];
  const nameFor = (key2) => {
    let base = pascalName(singularWord(key2)) || rootName;
    if (!/^[A-Za-z]/.test(base)) base = `T${base}`;
    let n = base;
    for (let i = 2; names.has(n); i++) n = `${base}${i}`;
    names.add(n);
    return n;
  };
  const visit = (shape, key2, depth) => {
    if (depth > 60 || shape.ref) return;
    if (shape.props && shape.props.size >= 3) {
      const keys = objectKeys(shape);
      const match = ancestors.find((a) => similarity(objectKeys(a.shape), keys) >= 0.7);
      if (match) {
        const copy = cloneShape(shape);
        copy.count = 0;
        mergeShapes(match.shape, copy);
        match.shape.refName ??= nameFor(match.key || rootName);
        shape.ref = match.shape;
        delete shape.props;
        delete shape.items;
        delete shape.map;
        return;
      }
      ancestors.push({ shape, key: key2 });
      for (const [k, p] of shape.props) visit(p, k, depth + 1);
      ancestors.pop();
    } else if (shape.props) {
      for (const [k, p] of shape.props) visit(p, k, depth + 1);
    }
    if (shape.items) visit(shape.items, key2, depth + 1);
    if (shape.map) visit(shape.map, key2, depth + 1);
  };
  visit(root, "", 0);
}
function singularWord(word) {
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(ss|us|is)$/i.test(word)) return word;
  if (/(x|ch|sh)es$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word)) return word.slice(0, -1);
  return word;
}
function pascalName(s) {
  return s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
}
function fingerprint(shape, prefix = "", depth = 0, out = /* @__PURE__ */ new Set()) {
  if (depth > 3) return out;
  for (const k of shape.kinds) out.add(`${prefix}:${k === "integer" ? "number" : k}`);
  if (shape.props)
    for (const [k, p] of shape.props) fingerprint(p, `${prefix}.${k}`, depth + 1, out);
  if (shape.map) fingerprint(shape.map, `${prefix}.*`, depth + 1, out);
  if (shape.items) fingerprint(shape.items, `${prefix}[]`, depth + 1, out);
  return out;
}
function similarity(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// src/core/analyze.ts
function toSample(entry) {
  let url;
  try {
    url = new URL(entry.request.url);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const query = [...url.searchParams.entries()];
  const reqMime = entry.request.postData?.mimeType || header(entry.request.headers, "content-type");
  const reqKind = entry.request.postData ? bodyKind(reqMime) : "none";
  let reqBody;
  let reqFields;
  const text = entry.request.postData?.text;
  if (reqKind === "json" || reqKind === "text" && text) {
    const j = tryJson(text);
    if (j.ok) reqBody = j.value;
  } else if (reqKind === "form") {
    reqFields = entry.request.postData?.params?.length ? entry.request.postData.params.map((p) => [p.name, p.value ?? ""]) : [...new URLSearchParams(text ?? "").entries()];
  } else if (reqKind === "multipart") {
    reqFields = (entry.request.postData?.params ?? []).map((p) => [p.name, p.value ?? ""]);
  }
  const resMime = entry.response.content?.mimeType || header(entry.response.headers, "content-type");
  const body = responseText(entry);
  const parsed = tryJson(body);
  const resKind = parsed.ok ? "json" : bodyKind(resMime);
  const auth = detectAuth(entry.request.headers, query);
  return {
    entry,
    method: entry.request.method.toUpperCase(),
    origin: url.origin,
    host: url.host,
    segments,
    query,
    requestHeaders: entry.request.headers,
    reqKind: reqBody !== void 0 ? "json" : reqKind,
    reqMime: reqMime?.split(";")[0]?.trim(),
    reqBody,
    reqFields,
    status: entry.response.status,
    resKind,
    resMime: resMime?.split(";")[0]?.trim(),
    resBody: parsed.ok ? parsed.value : void 0,
    hasResBody: body !== void 0 && body.length > 0,
    durationMs: typeof entry.time === "number" && entry.time >= 0 ? entry.time : void 0,
    security: auth.schemes,
    secretHeaders: auth.headers,
    secretQuery: auth.query
  };
}
function segmentKind(seg) {
  if (/^\d+$/.test(seg)) return "integer";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return "uuid";
  if (/^\d{4}-\d{2}-\d{2}$/.test(seg)) return "date";
  if (/^[0-9a-f]{12,}$/i.test(seg) && /\d/.test(seg) && /[a-f]/i.test(seg)) return "hex";
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(seg)) return "token";
  if (/^[A-Za-z0-9_-]{16,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return "token";
  if (/^[A-Za-z_-]{0,12}\d{3,}[A-Za-z0-9_-]*$/.test(seg) && /\d{3,}/.test(seg)) return "id";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(seg)) return "string";
  return null;
}
var RESERVED = new Set(
  "me self current search new count all latest list batch bulk export import stats settings config login logout signin signup register auth token refresh health status version info details summary feed graphql query mine recent popular trending top default random".split(
    " "
  )
);
function newNode() {
  return { samples: [], children: /* @__PURE__ */ new Map(), paramKinds: /* @__PURE__ */ new Set(), values: [] };
}
function insert(root, sample) {
  let node = root;
  for (const [i, seg] of sample.segments.entries()) {
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
function mergeInto(target, src, srcValue) {
  target.samples.push(...src.samples);
  for (const k of src.paramKinds) target.paramKinds.add(k);
  if (srcValue !== void 0) {
    target.paramKinds.add("string");
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
function nodeFingerprint(node) {
  const fp = /* @__PURE__ */ new Set();
  const walk = (n, rel, depth) => {
    for (const s of n.samples) {
      if (s.status >= 200 && s.status < 300 && s.resBody !== void 0) {
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
  walk(node, "", 0);
  return fp;
}
function generalize(node) {
  const literals = [...node.children].filter(([seg]) => !RESERVED.has(seg.toLowerCase()));
  if (literals.length >= 2 || literals.length >= 1 && node.param) {
    const fps = new Map(literals.map(([seg, c]) => [seg, nodeFingerprint(c)]));
    const groups = [];
    if (node.param) groups.push({ segs: ["{param}"], fp: nodeFingerprint(node.param) });
    for (const [seg] of literals) {
      const fp = fps.get(seg);
      if (fp.size < 3) continue;
      const threshold = /^[a-z]+(-[a-z]+)*$/.test(seg) ? 0.8 : 0.5;
      const g = groups.find((x) => similarity(x.fp, fp) >= threshold);
      if (g) g.segs.push(seg);
      else groups.push({ segs: [seg], fp });
    }
    for (const g of groups) {
      const values = g.segs.filter((s) => s !== "{param}");
      const hasParam = g.segs.includes("{param}");
      if (values.length + (hasParam ? 1 : 0) < 2) continue;
      node.param ??= newNode();
      for (const seg of values) {
        mergeInto(node.param, node.children.get(seg), seg);
        node.children.delete(seg);
      }
    }
  }
  for (const c of node.children.values()) generalize(c);
  if (node.param) generalize(node.param);
}
function singular(word) {
  const w = word.toLowerCase();
  if (/ies$/.test(w)) return word.slice(0, -3) + "y";
  if (/(ss|us|is)$/.test(w)) return word;
  if (/(x|ch|sh|ses)es$/.test(w)) return word.slice(0, -2);
  if (/s$/.test(w)) return word.slice(0, -1);
  return word;
}
function camel(words) {
  const parts = words.flatMap((w) => w.split(/[^A-Za-z0-9]+/)).filter(Boolean);
  return parts.map((p, i) => i === 0 ? p[0].toLowerCase() + p.slice(1) : p[0].toUpperCase() + p.slice(1)).join("");
}
function pascal(words) {
  const c = camel(words);
  return c ? c[0].toUpperCase() + c.slice(1) : "";
}
function paramName(prev, kinds, used) {
  const idLike = [...kinds].some((k) => k !== "string" && k !== "date");
  let base;
  if (!prev || /^v\d+$/i.test(prev) || prev === "api") base = idLike ? "id" : "name";
  else if ([...kinds].every((k) => k === "date")) base = camel([singular(prev), "date"]);
  else base = camel([singular(prev), idLike ? "id" : "name"]);
  if (!/^[A-Za-z_]/.test(base)) base = `p${base}`;
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}${i}`;
  used.add(name);
  return name;
}
function collect(node, prefix, out) {
  if (node.samples.length) out.push({ segments: prefix, samples: node.samples });
  for (const [seg, c] of node.children) collect(c, [...prefix, { literal: seg }], out);
  if (node.param) {
    const usedHere = new Set(prefix.filter((s) => s.param).map((s) => s.param));
    const name = paramName(prefix.at(-1)?.literal, node.param.paramKinds, usedHere);
    collect(
      node.param,
      [...prefix, { param: name, kinds: node.param.paramKinds, values: node.param.values }],
      out
    );
  }
}
var BASE_SEGMENT = /^(api|apis|rest|v\d+(\.\d+)*|\d{1,2}|public|internal)$/i;
function coerce(value) {
  if (/^-?\d+$/.test(value) && value.length < 16) return Number(value);
  if (/^-?\d*\.\d+$/.test(value)) return Number(value);
  if (value === "true" || value === "false") return value === "true";
  return value;
}
var IGNORED_HEADERS = new Set(
  "accept accept-encoding accept-language cache-control connection content-length content-type cookie host origin pragma referer user-agent te priority dnt upgrade-insecure-requests if-none-match if-modified-since x-requested-with x-client-data purpose".split(
    " "
  )
);
function customHeaders(s) {
  return s.requestHeaders.filter((h) => {
    const n = h.name.toLowerCase();
    if (n.startsWith(":") || n.startsWith("sec-") || IGNORED_HEADERS.has(n)) return false;
    if (s.secretHeaders.has(n)) return false;
    return n.startsWith("x-") || /^(api-|client-|app-)/.test(n);
  });
}
function analyze(har, opts = {}) {
  const entries = har.log.entries;
  const stats = {
    entries: entries.length,
    apiCalls: 0,
    skippedStatic: 0,
    noiseCalls: 0,
    withoutBodies: 0
  };
  const samples = [];
  const originCalls = /* @__PURE__ */ new Map();
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
    if (!s.hasResBody && s.status !== 204 && s.method !== "HEAD") stats.withoutBodies++;
    samples.push(s);
  }
  const bySite = /* @__PURE__ */ new Map();
  for (const s of samples) {
    const key2 = siteOf(s.host);
    const list = bySite.get(key2) ?? [];
    list.push(s);
    bySite.set(key2, list);
  }
  const endpoints = [];
  const security = {};
  for (const [site, list] of bySite) {
    const root = newNode();
    for (const s of list) insert(root, s);
    generalize(root);
    const templates = [];
    collect(root, [], templates);
    let base = [];
    const first = templates[0]?.segments ?? [];
    for (let i = 0; i < first.length; i++) {
      const lit = first[i].literal;
      if (!lit || !BASE_SEGMENT.test(lit)) break;
      if (!templates.every((t) => t.segments[i]?.literal === lit && t.segments.length > i + 1))
        break;
      base.push(lit);
    }
    if (templates.length === 0) base = [];
    const basePath = base.length ? `/${base.join("/")}` : "";
    for (const t of templates) {
      const rel = t.segments.slice(base.length);
      const path = "/" + rel.map((s) => s.param ? `{${s.param}}` : encodeSegment(s.literal)).join("/");
      const byMethod = /* @__PURE__ */ new Map();
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
  const origins = [...originCalls].map(([origin, o]) => {
    const own = endpoints.filter((e) => e.servers.some((sv) => sv.startsWith(origin)));
    return {
      origin,
      calls: o.calls,
      endpoints: own.length,
      noise: o.noise,
      basePath: own[0]?.basePath ?? ""
    };
  });
  origins.sort((a, b) => b.calls - a.calls);
  uniqueOperationIds(endpoints);
  const names = /* @__PURE__ */ new Set();
  for (const ep of endpoints) {
    const root = pascal([singular(ep.tag)]) || "Item";
    for (const r of ep.responses) if (r.shape) foldRecursion(r.shape, root, names);
    if (ep.requestBody) foldRecursion(ep.requestBody.shape, root, names);
  }
  endpoints.sort(
    (a, b) => a.site !== b.site ? a.site < b.site ? -1 : 1 : a.origin !== b.origin ? a.origin < b.origin ? -1 : 1 : a.path === b.path ? METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method) : a.path < b.path ? -1 : 1
  );
  return { endpoints, origins, security, stats };
}
var METHOD_ORDER = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
function siteOf(host) {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (/^[\d.]+$/.test(h) || h === "localhost" || !h.includes(".")) return host.toLowerCase();
  const labels = h.split(".");
  const second = labels.at(-2) ?? "";
  const take = labels.at(-1).length === 2 && /^(co|com|net|org|gov|ac|edu|ne|or|go)$/.test(second) ? 3 : 2;
  return labels.slice(-take).join(".");
}
function encodeSegment(s) {
  return s.replace(/[{}?#\s]/g, (c) => encodeURIComponent(c));
}
function buildEndpoint(site, basePath, path, rel, method, samples) {
  const params = [];
  const offset = samples[0].segments.length - rel.length;
  rel.forEach((seg, i) => {
    if (!seg.param) return;
    const shape = emptyShape();
    for (const s of samples) {
      const v = s.segments[offset + i];
      if (v !== void 0) observe(shape, coerce(v));
    }
    const kinds = [...seg.kinds ?? []];
    params.push({
      name: seg.param,
      in: "path",
      required: true,
      shape,
      kind: kinds.length === 1 ? kinds[0] : kinds.includes("string") ? "string" : kinds[0]
    });
  });
  const query = /* @__PURE__ */ new Map();
  for (const s of samples) {
    const seen = /* @__PURE__ */ new Map();
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
      shape.kinds.add("array");
      shape.items = q.shape;
    }
    params.push({
      name,
      in: "query",
      required: q.present === samples.length && samples.length > 1,
      shape
    });
  }
  const headers = /* @__PURE__ */ new Map();
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
      in: "header",
      required: h.present === samples.length && samples.length > 1,
      shape: h.shape
    });
  }
  let requestBody;
  const withBody = samples.filter((s) => s.reqBody !== void 0 || s.reqFields);
  if (withBody.length) {
    const shape = emptyShape();
    for (const s of withBody) {
      if (s.reqBody !== void 0) observe(shape, s.reqBody);
      else observe(shape, Object.fromEntries(s.reqFields.map(([k, v]) => [k, coerce(v)])));
    }
    const first = withBody[0];
    requestBody = {
      mime: first.reqKind === "json" ? "application/json" : first.reqKind === "form" ? "application/x-www-form-urlencoded" : first.reqKind === "multipart" ? "multipart/form-data" : first.reqMime ?? "application/octet-stream",
      kind: first.reqKind,
      shape
    };
  }
  const responses = /* @__PURE__ */ new Map();
  for (const s of samples) {
    const r = responses.get(s.status) ?? {
      status: s.status,
      count: 0,
      kind: s.resKind,
      mime: s.resMime
    };
    r.count++;
    if (s.resBody !== void 0) {
      r.shape ??= emptyShape();
      observe(r.shape, s.resBody);
      r.kind = "json";
      r.mime = s.resMime && /json/i.test(s.resMime) ? s.resMime : "application/json";
    }
    responses.set(s.status, r);
  }
  const literals = rel.filter((s) => s.literal).map((s) => s.literal);
  const tag = literals.find((l) => !BASE_SEGMENT.test(l)) ?? literals[0] ?? "root";
  const times = samples.map((s) => s.durationMs).filter((t) => t !== void 0);
  const securityKeys = [...new Set(samples.flatMap((s) => s.security.map((x) => x.key)))];
  const examples = [...new Set(samples.map((s) => s.entry.request.url.split("#")[0]))].slice(0, 5);
  const originCount = /* @__PURE__ */ new Map();
  for (const s of samples) originCount.set(s.origin, (originCount.get(s.origin) ?? 0) + 1);
  const origin = [...originCount].sort((a, b) => b[1] - a[1])[0][0];
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
    avgMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : void 0
  };
}
var ACTIONS = new Set(
  "query search cancel login logout signin signout refresh publish unpublish archive approve reject send verify reset upload import export sync validate execute run start stop restart resolve close open like unlike follow unfollow subscribe unsubscribe confirm complete submit retry checkout pay".split(
    " "
  )
);
function operationName(method, rel, responses) {
  const last = rel.at(-1);
  const lits = rel.filter((s) => s.literal && !BASE_SEGMENT.test(s.literal)).map((s) => s.literal);
  const resource = lits.at(-1) ?? "root";
  const parents = lits.slice(0, -1).map(singular);
  const endsWithParam = Boolean(last?.param);
  const ok = [...responses.values()].find((r) => r.status >= 200 && r.status < 300);
  const returnsArray = ok?.shape ? ok.shape.kinds.has("array") || [...ok.shape.props ?? []].some(
    ([k, p]) => /^(items|data|results|hits|records|entries|list|rows|nodes|edges|content)$/i.test(k) && p.kinds.has("array")
  ) : false;
  let verb;
  let noun;
  switch (method) {
    case "GET":
      if (!endsWithParam && (resource === "search" || resource === "query")) {
        return camel([resource, ...lits.slice(0, -1).map(singular)]);
      }
      verb = endsWithParam || !returnsArray ? "get" : "list";
      noun = endsWithParam ? singular(resource) : resource;
      break;
    case "POST":
      if (!endsWithParam && lits.length >= 2 && ACTIONS.has(resource.toLowerCase())) {
        return camel([resource, singular(lits.at(-2))]) || "post";
      }
      if (!endsWithParam && rel.length >= 2 && rel.at(-2)?.param) {
        verb = resource;
        noun = singular(lits.at(-2) ?? "");
        return camel([verb, noun]) || "post";
      }
      verb = "create";
      noun = singular(resource);
      break;
    case "PUT":
    case "PATCH":
      verb = method === "PUT" ? "replace" : "update";
      noun = singular(resource);
      break;
    case "DELETE":
      verb = "delete";
      noun = singular(resource);
      break;
    default:
      verb = method.toLowerCase();
      noun = resource;
  }
  return camel([verb, ...parents, noun]) || method.toLowerCase();
}
function uniqueOperationIds(endpoints) {
  const groups = /* @__PURE__ */ new Map();
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
      let candidate;
      if (multiOrigin) {
        const label = ep.site.split(".")[0];
        candidate = `${id}${pascal([label])}`;
      } else {
        const params = ep.params.filter((p) => p.in === "path").map((p) => p.name);
        candidate = params.length ? `${id}By${pascal(params)}` : `${id}${i + 1}`;
      }
      let unique = candidate;
      for (let n = 2; taken.has(unique); n++) unique = `${candidate}${n}`;
      taken.add(unique);
      ep.operationId = unique;
    }
  }
}

// src/core/redact.ts
var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function redactValue(key2, value) {
  if (value === null || value === void 0) return value;
  if (isSensitiveKey(key2))
    return typeof value === "string" || typeof value === "number" ? "<redacted>" : value;
  if (typeof value === "string") {
    if (isJwt(value)) return "<redacted-jwt>";
    if (EMAIL.test(value)) return "user@example.com";
  }
  return value;
}
function redactDeep(value, key2 = "") {
  if (key2 && isSensitiveKey(key2) && value && typeof value === "object") return "<redacted>";
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, key2));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = v && typeof v === "object" ? redactDeep(v, k) : redactValue(k, v);
    }
    return out;
  }
  return redactValue(key2, value);
}

// src/core/openapi.ts
var STATUS_TEXT = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable"
};
function summaryOf(operationId) {
  const words = operationId.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function trimExample(value, depth = 0) {
  if (Array.isArray(value)) return value.slice(0, 3).map((v) => trimExample(v, depth + 1));
  if (value && typeof value === "object") {
    if (depth >= 6) return {};
    const out = {};
    for (const [k, v] of Object.entries(value))
      out[k] = trimExample(v, depth + 1);
    return out;
  }
  if (typeof value === "string" && value.length > 300) return `${value.slice(0, 297)}...`;
  return value;
}
function paramSchema(p) {
  const schema = toSchema(p.shape);
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => t !== "null");
    schema.type = types.length === 1 ? types[0] : types;
  }
  if (p.kind === "uuid") schema.format = "uuid";
  if (p.kind === "date") schema.format = "date";
  return schema;
}
function endpointOperation(ep, multiOrigin, options = {}, schemaOpts = {}) {
  const opts = { examples: options.examples ?? true, redact: options.redact ?? true };
  const redact = opts.redact ? redactValue : (_k, v) => v;
  const op = {
    operationId: ep.operationId,
    summary: summaryOf(ep.operationId),
    tags: [ep.tag]
  };
  if (multiOrigin) op.servers = ep.servers.map((url) => ({ url }));
  const params = ep.params.map((p) => {
    const out = {
      name: p.name,
      in: p.in,
      required: p.in === "path" ? true : p.required,
      schema: paramSchema(p)
    };
    const example = p.shape.items ? p.shape.items.example : p.shape.example;
    if (opts.examples && example !== void 0) out.example = redact(p.name, example);
    return out;
  });
  if (params.length) op.parameters = params;
  if (ep.requestBody) {
    const schema = toSchema(ep.requestBody.shape, schemaOpts);
    const media = { schema };
    const sample = ep.samples.find((s) => s.reqBody !== void 0);
    if (opts.examples && sample) {
      media.example = trimExample(opts.redact ? redactDeep(sample.reqBody) : sample.reqBody);
    }
    op.requestBody = { required: true, content: { [ep.requestBody.mime]: media } };
  }
  const responses = {};
  for (const r of ep.responses) {
    const res = { description: STATUS_TEXT[r.status] ?? `Status ${r.status}` };
    if (r.shape) {
      const media = { schema: toSchema(r.shape, schemaOpts) };
      const sample = ep.samples.find((s) => s.status === r.status && s.resBody !== void 0);
      if (opts.examples && sample) {
        media.example = trimExample(opts.redact ? redactDeep(sample.resBody) : sample.resBody);
      }
      res.content = { [r.mime ?? "application/json"]: media };
    } else if (r.mime && r.status !== 204 && r.status !== 304) {
      res.content = { [r.mime]: {} };
    }
    responses[String(r.status)] = res;
  }
  if (!ep.responses.length) responses.default = { description: "No response captured" };
  op.responses = responses;
  if (ep.security.length) op.security = ep.security.map((k) => ({ [k]: [] }));
  const ext = { calls: ep.samples.length };
  if (ep.avgMs !== void 0) ext.avgMs = Math.round(ep.avgMs);
  op["x-apixray"] = ext;
  return op;
}
function toOpenApi(model, options = {}) {
  const endpoints = options.include ? model.endpoints.filter((e) => options.include.has(e.id)) : model.endpoints;
  const origins = [...new Set(endpoints.flatMap((e) => e.servers))];
  const multiOrigin = origins.length > 1;
  const paths = {};
  const tags = /* @__PURE__ */ new Set();
  let conflicts = 0;
  const schemaOpts = { components: /* @__PURE__ */ new Map() };
  for (const ep of endpoints) {
    const item = paths[ep.path] ??= {};
    const method = ep.method.toLowerCase();
    if (item[method]) {
      conflicts++;
      continue;
    }
    item[method] = endpointOperation(ep, multiOrigin, options, schemaOpts);
    tags.add(ep.tag);
  }
  const usedSchemes = new Set(endpoints.flatMap((e) => e.security));
  const securitySchemes = {};
  for (const key2 of usedSchemes) {
    const s = model.security[key2];
    if (!s) continue;
    const out = { type: s.type };
    if (s.scheme) out.scheme = s.scheme;
    if (s.bearerFormat) out.bearerFormat = s.bearerFormat;
    if (s.in) out.in = s.in;
    if (s.name) out.name = s.name;
    securitySchemes[key2] = out;
  }
  const siteCalls = /* @__PURE__ */ new Map();
  for (const e of endpoints) siteCalls.set(e.site, (siteCalls.get(e.site) ?? 0) + e.samples.length);
  const sites = [...siteCalls].sort((a, b) => b[1] - a[1]).map(([site]) => site);
  const defaultTitle = sites.length === 0 ? "Captured API" : sites.length === 1 ? `${sites[0]} API` : `${sites[0]} API (and ${sites.length - 1} more ${sites.length === 2 ? "site" : "sites"})`;
  const doc = {
    openapi: "3.1.0",
    info: {
      title: options.title ?? defaultTitle,
      version: "0.1.0",
      description: `Inferred by apixray from ${model.stats.apiCalls} captured API calls. Generated from observed traffic, not from official documentation: fields that never appeared in the capture are missing, and optional fields may look required.${conflicts ? ` ${conflicts} operation(s) were left out because another site uses the same path; export each site separately to keep them.` : ""}`
    },
    servers: origins.map((url) => ({ url })),
    tags: [...tags].sort().map((name) => ({ name })),
    paths
  };
  const components = {};
  if (schemaOpts.components.size) {
    components.schemas = Object.fromEntries(
      [...schemaOpts.components].sort(([a], [b]) => a.localeCompare(b))
    );
  }
  if (Object.keys(securitySchemes).length) components.securitySchemes = securitySchemes;
  if (Object.keys(components).length) doc.components = components;
  return doc;
}

// src/core/typescript.ts
var IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function prop(name) {
  return IDENT.test(name) ? name : JSON.stringify(name);
}
function pascal2(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function schemaToTs(schema, indent = "") {
  if (schema.$ref) return schema.$ref.split("/").pop();
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  const types = schema.type === void 0 ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length === 0) return "unknown";
  const parts = types.map((t) => {
    switch (t) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array": {
        const item = schema.items ? schemaToTs(schema.items, indent) : "unknown";
        return /[|&]/.test(item) ? `Array<${item}>` : `${item}[]`;
      }
      case "object": {
        if (schema.properties) {
          const inner = `${indent}  `;
          const req = new Set(schema.required ?? []);
          const lines = Object.entries(schema.properties).map(
            ([k, v]) => `${inner}${prop(k)}${req.has(k) ? "" : "?"}: ${schemaToTs(v, inner)};`
          );
          return lines.length ? `{
${lines.join("\n")}
${indent}}` : "Record<string, unknown>";
        }
        if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          return `Record<string, ${schemaToTs(schema.additionalProperties, indent)}>`;
        }
        return "Record<string, unknown>";
      }
      default:
        return "unknown";
    }
  });
  return [...new Set(parts)].join(" | ");
}
function okResponse(ep) {
  return ep.responses.find((r) => r.status >= 200 && r.status < 300 && r.shape);
}
function toTypeScript(model, opts = {}) {
  const endpoints = opts.include ? model.endpoints.filter((e) => opts.include.has(e.id)) : model.endpoints;
  const servers = [...new Set(endpoints.map((e) => `${e.origin}${e.basePath}`))];
  const out = [];
  out.push(
    "// Generated by apixray (https://github.com/feresbr1/apixray) from captured traffic.",
    "// Types reflect what was observed, not an official contract: review before relying on them.",
    "/* eslint-disable */",
    ""
  );
  const types = [];
  const methods = [];
  const schemaOpts = { components: /* @__PURE__ */ new Map() };
  for (const ep of endpoints) {
    const name = pascal2(ep.operationId);
    const ok = okResponse(ep);
    let resType = "void";
    if (ok?.shape) {
      types.push(`export type ${name}Response = ${schemaToTs(toSchema(ok.shape, schemaOpts))};`);
      resType = `${name}Response`;
    } else if (ep.responses.some((r) => r.status < 400 && r.shape)) {
      resType = "unknown";
    }
    let bodyType;
    if (ep.requestBody) {
      types.push(
        `export type ${name}Body = ${schemaToTs(toSchema(ep.requestBody.shape, schemaOpts))};`
      );
      bodyType = `${name}Body`;
    }
    const pathParams = ep.params.filter((p) => p.in === "path");
    const queryParams = ep.params.filter((p) => p.in === "query");
    const headerParams = ep.params.filter((p) => p.in === "header");
    const fields = [];
    for (const p of pathParams)
      fields.push(`${prop(p.name)}: ${schemaToTs(stripNull(toSchema(p.shape)))}`);
    for (const p of queryParams) {
      fields.push(
        `${prop(p.name)}${p.required ? "" : "?"}: ${schemaToTs(stripNull(toSchema(p.shape)))}`
      );
    }
    for (const p of headerParams) fields.push(`${prop(p.name)}${p.required ? "" : "?"}: string`);
    if (bodyType) fields.push(`body: ${bodyType}`);
    const allOptional = fields.every((f) => /^[^:]+\?:/.test(f));
    const argType = fields.length ? `{ ${fields.join("; ")} }` : "";
    const arg = fields.length ? `params: ${argType}${allOptional ? " = {}" : ""}, ` : "";
    const urlPath = ep.path.replace(
      /\{([^}]+)\}/g,
      (_m, p) => `\${encodeURIComponent(String(params.${IDENT.test(p) ? p : `[${JSON.stringify(p)}]`}))}`
    );
    const query = queryParams.length ? `{ ${queryParams.map((p) => `${prop(p.name)}: params${IDENT.test(p.name) ? `.${p.name}` : `[${JSON.stringify(p.name)}]`}`).join(", ")} }` : "undefined";
    const headers = headerParams.length ? `{ ${headerParams.map((p) => `${JSON.stringify(p.name)}: params[${JSON.stringify(p.name)}]`).join(", ")} }` : "undefined";
    const server = servers.indexOf(`${ep.origin}${ep.basePath}`);
    methods.push(
      `  /** ${ep.method} ${ep.path}${ep.samples.length ? ` (seen ${ep.samples.length}\xD7)` : ""} */`,
      `  ${ep.operationId}(${arg}init?: RequestInit): Promise<${resType}> {`,
      `    return this.request(${server}, ${JSON.stringify(ep.method)}, \`${urlPath}\`, ${query}, ${bodyType ? "params.body" : "undefined"}, ${headers}, init${ep.requestBody && ep.requestBody.kind !== "json" ? `, ${JSON.stringify(ep.requestBody.mime)}` : ""});`,
      "  }",
      ""
    );
  }
  for (const [name, schema] of [...schemaOpts.components].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`export type ${name} = ${schemaToTs(schema)};`);
  }
  out.push(...types, "");
  out.push(
    "export class ApiError extends Error {",
    "  constructor(public status: number, public body: unknown) {",
    "    super(`HTTP ${status}`);",
    "  }",
    "}",
    "",
    "export interface ClientOptions {",
    `  /** Base URLs, in this order: ${servers.map((s) => JSON.stringify(s)).join(", ")} */`,
    "  servers?: string[];",
    "  /** Sent with every request, e.g. { headers: { Authorization: `Bearer ${token}` } } */",
    "  init?: RequestInit;",
    "  /** Query parameters added to every request, e.g. an API key: { api_key: key } */",
    "  query?: Record<string, string>;",
    "  fetch?: typeof fetch;",
    "}",
    "",
    "export class ApiClient {",
    `  servers = ${JSON.stringify(servers)};`,
    "  private init: RequestInit;",
    "  private query: Record<string, string>;",
    "  private fetchImpl: typeof fetch;",
    "",
    "  constructor(options: ClientOptions = {}) {",
    "    if (options.servers) this.servers = options.servers;",
    "    this.init = options.init ?? {};",
    "    this.query = options.query ?? {};",
    "    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);",
    "  }",
    "",
    "  private async request<T>(",
    "    server: number,",
    "    method: string,",
    "    path: string,",
    "    query?: Record<string, unknown>,",
    "    body?: unknown,",
    "    headers?: Record<string, string | undefined>,",
    "    init?: RequestInit,",
    "    contentType = 'application/json',",
    "  ): Promise<T> {",
    "    const url = new URL(this.servers[server] + path);",
    "    for (const [k, v] of Object.entries({ ...this.query, ...query })) {",
    "      if (v === undefined || v === null) continue;",
    "      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));",
    "    }",
    "    const h = new Headers(this.init.headers);",
    "    for (const [k, v] of Object.entries(init?.headers ?? {})) h.set(k, String(v));",
    "    for (const [k, v] of Object.entries(headers ?? {})) if (v !== undefined) h.set(k, v);",
    "    let payload: BodyInit | undefined;",
    "    if (body !== undefined) {",
    "      if (contentType === 'application/x-www-form-urlencoded') {",
    "        payload = new URLSearchParams(body as Record<string, string>);",
    "      } else if (contentType.startsWith('multipart/')) {",
    "        const form = new FormData();",
    "        for (const [k, v] of Object.entries(body as Record<string, unknown>)) form.append(k, v instanceof Blob ? v : String(v));",
    "        payload = form;",
    "      } else {",
    "        h.set('content-type', contentType);",
    "        payload = JSON.stringify(body);",
    "      }",
    "    }",
    "    const res = await this.fetchImpl(url, { ...this.init, ...init, method, headers: h, body: payload });",
    "    const text = await res.text();",
    "    let data: unknown = text;",
    "    try {",
    "      data = text ? JSON.parse(text) : undefined;",
    "    } catch {",
    "      // not JSON",
    "    }",
    "    if (!res.ok) throw new ApiError(res.status, data);",
    "    return data as T;",
    "  }",
    "",
    ...methods,
    "}",
    ""
  );
  return out.join("\n");
}
function stripNull(schema) {
  if (Array.isArray(schema.type)) {
    const t = schema.type.filter((x) => x !== "null");
    return { ...schema, type: t.length === 1 ? t[0] : t };
  }
  return schema;
}

// src/core/yaml.ts
function toYaml(value) {
  return `${write(value, 0, false).replace(/^\n/, "")}
`;
}
var PLAIN = /^[A-Za-z_/][A-Za-z0-9_ ./{}()+-]*$/;
var RESERVED2 = /^(true|false|null|yes|no|on|off|y|n|~|-?\d[\d_.e+-]*|\.nan|\.inf|-\.inf)$/i;
function yamlString(s) {
  if (s === "") return "''";
  if (PLAIN.test(s) && !RESERVED2.test(s) && !/[:#]\s|\s$|^\s|: |\s#/.test(s) && !s.endsWith(":"))
    return s;
  return JSON.stringify(s);
}
function key(k) {
  return /^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(k) && !RESERVED2.test(k) ? k : JSON.stringify(k);
}
function scalar(v) {
  if (v === null || v === void 0) return "null";
  if (typeof v === "string") return yamlString(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
function write(value, indent, inList) {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return " []";
    return value.map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length) {
        const body = write(item, indent + 1, true);
        return `
${pad}- ${body.replace(/^\n\s*/, "")}`;
      }
      if (Array.isArray(item) && item.length) return `
${pad}-${write(item, indent + 1, false)}`;
      return `
${pad}- ${scalarOrEmpty(item)}`;
    }).join("");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(
      ([, v]) => v !== void 0
    );
    if (entries.length === 0) return " {}";
    void inList;
    return entries.map(([k, v]) => {
      if (v && typeof v === "object") return `
${pad}${key(k)}:${write(v, indent + 1, false)}`;
      return `
${pad}${key(k)}: ${scalar(v)}`;
    }).join("");
  }
  return ` ${scalar(value)}`;
}
function scalarOrEmpty(v) {
  if (Array.isArray(v)) return "[]";
  if (v && typeof v === "object") return "{}";
  return scalar(v);
}

// src/node/browser.ts
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
function browserCandidates(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      Boolean
    );
    const rel = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "Chromium\\Application\\chrome.exe"
    ];
    return rel.flatMap((r) => roots.map((root) => join(root, r)));
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    ];
  }
  const names = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "brave-browser"
  ];
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return names.flatMap((n) => dirs.map((d) => join(d, n)));
}
function findBrowser(explicit) {
  const choice = explicit ?? process.env.APIXRAY_BROWSER;
  if (choice) return existsSync(choice) ? choice : null;
  return browserCandidates().find((p) => existsSync(p)) ?? null;
}
async function launchBrowser(opts) {
  const temporary = !opts.profileDir;
  const profileDir = opts.profileDir ?? mkdtempSync(join(tmpdir(), "apixray-profile-"));
  const portFile = join(profileDir, "DevToolsActivePort");
  rmSync(portFile, { force: true });
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only"
  ];
  if (opts.headless) args.push("--headless=new");
  args.push(opts.url);
  const child = spawn(opts.executable, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr = (stderr + d.toString()).slice(-4e3);
  });
  const exited = new Promise((resolve2) => child.once("exit", () => resolve2()));
  let failed = null;
  child.once("error", (err) => {
    failed = err;
  });
  const deadline = Date.now() + 2e4;
  let wsUrl = "";
  while (!wsUrl) {
    if (failed) throw failed;
    if (child.exitCode !== null) {
      throw new Error(
        `The browser exited before it was ready (code ${child.exitCode}). If it is already running with this profile, close it or pass --profile <new folder>.${stderr ? `
${stderr.trim()}` : ""}`
      );
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error("Timed out waiting for the browser to open its DevTools port.");
    }
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").split(/\r?\n/);
      if (port && path) wsUrl = `ws://127.0.0.1:${port}${path}`;
    }
    if (!wsUrl) await new Promise((r) => setTimeout(r, 100));
  }
  const cleanup = async () => {
    if (!temporary) return;
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  };
  return {
    process: child,
    wsUrl,
    profileDir,
    exited: exited.then(cleanup),
    kill: () => {
      if (child.exitCode === null) child.kill();
    }
  };
}

// src/node/cdp.ts
var Cdp = class _Cdp {
  ws;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  closed;
  constructor(ws) {
    this.ws = ws;
    this.closed = new Promise((resolve2) => ws.addEventListener("close", () => resolve2()));
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== void 0) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners)
          l({ method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId });
      }
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("Browser connection closed"));
      this.pending.clear();
    });
  }
  static connect(url) {
    return new Promise((resolve2, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve2(new _Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`Could not connect to ${url}`)), {
        once: true
      });
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve2, reject) => {
      this.pending.set(id, { resolve: resolve2, reject });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close() {
    try {
      this.ws.close();
    } catch {
    }
  }
};

// src/node/recorder.ts
function headerList(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj).flatMap(
    ([name, value]) => String(value).split("\n").map((v) => ({ name, value: v }))
  );
}
var BODY_TYPES = /* @__PURE__ */ new Set(["XHR", "Fetch", "EventSource", "Other"]);
var Recorder = class {
  constructor(cdp) {
    this.cdp = cdp;
  }
  cdp;
  entries = [];
  pending = /* @__PURE__ */ new Map();
  sessions = /* @__PURE__ */ new Set();
  targets = /* @__PURE__ */ new Set();
  inflight = /* @__PURE__ */ new Set();
  onEntry;
  async start() {
    this.cdp.on((e) => this.handle(e));
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = await this.cdp.send("Target.getTargets");
    for (const t of targetInfos) if (t.type === "page") await this.attach(t.targetId);
  }
  async attach(targetId) {
    if (this.targets.has(targetId)) return;
    this.targets.add(targetId);
    try {
      const { sessionId } = await this.cdp.send("Target.attachToTarget", {
        targetId,
        flatten: true
      });
      if (this.sessions.has(sessionId)) return;
      this.sessions.add(sessionId);
      await this.cdp.send("Network.enable", { maxPostDataSize: 1e6 }, sessionId);
      await this.cdp.send(
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId
      );
    } catch {
    }
  }
  handle(e) {
    const p = e.params;
    switch (e.method) {
      case "Target.targetCreated": {
        const info = p.targetInfo;
        if (info.type === "page") void this.attach(info.targetId);
        return;
      }
      case "Target.attachedToTarget": {
        const sessionId = p.sessionId;
        const info = p.targetInfo;
        if (info.type === "page" && !this.sessions.has(sessionId) && !this.targets.has(info.targetId)) {
          this.targets.add(info.targetId);
          this.sessions.add(sessionId);
          void this.cdp.send("Network.enable", { maxPostDataSize: 1e6 }, sessionId).catch(() => {
          });
        }
        return;
      }
      case "Network.requestWillBeSent": {
        const id = `${e.sessionId}:${p.requestId}`;
        const req = p.request;
        const prev = this.pending.get(id);
        if (prev && p.redirectResponse) {
          const r = p.redirectResponse;
          prev.response = {
            status: r.status,
            statusText: r.statusText,
            headers: headerList(r.headers),
            mimeType: r.mimeType
          };
          this.finish(prev, void 0);
        }
        this.pending.set(id, {
          requestId: p.requestId,
          sessionId: e.sessionId,
          startedDateTime: new Date(
            (p.wallTime ?? Date.now() / 1e3) * 1e3
          ).toISOString(),
          start: p.timestamp,
          type: p.type,
          request: {
            method: req.method,
            url: req.url,
            headers: headerList(req.headers),
            postData: req.postData,
            hasPostData: req.hasPostData
          }
        });
        return;
      }
      case "Network.requestWillBeSentExtraInfo": {
        const entry = this.pending.get(`${e.sessionId}:${p.requestId}`);
        if (entry) entry.extraRequestHeaders = headerList(p.headers);
        return;
      }
      case "Network.responseReceived": {
        const entry = this.pending.get(`${e.sessionId}:${p.requestId}`);
        if (!entry) return;
        const r = p.response;
        entry.response = {
          status: r.status,
          statusText: r.statusText,
          headers: headerList(r.headers),
          mimeType: r.mimeType
        };
        entry.type ??= p.type;
        return;
      }
      case "Network.loadingFinished": {
        const id = `${e.sessionId}:${p.requestId}`;
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        const done = this.complete(entry, p.timestamp ?? entry.start);
        this.inflight.add(done);
        void done.finally(() => this.inflight.delete(done));
        return;
      }
      case "Network.loadingFailed": {
        const id = `${e.sessionId}:${p.requestId}`;
        const entry = this.pending.get(id);
        this.pending.delete(id);
        if (entry?.response) this.finish(entry, void 0, p.timestamp ?? entry.start);
        return;
      }
    }
  }
  async complete(entry, end) {
    if (!entry.response) return;
    let body;
    if (BODY_TYPES.has(entry.type ?? "") || /json|xml|text\/plain/i.test(entry.response.mimeType)) {
      if (entry.request.hasPostData && entry.request.postData === void 0) {
        try {
          const r = await this.cdp.send(
            "Network.getRequestPostData",
            { requestId: entry.requestId },
            entry.sessionId
          );
          entry.request.postData = r.postData;
        } catch {
        }
      }
      try {
        body = await this.cdp.send(
          "Network.getResponseBody",
          { requestId: entry.requestId },
          entry.sessionId
        );
      } catch {
      }
    }
    this.finish(entry, body, end);
  }
  finish(entry, body, end = entry.start) {
    const har = this.toEntry(entry, end, body);
    if (!isApiCall(har)) return;
    this.entries.push(har);
    this.onEntry?.(har);
  }
  toEntry(entry, end, body) {
    const headers = entry.extraRequestHeaders?.length ? entry.extraRequestHeaders : entry.request.headers;
    const contentType = headers.find((h) => h.name.toLowerCase() === "content-type")?.value;
    const url = entry.request.url;
    let queryString = [];
    try {
      queryString = [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
    } catch {
    }
    return {
      startedDateTime: entry.startedDateTime,
      time: Math.max(0, (end - entry.start) * 1e3),
      _resourceType: entry.type?.toLowerCase(),
      request: {
        method: entry.request.method,
        url,
        headers: headers.filter((h) => !h.name.startsWith(":")),
        queryString,
        ...entry.request.postData !== void 0 ? {
          postData: {
            mimeType: contentType ?? "application/octet-stream",
            text: entry.request.postData
          }
        } : {}
      },
      response: {
        status: entry.response?.status ?? 0,
        statusText: entry.response?.statusText ?? "",
        headers: entry.response?.headers ?? [],
        content: {
          mimeType: entry.response?.mimeType ?? "",
          ...body ? { text: body.body, ...body.base64Encoded ? { encoding: "base64" } : {} } : {}
        }
      }
    };
  }
  /** Open a URL in the first recorded tab (after recording has started, so nothing is missed). */
  async navigate(url) {
    const session = [...this.sessions][0];
    if (!session) throw new Error("No browser tab to record.");
    await this.cdp.send("Page.navigate", { url }, session);
  }
  /** Wait for response bodies that are still being fetched. */
  async flush() {
    await Promise.allSettled([...this.inflight]);
  }
  toHar() {
    return {
      log: {
        version: "1.2",
        creator: { name: "apixray", version: "1" },
        entries: [...this.entries].sort(
          (a, b) => (a.startedDateTime ?? "").localeCompare(b.startedDateTime ?? "")
        )
      }
    };
  }
};

// src/cli/main.ts
var VERSION = true ? "1.0.0" : "0.0.0-dev";
var HELP = `apixray ${VERSION}: X-ray any web app's API.

Usage
  apixray record <url> [options]      Open a browser, use the app, close it: get an OpenAPI spec
  apixray <capture.har>... [options]  Convert HAR files exported from browser DevTools or a proxy

Output options
  -o, --out <dir>        Output folder (default: apixray-out)
  --stdout               Print the OpenAPI document instead of writing files
  --format <yaml|json>   OpenAPI format (default: yaml)
  --origin <url>         Only include this origin, e.g. https://api.example.com (repeatable)
  --include-noise        Keep analytics and telemetry hosts
  --no-examples          Leave real examples out of the spec
  --no-redact            Keep tokens, keys and e-mail addresses in examples
  --title <name>         API title in the spec

Record options
  --browser <path>       Chrome, Edge, Brave or Chromium executable (default: auto-detect)
  --profile <dir>        Reuse a browser profile folder to stay logged in between recordings
  --headless             Run without a window (combine with --duration)
  --duration <seconds>   Stop automatically after this many seconds
  --no-har               Do not save the raw capture (capture.har)

Examples
  apixray record https://news.ycombinator.com
  apixray capture.har -o api/
  apixray capture.har --origin https://api.example.com --stdout > openapi.yaml

Files are written locally; nothing is uploaded. Docs: https://github.com/feresbr1/apixray
`;
var UsageError = class extends Error {
  name = "UsageError";
};
var VALUE = /* @__PURE__ */ new Set([
  "-o",
  "--out",
  "--format",
  "--origin",
  "--title",
  "--browser",
  "--profile",
  "--duration"
]);
var BOOL = /* @__PURE__ */ new Set([
  "--stdout",
  "--include-noise",
  "--no-examples",
  "--no-redact",
  "--headless",
  "--no-har",
  "-h",
  "--help",
  "-v",
  "--version"
]);
function parseArgs(argv) {
  const flags = /* @__PURE__ */ new Map();
  const multi = /* @__PURE__ */ new Map();
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === void 0) throw new UsageError(`${name} needs a value.`);
      flags.set(name, value);
      multi.set(name, [...multi.get(name) ?? [], value]);
    } else if (BOOL.has(name)) {
      flags.set(name, true);
    } else if (arg.startsWith("-") && arg.length > 1) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, multi, positionals };
}
async function main(argv, io) {
  try {
    const [first, ...rest] = argv;
    if (!first || first === "-h" || first === "--help" || first === "help") {
      io.out(HELP);
      return 0;
    }
    if (first === "-v" || first === "--version") {
      io.out(`${VERSION}
`);
      return 0;
    }
    if (first === "record") return await record(parseArgs(rest), io);
    if (first === "convert") return convert(parseArgs(rest), io);
    if (/^https?:\/\//i.test(first)) {
      throw new UsageError(`To record a site, run: apixray record ${first}`);
    }
    return convert(parseArgs(argv), io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`apixray: ${err.message}
Run "apixray --help" for usage.
`);
      return 2;
    }
    if (err instanceof HarError) {
      io.err(`apixray: ${err.message}
`);
      return 2;
    }
    io.err(`apixray: ${err.message}
`);
    return 1;
  }
}
function convert(p, io) {
  if (!p.positionals.length)
    throw new UsageError("Give a .har file to convert, or use: apixray record <url>");
  const entries = [];
  for (const file of p.positionals) {
    let text;
    try {
      text = readFileSync2(resolve(io.cwd, file), "utf8");
    } catch {
      throw new UsageError(`Cannot read ${file}`);
    }
    try {
      entries.push(...parseHar(text).log.entries);
    } catch (err) {
      throw new HarError(`${file}: ${err.message}`);
    }
  }
  return emit({ log: { entries } }, p, io);
}
function emit(har, p, io, extra = {}) {
  const origins = p.multi.get("--origin")?.map((o) => o.replace(/\/+$/, ""));
  const model = analyze(har, { includeNoise: p.flags.has("--include-noise"), origins });
  const title = p.flags.get("--title");
  const doc = toOpenApi(model, {
    examples: !p.flags.has("--no-examples"),
    redact: !p.flags.has("--no-redact"),
    title: typeof title === "string" ? title : void 0
  });
  const format = p.flags.get("--format") ?? "yaml";
  if (format !== "yaml" && format !== "json")
    throw new UsageError("--format must be yaml or json.");
  const spec = format === "json" ? `${JSON.stringify(doc, null, 2)}
` : toYaml(doc);
  io.err(summary(model));
  if (model.endpoints.length === 0) {
    io.err(
      `apixray: no API calls found in ${model.stats.entries} requests. Did the capture include XHR/fetch traffic with response bodies?${model.stats.noiseCalls ? " (Only analytics/telemetry calls were seen; add --include-noise to keep them.)" : ""}
`
    );
    return 1;
  }
  if (p.flags.has("--stdout")) {
    io.out(spec);
    return 0;
  }
  const outFlag = p.flags.get("--out") ?? p.flags.get("-o");
  const dir = resolve(io.cwd, typeof outFlag === "string" ? outFlag : "apixray-out");
  mkdirSync(dir, { recursive: true });
  const files = {
    [`openapi.${format}`]: spec,
    "client.ts": toTypeScript(model),
    ...extra
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(resolve(dir, name), content);
  const rel = relative(io.cwd, dir) || ".";
  io.err(
    `
Wrote ${Object.keys(files).map((f) => `${rel}/${f}`.replace(/\\/g, "/")).join(", ")}
`
  );
  io.err(
    "Open openapi.yaml in Swagger Editor, or import it into Postman, Bruno, Insomnia or Hoppscotch.\n"
  );
  return 0;
}
function summary(model) {
  const out = [];
  const hosts = new Set(model.endpoints.flatMap((e) => e.servers.map((s) => new URL(s).host)));
  out.push(
    `apixray \xB7 ${model.stats.apiCalls} API calls \u2192 ${model.endpoints.length} endpoints on ${hosts.size} ${hosts.size === 1 ? "host" : "hosts"} (${model.stats.entries} requests captured)`
  );
  let current = "";
  for (const ep of model.endpoints) {
    const base = `${ep.origin}${ep.basePath}`;
    if (base !== current) {
      const others = new Set(model.endpoints.filter((e) => e.origin === ep.origin).flatMap((e) => e.servers)).size - 1;
      out.push(
        `  ${base}${others > 0 ? `  (+${others} more ${others === 1 ? "host" : "hosts"} of ${ep.site})` : ""}`
      );
      current = base;
    }
    const statuses = ep.responses.map((r) => r.status).join(",");
    out.push(
      `    ${ep.method.padEnd(6)} ${ep.path.padEnd(38)} ${`${ep.samples.length}\xD7`.padStart(4)}  ${statuses}  ${ep.operationId}`
    );
  }
  const schemes = Object.values(model.security);
  if (schemes.length) {
    out.push(
      `  auth: ${schemes.map(
        (s) => s.type === "http" ? `${s.scheme}${s.bearerFormat ? ` (${s.bearerFormat})` : ""}` : `${s.in} ${s.name}`
      ).join(", ")} (values never written)`
    );
  }
  const skipped = model.origins.filter((o) => o.endpoints === 0 && o.noise);
  if (skipped.length) {
    out.push(
      `  skipped telemetry: ${skipped.map((o) => new URL(o.origin).host).join(", ")} (--include-noise keeps them)`
    );
  }
  return `${out.join("\n")}
`;
}
async function record(p, io) {
  let url = p.positionals[0];
  if (!url) throw new UsageError("Give the URL to open, e.g. apixray record https://example.com");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const browserFlag = p.flags.get("--browser");
  const executable = findBrowser(typeof browserFlag === "string" ? browserFlag : void 0);
  if (!executable) {
    throw new Error(
      typeof browserFlag === "string" ? `Browser not found: ${browserFlag}` : "No Chrome, Edge, Brave or Chromium found. Install one, or pass --browser <path> (or set APIXRAY_BROWSER)."
    );
  }
  const durationFlag = p.flags.get("--duration");
  const duration = typeof durationFlag === "string" ? Number(durationFlag) : void 0;
  if (duration !== void 0 && !(duration > 0))
    throw new UsageError("--duration must be a positive number of seconds.");
  if (p.flags.has("--headless") && duration === void 0 && !io.onRecording) {
    throw new UsageError("--headless needs --duration, since there is no window to close.");
  }
  const profile = p.flags.get("--profile");
  const browser = await launchBrowser({
    executable,
    url: "about:blank",
    headless: p.flags.has("--headless"),
    profileDir: typeof profile === "string" ? resolve(io.cwd, profile) : void 0
  });
  const cdp = await Cdp.connect(browser.wsUrl);
  const recorder = new Recorder(cdp);
  recorder.onEntry = (e) => {
    const u = new URL(e.request.url);
    io.err(
      `  ${e.request.method.padEnd(6)} ${String(e.response.status).padEnd(3)} ${u.host}${u.pathname}
`
    );
  };
  await recorder.start();
  await recorder.navigate(url);
  io.err(
    `apixray: recording ${url}
  Use the app: log in, click around, trigger the features you care about.
  ${duration ? `Stopping after ${duration}s.` : "Close the browser window (or press Ctrl+C) when you are done."}

`
  );
  let stopRequested = false;
  const stop = () => {
    stopRequested = true;
    browser.kill();
  };
  const timer = duration ? setTimeout(stop, duration * 1e3) : void 0;
  const onSigint = () => stop();
  process.once("SIGINT", onSigint);
  io.onRecording?.(stop);
  await Promise.race([browser.exited, cdp.closed]);
  await Promise.race([recorder.flush(), new Promise((r) => setTimeout(r, 2e3))]);
  if (timer) clearTimeout(timer);
  process.removeListener("SIGINT", onSigint);
  browser.kill();
  cdp.close();
  await browser.exited;
  void stopRequested;
  const har = recorder.toHar();
  io.err(`
apixray: captured ${har.log.entries.length} API calls.

`);
  if (har.log.entries.length === 0) {
    io.err(
      "apixray: nothing to write. Interact with the app longer, or check that it calls an HTTP API.\n"
    );
    return 1;
  }
  const extra = p.flags.has("--no-har") ? {} : { "capture.har": JSON.stringify(har) };
  return emit(har, p, io, extra);
}

// src/cli/index.ts
var code = await main(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  cwd: process.cwd()
});
process.exitCode = code;
