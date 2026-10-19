import type { Har, HarEntry, HarHeader } from '../core/har';
import { isApiCall } from '../core/classify';
import type { Cdp, CdpEvent } from './cdp';

interface Pending {
  requestId: string;
  sessionId?: string;
  startedDateTime: string;
  start: number;
  type?: string;
  request: {
    method: string;
    url: string;
    headers: HarHeader[];
    postData?: string;
    hasPostData?: boolean;
  };
  extraRequestHeaders?: HarHeader[];
  response?: {
    status: number;
    statusText: string;
    headers: HarHeader[];
    mimeType: string;
  };
}

function headerList(obj: unknown): HarHeader[] {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([name, value]) =>
    String(value)
      .split('\n')
      .map((v) => ({ name, value: v })),
  );
}

const BODY_TYPES = new Set(['XHR', 'Fetch', 'EventSource', 'Other']);

/**
 * Records network traffic from every tab of a browser over CDP and turns it into HAR entries.
 * Only API-looking responses get their bodies downloaded, so heavy pages stay fast.
 */
export class Recorder {
  readonly entries: HarEntry[] = [];
  private pending = new Map<string, Pending>();
  private sessions = new Set<string>();
  private targets = new Set<string>();
  private inflight = new Set<Promise<void>>();
  onEntry?: (entry: HarEntry) => void;

  constructor(private cdp: Cdp) {}

  async start(): Promise<void> {
    this.cdp.on((e) => this.handle(e));
    await this.cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.cdp.send<{
      targetInfos: { targetId: string; type: string }[];
    }>('Target.getTargets');
    for (const t of targetInfos) if (t.type === 'page') await this.attach(t.targetId);
  }

  private async attach(targetId: string): Promise<void> {
    if (this.targets.has(targetId)) return;
    this.targets.add(targetId);
    try {
      const { sessionId } = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      if (this.sessions.has(sessionId)) return;
      this.sessions.add(sessionId);
      await this.cdp.send('Network.enable', { maxPostDataSize: 1_000_000 }, sessionId);
      // Pages opened from this one (popups, new tabs) are attached too.
      await this.cdp.send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId,
      );
    } catch {
      // The tab closed before we could attach.
    }
  }

  private handle(e: CdpEvent): void {
    const p = e.params;
    switch (e.method) {
      case 'Target.targetCreated': {
        const info = p.targetInfo as { targetId: string; type: string };
        if (info.type === 'page') void this.attach(info.targetId);
        return;
      }
      case 'Target.attachedToTarget': {
        const sessionId = p.sessionId as string;
        const info = p.targetInfo as { type: string; targetId: string };
        if (
          info.type === 'page' &&
          !this.sessions.has(sessionId) &&
          !this.targets.has(info.targetId)
        ) {
          this.targets.add(info.targetId);
          this.sessions.add(sessionId);
          void this.cdp
            .send('Network.enable', { maxPostDataSize: 1_000_000 }, sessionId)
            .catch(() => {});
        }
        return;
      }
      case 'Network.requestWillBeSent': {
        const id = `${e.sessionId}:${p.requestId as string}`;
        const req = p.request as {
          method: string;
          url: string;
          headers: unknown;
          postData?: string;
          hasPostData?: boolean;
        };
        // A redirect reuses the request id: finish the previous hop first.
        const prev = this.pending.get(id);
        if (prev && p.redirectResponse) {
          const r = p.redirectResponse as {
            status: number;
            statusText: string;
            headers: unknown;
            mimeType: string;
          };
          prev.response = {
            status: r.status,
            statusText: r.statusText,
            headers: headerList(r.headers),
            mimeType: r.mimeType,
          };
          this.finish(prev, undefined);
        }
        this.pending.set(id, {
          requestId: p.requestId as string,
          sessionId: e.sessionId,
          startedDateTime: new Date(
            ((p.wallTime as number) ?? Date.now() / 1000) * 1000,
          ).toISOString(),
          start: p.timestamp as number,
          type: p.type as string | undefined,
          request: {
            method: req.method,
            url: req.url,
            headers: headerList(req.headers),
            postData: req.postData,
            hasPostData: req.hasPostData,
          },
        });
        return;
      }
      case 'Network.requestWillBeSentExtraInfo': {
        const entry = this.pending.get(`${e.sessionId}:${p.requestId as string}`);
        // The headers actually sent on the wire (including cookies).
        if (entry) entry.extraRequestHeaders = headerList(p.headers);
        return;
      }
      case 'Network.responseReceived': {
        const entry = this.pending.get(`${e.sessionId}:${p.requestId as string}`);
        if (!entry) return;
        const r = p.response as {
          status: number;
          statusText: string;
          headers: unknown;
          mimeType: string;
        };
        entry.response = {
          status: r.status,
          statusText: r.statusText,
          headers: headerList(r.headers),
          mimeType: r.mimeType,
        };
        entry.type ??= p.type as string | undefined;
        return;
      }
      case 'Network.loadingFinished': {
        const id = `${e.sessionId}:${p.requestId as string}`;
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        const done = this.complete(entry, (p.timestamp as number) ?? entry.start);
        this.inflight.add(done);
        void done.finally(() => this.inflight.delete(done));
        return;
      }
      case 'Network.loadingFailed': {
        const id = `${e.sessionId}:${p.requestId as string}`;
        const entry = this.pending.get(id);
        this.pending.delete(id);
        // A response arrived but the body was cut off (e.g. a 204 with a content type): keep it.
        if (entry?.response) this.finish(entry, undefined, (p.timestamp as number) ?? entry.start);
        return;
      }
    }
  }

  private async complete(entry: Pending, end: number): Promise<void> {
    if (!entry.response) return;
    let body: { body: string; base64Encoded: boolean } | undefined;
    if (BODY_TYPES.has(entry.type ?? '') || /json|xml|text\/plain/i.test(entry.response.mimeType)) {
      if (entry.request.hasPostData && entry.request.postData === undefined) {
        try {
          const r = await this.cdp.send<{ postData: string }>(
            'Network.getRequestPostData',
            { requestId: entry.requestId },
            entry.sessionId,
          );
          entry.request.postData = r.postData;
        } catch {
          /* not available */
        }
      }
      try {
        body = await this.cdp.send(
          'Network.getResponseBody',
          { requestId: entry.requestId },
          entry.sessionId,
        );
      } catch {
        /* no body (204, evicted, or the tab closed) */
      }
    }
    this.finish(entry, body, end);
  }

  private finish(
    entry: Pending,
    body?: { body: string; base64Encoded: boolean },
    end = entry.start,
  ): void {
    const har = this.toEntry(entry, end, body);
    if (!isApiCall(har)) return;
    this.entries.push(har);
    this.onEntry?.(har);
  }

  private toEntry(
    entry: Pending,
    end: number,
    body?: { body: string; base64Encoded: boolean },
  ): HarEntry {
    const headers = entry.extraRequestHeaders?.length
      ? entry.extraRequestHeaders
      : entry.request.headers;
    const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value;
    const url = entry.request.url;
    let queryString: HarHeader[] = [];
    try {
      queryString = [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
    } catch {
      /* not a URL */
    }
    return {
      startedDateTime: entry.startedDateTime,
      time: Math.max(0, (end - entry.start) * 1000),
      _resourceType: entry.type?.toLowerCase(),
      request: {
        method: entry.request.method,
        url,
        headers: headers.filter((h) => !h.name.startsWith(':')),
        queryString,
        ...(entry.request.postData !== undefined
          ? {
              postData: {
                mimeType: contentType ?? 'application/octet-stream',
                text: entry.request.postData,
              },
            }
          : {}),
      },
      response: {
        status: entry.response?.status ?? 0,
        statusText: entry.response?.statusText ?? '',
        headers: entry.response?.headers ?? [],
        content: {
          mimeType: entry.response?.mimeType ?? '',
          ...(body
            ? { text: body.body, ...(body.base64Encoded ? { encoding: 'base64' } : {}) }
            : {}),
        },
      },
    };
  }

  /** Open a URL in the first recorded tab (after recording has started, so nothing is missed). */
  async navigate(url: string): Promise<void> {
    const session = [...this.sessions][0];
    if (!session) throw new Error('No browser tab to record.');
    await this.cdp.send('Page.navigate', { url }, session);
  }

  /** Wait for response bodies that are still being fetched. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  toHar(): Har {
    return {
      log: {
        version: '1.2',
        creator: { name: 'apixray', version: '1' },
        entries: [...this.entries].sort((a, b) =>
          (a.startedDateTime ?? '').localeCompare(b.startedDateTime ?? ''),
        ),
      },
    };
  }
}
