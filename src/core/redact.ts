import { isJwt } from './auth';
import { isSensitiveKey } from './shape';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Replace values that should not end up in a shared spec: anything under a sensitive key, JWTs,
 * and e-mail addresses. Applied to examples only; schemas never contain values.
 */
export function redactValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (isSensitiveKey(key))
    return typeof value === 'string' || typeof value === 'number' ? '<redacted>' : value;
  if (typeof value === 'string') {
    if (isJwt(value)) return '<redacted-jwt>';
    if (EMAIL.test(value)) return 'user@example.com';
  }
  return value;
}

/** Deep copy of a JSON value with redactValue applied at every key. */
export function redactDeep(value: unknown, key = ''): unknown {
  if (key && isSensitiveKey(key) && value && typeof value === 'object') return '<redacted>';
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = v && typeof v === 'object' ? redactDeep(v, k) : redactValue(k, v);
    }
    return out;
  }
  return redactValue(key, value);
}
