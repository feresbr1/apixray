import type { Har, HarEntry } from '../src/core/har';

export interface Call {
  method?: string;
  url: string;
  status?: number;
  body?: unknown;
  reqBody?: unknown;
  reqMime?: string;
  reqText?: string;
  headers?: Record<string, string>;
  resMime?: string;
  type?: string;
}

export function entry(c: Call): HarEntry {
  const reqText = c.reqText ?? (c.reqBody === undefined ? undefined : JSON.stringify(c.reqBody));
  const resText =
    c.body === undefined ? undefined : typeof c.body === 'string' ? c.body : JSON.stringify(c.body);
  return {
    startedDateTime: '2026-10-19T10:00:00.000Z',
    time: 12,
    _resourceType: c.type ?? 'fetch',
    request: {
      method: c.method ?? 'GET',
      url: c.url,
      headers: Object.entries(c.headers ?? {}).map(([name, value]) => ({ name, value })),
      ...(reqText !== undefined
        ? { postData: { mimeType: c.reqMime ?? 'application/json', text: reqText } }
        : {}),
    },
    response: {
      status: c.status ?? 200,
      headers: [],
      content: {
        mimeType: c.resMime ?? (resText === undefined ? '' : 'application/json'),
        ...(resText !== undefined ? { text: resText } : {}),
      },
    },
  };
}

export function har(calls: Call[]): Har {
  return { log: { version: '1.2', entries: calls.map(entry) } };
}
