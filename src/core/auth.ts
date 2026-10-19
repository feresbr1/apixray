import type { HarHeader } from './har';

export interface SecurityScheme {
  key: string;
  type: 'http' | 'apiKey';
  scheme?: 'bearer' | 'basic';
  bearerFormat?: string;
  in?: 'header' | 'query' | 'cookie';
  name?: string;
}

export interface AuthFound {
  schemes: SecurityScheme[];
  /** Header names (lower case) and query names that carry credentials. */
  headers: Set<string>;
  query: Set<string>;
}

const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const KEY_HEADER =
  /^(x-)?(api[-_]?key|apikey|auth[-_]?token|access[-_]?token|token|x-auth|x-access-key|x-functions-key|subscription-key|ocp-apim-subscription-key|x-[\w-]*-(key|token|secret))$/i;
const KEY_QUERY =
  /((^|[-_])(api[-_]?key|apikey|access[-_]?token|auth[-_]?token|token|secret|client[-_]?secret|signature|sig)|^key)$/i;
const SESSION_COOKIE = /sess|sid$|^sid|auth|token|jwt|login|remember/i;

export function isJwt(value: string): boolean {
  return JWT.test(value);
}

export function detectAuth(headers: HarHeader[], query: [string, string][]): AuthFound {
  const found: AuthFound = { schemes: [], headers: new Set(), query: new Set() };
  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (name === 'authorization' || name === 'proxy-authorization') {
      const [scheme = '', token = ''] = h.value.split(/\s+/, 2);
      found.headers.add(name);
      if (/^bearer$/i.test(scheme)) {
        found.schemes.push({
          key: 'bearerAuth',
          type: 'http',
          scheme: 'bearer',
          ...(isJwt(token) ? { bearerFormat: 'JWT' } : {}),
        });
      } else if (/^basic$/i.test(scheme)) {
        found.schemes.push({ key: 'basicAuth', type: 'http', scheme: 'basic' });
      } else {
        found.schemes.push({
          key: 'authorizationHeader',
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
        });
      }
    } else if (KEY_HEADER.test(name) && !/^x-(csrf|xsrf)/.test(name)) {
      found.headers.add(name);
      found.schemes.push({ key: camelKey(h.name), type: 'apiKey', in: 'header', name: h.name });
    } else if (name === 'cookie') {
      const names = h.value
        .split(';')
        .map((c) => c.split('=')[0]!.trim())
        .filter((n) => n && SESSION_COOKIE.test(n));
      if (names.length) {
        found.headers.add(name);
        found.schemes.push({ key: 'cookieAuth', type: 'apiKey', in: 'cookie', name: names[0]! });
      } else {
        found.headers.add(name);
      }
    }
  }
  for (const [k] of query) {
    if (KEY_QUERY.test(k)) {
      found.query.add(k);
      found.schemes.push({ key: camelKey(`${k} query`), type: 'apiKey', in: 'query', name: k });
    }
  }
  return found;
}

function camelKey(s: string): string {
  const parts = s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p.toLowerCase() : p[0]!.toUpperCase() + p.slice(1).toLowerCase()))
    .join('');
}
