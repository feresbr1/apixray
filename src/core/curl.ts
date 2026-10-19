import type { Endpoint, Sample } from './analyze';
import { redactDeep, redactValue } from './redact';

function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * A runnable curl command for an endpoint, built from a real captured request, with credentials
 * replaced by $TOKEN / $API_KEY / $COOKIE placeholders.
 */
export function toCurl(ep: Endpoint, sample: Sample = ep.samples[0]!): string {
  const url = new URL(sample.entry.request.url);
  for (const k of sample.secretQuery) url.searchParams.set(k, '$API_KEY');
  url.hash = '';
  const parts = ['curl'];
  if (sample.method !== 'GET') parts.push('-X', sample.method);
  parts.push(sh(url.toString()).replace(/%24API_KEY/g, '\'"$API_KEY"\''));
  for (const h of sample.requestHeaders) {
    const name = h.name.toLowerCase();
    if (name === 'authorization') {
      const scheme = h.value.split(/\s+/)[0] ?? 'Bearer';
      parts.push('-H', `"Authorization: ${scheme} $TOKEN"`);
    } else if (name === 'cookie') {
      if (sample.secretHeaders.has('cookie')) parts.push('-H', '"Cookie: $COOKIE"');
    } else if (sample.secretHeaders.has(name)) {
      parts.push('-H', `"${h.name}: $API_KEY"`);
    } else if (
      ep.params.some((p) => p.in === 'header' && p.name === name) ||
      name === 'content-type'
    ) {
      parts.push('-H', sh(`${h.name}: ${h.value}`));
    }
  }
  if (sample.reqBody !== undefined) {
    if (!sample.requestHeaders.some((h) => h.name.toLowerCase() === 'content-type')) {
      parts.push('-H', sh('content-type: application/json'));
    }
    parts.push('--data', sh(JSON.stringify(redactDeep(sample.reqBody))));
  } else if (sample.reqFields && sample.reqKind === 'form') {
    for (const [k, v] of sample.reqFields)
      parts.push('--data-urlencode', sh(`${k}=${String(redactValue(k, v))}`));
  } else if (sample.reqFields && sample.reqKind === 'multipart') {
    for (const [k, v] of sample.reqFields)
      parts.push('-F', sh(`${k}=${String(redactValue(k, v))}`));
  }
  return parts.join(' ');
}
