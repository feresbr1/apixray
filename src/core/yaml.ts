/** Minimal YAML 1.2 writer for JSON-compatible data (what OpenAPI documents are). */
export function toYaml(value: unknown): string {
  return `${write(value, 0, false).replace(/^\n/, '')}\n`;
}

const PLAIN = /^[A-Za-z_/][A-Za-z0-9_ ./{}()+-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~|-?\d[\d_.e+-]*|\.nan|\.inf|-\.inf)$/i;

export function yamlString(s: string): string {
  if (s === '') return "''";
  if (PLAIN.test(s) && !RESERVED.test(s) && !/[:#]\s|\s$|^\s|: |\s#/.test(s) && !s.endsWith(':'))
    return s;
  return JSON.stringify(s);
}

function key(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(k) && !RESERVED.test(k) ? k : JSON.stringify(k);
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return yamlString(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function write(value: unknown, indent: number, inList: boolean): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return ' []';
    return value
      .map((item) => {
        if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length) {
          // "- key: value" with the following keys aligned under the first.
          const body = write(item, indent + 1, true);
          return `\n${pad}- ${body.replace(/^\n\s*/, '')}`;
        }
        if (Array.isArray(item) && item.length) return `\n${pad}-${write(item, indent + 1, false)}`;
        return `\n${pad}- ${scalarOrEmpty(item)}`;
      })
      .join('');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return ' {}';
    void inList;
    return entries
      .map(([k, v]) => {
        if (v && typeof v === 'object') return `\n${pad}${key(k)}:${write(v, indent + 1, false)}`;
        return `\n${pad}${key(k)}: ${scalar(v)}`;
      })
      .join('');
  }
  return ` ${scalar(value)}`;
}

function scalarOrEmpty(v: unknown): string {
  if (Array.isArray(v)) return '[]';
  if (v && typeof v === 'object') return '{}';
  return scalar(v);
}
