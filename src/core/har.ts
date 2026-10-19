/** The subset of HAR 1.2 that apixray reads. Browsers, proxies and the recorder all write it. */
export interface HarHeader {
  name: string;
  value: string;
}

export interface HarEntry {
  startedDateTime?: string;
  time?: number;
  request: {
    method: string;
    url: string;
    headers: HarHeader[];
    queryString?: HarHeader[];
    postData?: {
      mimeType?: string;
      text?: string;
      params?: { name: string; value?: string }[];
    };
  };
  response: {
    status: number;
    statusText?: string;
    headers: HarHeader[];
    content?: { mimeType?: string; text?: string; encoding?: string; size?: number };
  };
  _resourceType?: string;
}

export interface Har {
  log: { version?: string; creator?: { name: string; version?: string }; entries: HarEntry[] };
}

export class HarError extends Error {
  override name = 'HarError';
}

export function parseHar(text: string): Har {
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new HarError(
      'This is not JSON, so it is not a HAR file. In DevTools, open the Network tab and use "Save all as HAR" (or "Export HAR").',
    );
  }
  return toHar(data);
}

export function toHar(data: unknown): Har {
  const log = (data as Har | undefined)?.log;
  if (!log || !Array.isArray(log.entries)) {
    throw new HarError(
      'No "log.entries" found. Is this a HAR file exported from a browser or proxy?',
    );
  }
  const entries = log.entries.filter(
    (e): e is HarEntry =>
      typeof e?.request?.url === 'string' &&
      typeof e.request.method === 'string' &&
      typeof e.response?.status === 'number',
  );
  return {
    log: {
      ...log,
      entries: entries.map((e) => ({
        ...e,
        request: { ...e.request, headers: e.request.headers ?? [] },
        response: { ...e.response, headers: e.response.headers ?? [] },
      })),
    },
  };
}

export function header(headers: HarHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** Decoded response body text, or undefined when the HAR did not keep it. */
export function responseText(entry: HarEntry): string | undefined {
  const content = entry.response.content;
  if (!content?.text) return undefined;
  if (content.encoding === 'base64') {
    try {
      const bin = atob(content.text);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return undefined;
    }
  }
  return content.text;
}
