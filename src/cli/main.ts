import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { analyze, type ApiModel } from '../core/analyze';
import { HarError, parseHar, type Har } from '../core/har';
import { toOpenApi } from '../core/openapi';
import { toTypeScript } from '../core/typescript';
import { toYaml } from '../core/yaml';
import { findBrowser, launchBrowser } from '../node/browser';
import { Cdp } from '../node/cdp';
import { Recorder } from '../node/recorder';

declare const __VERSION__: string | undefined;
export const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  cwd: string;
  /** Called once recording is running; tests use it to drive the page and stop. */
  onRecording?: (stop: () => void) => void;
}

const HELP = `apixray ${VERSION}: X-ray any web app's API.

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

export class UsageError extends Error {
  override name = 'UsageError';
}

interface Parsed {
  flags: Map<string, string | true>;
  multi: Map<string, string[]>;
  positionals: string[];
}

const VALUE = new Set([
  '-o',
  '--out',
  '--format',
  '--origin',
  '--title',
  '--browser',
  '--profile',
  '--duration',
]);
const BOOL = new Set([
  '--stdout',
  '--include-noise',
  '--no-examples',
  '--no-redact',
  '--headless',
  '--no-har',
  '-h',
  '--help',
  '-v',
  '--version',
]);

export function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string | true>();
  const multi = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new UsageError(`${name} needs a value.`);
      flags.set(name, value);
      multi.set(name, [...(multi.get(name) ?? []), value]);
    } else if (BOOL.has(name)) {
      flags.set(name, true);
    } else if (arg.startsWith('-') && arg.length > 1) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, multi, positionals };
}

export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const [first, ...rest] = argv;
    if (!first || first === '-h' || first === '--help' || first === 'help') {
      io.out(HELP);
      return 0;
    }
    if (first === '-v' || first === '--version') {
      io.out(`${VERSION}\n`);
      return 0;
    }
    if (first === 'record') return await record(parseArgs(rest), io);
    if (first === 'convert') return convert(parseArgs(rest), io);
    if (/^https?:\/\//i.test(first)) {
      throw new UsageError(`To record a site, run: apixray record ${first}`);
    }
    return convert(parseArgs(argv), io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`apixray: ${err.message}\nRun "apixray --help" for usage.\n`);
      return 2;
    }
    if (err instanceof HarError) {
      io.err(`apixray: ${err.message}\n`);
      return 2;
    }
    io.err(`apixray: ${(err as Error).message}\n`);
    return 1;
  }
}

function convert(p: Parsed, io: Io): number {
  if (!p.positionals.length)
    throw new UsageError('Give a .har file to convert, or use: apixray record <url>');
  const entries: Har['log']['entries'] = [];
  for (const file of p.positionals) {
    let text: string;
    try {
      text = readFileSync(resolve(io.cwd, file), 'utf8');
    } catch {
      throw new UsageError(`Cannot read ${file}`);
    }
    try {
      entries.push(...parseHar(text).log.entries);
    } catch (err) {
      throw new HarError(`${file}: ${(err as Error).message}`);
    }
  }
  return emit({ log: { entries } }, p, io);
}

function emit(har: Har, p: Parsed, io: Io, extra: Record<string, string> = {}): number {
  const origins = p.multi.get('--origin')?.map((o) => o.replace(/\/+$/, ''));
  const model = analyze(har, { includeNoise: p.flags.has('--include-noise'), origins });
  const title = p.flags.get('--title');
  const doc = toOpenApi(model, {
    examples: !p.flags.has('--no-examples'),
    redact: !p.flags.has('--no-redact'),
    title: typeof title === 'string' ? title : undefined,
  });
  const format = p.flags.get('--format') ?? 'yaml';
  if (format !== 'yaml' && format !== 'json')
    throw new UsageError('--format must be yaml or json.');
  const spec = format === 'json' ? `${JSON.stringify(doc, null, 2)}\n` : toYaml(doc);
  io.err(summary(model));
  if (model.endpoints.length === 0) {
    io.err(
      `apixray: no API calls found in ${model.stats.entries} requests. Did the capture include XHR/fetch traffic with response bodies?${model.stats.noiseCalls ? ' (Only analytics/telemetry calls were seen; add --include-noise to keep them.)' : ''}\n`,
    );
    return 1;
  }
  if (p.flags.has('--stdout')) {
    io.out(spec);
    return 0;
  }
  const outFlag = p.flags.get('--out') ?? p.flags.get('-o');
  const dir = resolve(io.cwd, typeof outFlag === 'string' ? outFlag : 'apixray-out');
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {
    [`openapi.${format}`]: spec,
    'client.ts': toTypeScript(model),
    ...extra,
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(resolve(dir, name), content);
  const rel = relative(io.cwd, dir) || '.';
  io.err(
    `\nWrote ${Object.keys(files)
      .map((f) => `${rel}/${f}`.replace(/\\/g, '/'))
      .join(', ')}\n`,
  );
  io.err(
    'Open openapi.yaml in Swagger Editor, or import it into Postman, Bruno, Insomnia or Hoppscotch.\n',
  );
  return 0;
}

export function summary(model: ApiModel): string {
  const out: string[] = [];
  const hosts = new Set(model.endpoints.flatMap((e) => e.servers.map((s) => new URL(s).host)));
  out.push(
    `apixray · ${model.stats.apiCalls} API calls → ${model.endpoints.length} endpoints on ${hosts.size} ${hosts.size === 1 ? 'host' : 'hosts'} (${model.stats.entries} requests captured)`,
  );
  let current = '';
  for (const ep of model.endpoints) {
    const base = `${ep.origin}${ep.basePath}`;
    if (base !== current) {
      const others =
        new Set(model.endpoints.filter((e) => e.origin === ep.origin).flatMap((e) => e.servers))
          .size - 1;
      out.push(
        `  ${base}${others > 0 ? `  (+${others} more ${others === 1 ? 'host' : 'hosts'} of ${ep.site})` : ''}`,
      );
      current = base;
    }
    const statuses = ep.responses.map((r) => r.status).join(',');
    out.push(
      `    ${ep.method.padEnd(6)} ${ep.path.padEnd(38)} ${`${ep.samples.length}×`.padStart(4)}  ${statuses}  ${ep.operationId}`,
    );
  }
  const schemes = Object.values(model.security);
  if (schemes.length) {
    out.push(
      `  auth: ${schemes
        .map((s) =>
          s.type === 'http'
            ? `${s.scheme}${s.bearerFormat ? ` (${s.bearerFormat})` : ''}`
            : `${s.in} ${s.name}`,
        )
        .join(', ')} (values never written)`,
    );
  }
  const skipped = model.origins.filter((o) => o.endpoints === 0 && o.noise);
  if (skipped.length) {
    out.push(
      `  skipped telemetry: ${skipped.map((o) => new URL(o.origin).host).join(', ')} (--include-noise keeps them)`,
    );
  }
  return `${out.join('\n')}\n`;
}

async function record(p: Parsed, io: Io): Promise<number> {
  let url = p.positionals[0];
  if (!url) throw new UsageError('Give the URL to open, e.g. apixray record https://example.com');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const browserFlag = p.flags.get('--browser');
  const executable = findBrowser(typeof browserFlag === 'string' ? browserFlag : undefined);
  if (!executable) {
    throw new Error(
      typeof browserFlag === 'string'
        ? `Browser not found: ${browserFlag}`
        : 'No Chrome, Edge, Brave or Chromium found. Install one, or pass --browser <path> (or set APIXRAY_BROWSER).',
    );
  }
  const durationFlag = p.flags.get('--duration');
  const duration = typeof durationFlag === 'string' ? Number(durationFlag) : undefined;
  if (duration !== undefined && !(duration > 0))
    throw new UsageError('--duration must be a positive number of seconds.');
  if (p.flags.has('--headless') && duration === undefined && !io.onRecording) {
    throw new UsageError('--headless needs --duration, since there is no window to close.');
  }
  const profile = p.flags.get('--profile');

  const browser = await launchBrowser({
    executable,
    url: 'about:blank',
    headless: p.flags.has('--headless'),
    profileDir: typeof profile === 'string' ? resolve(io.cwd, profile) : undefined,
  });
  const cdp = await Cdp.connect(browser.wsUrl);
  const recorder = new Recorder(cdp);
  recorder.onEntry = (e) => {
    const u = new URL(e.request.url);
    io.err(
      `  ${e.request.method.padEnd(6)} ${String(e.response.status).padEnd(3)} ${u.host}${u.pathname}\n`,
    );
  };
  await recorder.start();
  await recorder.navigate(url);
  io.err(
    `apixray: recording ${url}\n  Use the app: log in, click around, trigger the features you care about.\n  ${duration ? `Stopping after ${duration}s.` : 'Close the browser window (or press Ctrl+C) when you are done.'}\n\n`,
  );

  let stopRequested = false;
  const stop = () => {
    stopRequested = true;
    browser.kill();
  };
  const timer = duration ? setTimeout(stop, duration * 1000) : undefined;
  const onSigint = () => stop();
  process.once('SIGINT', onSigint);
  io.onRecording?.(stop);
  // Closing the last window ends Chrome; give in-flight bodies a moment either way.
  await Promise.race([browser.exited, cdp.closed]);
  await Promise.race([recorder.flush(), new Promise((r) => setTimeout(r, 2000))]);
  if (timer) clearTimeout(timer);
  process.removeListener('SIGINT', onSigint);
  browser.kill();
  cdp.close();
  await browser.exited;
  void stopRequested;

  const har = recorder.toHar();
  io.err(`\napixray: captured ${har.log.entries.length} API calls.\n\n`);
  if (har.log.entries.length === 0) {
    io.err(
      'apixray: nothing to write. Interact with the app longer, or check that it calls an HTTP API.\n',
    );
    return 1;
  }
  const extra: Record<string, string> = p.flags.has('--no-har')
    ? {}
    : { 'capture.har': JSON.stringify(har) };
  return emit(har, p, io, extra);
}
