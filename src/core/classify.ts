import { header, responseText, type HarEntry } from './har';

/** Third-party telemetry that is never the API you are after. Shown separately, off by default. */
const NOISE_HOSTS = [
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'facebook.com',
  'facebook.net',
  'connect.facebook.net',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'amplitude.com',
  'hotjar.com',
  'hotjar.io',
  'clarity.ms',
  'sentry.io',
  'ingest.sentry.io',
  'datadoghq.com',
  'browser-intake-datadoghq.com',
  'nr-data.net',
  'newrelic.com',
  'fullstory.com',
  'intercom.io',
  'intercomcdn.com',
  'launchdarkly.com',
  'optimizely.com',
  'bugsnag.com',
  'logrocket.io',
  'heap.io',
  'heapanalytics.com',
  'posthog.com',
  'plausible.io',
  'cloudflareinsights.com',
  'linkedin.com',
  'ads-twitter.com',
  'bing.com',
  'stripe.network',
  'recaptcha.net',
  'gstatic.com',
];

const NOISE_LABEL =
  /^(telemetry|analytics|metrics|tracking|tracker|stats|beacon|collector|collect|rum|insights|events?-?intake|log-?intake|pixel)[.-]/i;

export function isNoiseHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return NOISE_LABEL.test(h) || NOISE_HOSTS.some((n) => h === n || h.endsWith(`.${n}`));
}

const STATIC_EXT =
  /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|wasm|pdf|zip)$/i;
const STATIC_TYPES = new Set([
  'image',
  'stylesheet',
  'script',
  'font',
  'media',
  'manifest',
  'texttrack',
  'websocket',
  'ping',
  'preflight',
]);

export type BodyKind = 'json' | 'form' | 'multipart' | 'xml' | 'text' | 'none' | 'other';

export function bodyKind(mime: string | undefined): BodyKind {
  const m = (mime ?? '').toLowerCase();
  if (!m) return 'none';
  if (m.includes('json')) return 'json';
  if (m.includes('x-www-form-urlencoded')) return 'form';
  if (m.includes('multipart/')) return 'multipart';
  if (m.includes('xml')) return 'xml';
  if (m.startsWith('text/')) return 'text';
  return 'other';
}

export function tryJson(text: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (text === undefined) return { ok: false };
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false };
  }
}

/** Is this request a call to an API (as opposed to a page, script, image or preflight)? */
export function isApiCall(entry: HarEntry): boolean {
  const { request, response } = entry;
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS' || method === 'CONNECT') return false;
  if (!/^https?:/i.test(request.url)) return false;
  if (entry._resourceType && STATIC_TYPES.has(entry._resourceType)) return false;
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return false;
  }
  if (STATIC_EXT.test(path)) return false;
  const resMime = response.content?.mimeType ?? header(response.headers, 'content-type');
  const reqMime = request.postData?.mimeType ?? header(request.headers, 'content-type');
  const resKind = bodyKind(resMime);
  if (resKind === 'json' || resKind === 'xml') return true;
  const reqKind = bodyKind(reqMime);
  if (reqKind === 'json') return true;
  if (method !== 'GET' && method !== 'HEAD' && (reqKind === 'form' || reqKind === 'multipart')) {
    return entry._resourceType !== 'document';
  }
  // JSON served with a wrong content type (common with text/plain and text/html).
  if (resKind === 'text' || resKind === 'none' || resKind === 'other') {
    if (entry._resourceType === 'document') return false;
    if (tryJson(responseText(entry)).ok) return true;
  }
  // Mutations without a body, e.g. DELETE /items/3 returning 204.
  if (method !== 'GET' && method !== 'HEAD' && entry._resourceType !== 'document') {
    return (
      entry._resourceType === 'xhr' || entry._resourceType === 'fetch' || response.status === 204
    );
  }
  return entry._resourceType === 'xhr' || entry._resourceType === 'fetch'
    ? resKind !== 'other' && !/text\/html/i.test(resMime ?? '')
    : false;
}
