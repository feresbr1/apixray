import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { browserCandidates } from '../src/node/browser';
import { main, parseArgs, type Io } from '../src/cli/main';
// @ts-expect-error plain JS fixture
import { start } from './fixtures/server.mjs';

const work = mkdtempSync(join(tmpdir(), 'apixray-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const demo = resolve('examples/hn-search.har');

async function cli(argv: string[], extra: Partial<Io> = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    cwd: work,
    ...extra,
  });
  return { code, out, err };
}

describe('parseArgs', () => {
  it('collects repeated options', () => {
    const p = parseArgs(['a.har', '--origin', 'https://x', '--origin=https://y', '--stdout']);
    expect(p.multi.get('--origin')).toEqual(['https://x', 'https://y']);
    expect(p.positionals).toEqual(['a.har']);
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/);
  });
});

describe('convert', () => {
  it('writes openapi.yaml and client.ts with a summary', async () => {
    const r = await cli([demo, '-o', 'out']);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/20 API calls → 5 endpoints/);
    expect(r.err).toContain('POST   /indexes/{indexName}/query');
    expect(r.err).toContain('skipped telemetry: www.google-analytics.com, telemetry.algolia.com');
    const spec = parseYaml(readFileSync(join(work, 'out', 'openapi.yaml'), 'utf8'));
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.components.schemas.Item.properties.children.items).toEqual({
      $ref: '#/components/schemas/Item',
    });
    expect(readFileSync(join(work, 'out', 'client.ts'), 'utf8')).toContain('queryIndex(');
  });

  it('filters origins and prints JSON to stdout', async () => {
    const r = await cli([
      demo,
      '--origin',
      'https://hn.algolia.com/',
      '--stdout',
      '--format',
      'json',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.servers).toEqual([{ url: 'https://hn.algolia.com/api/v1' }]);
    expect(Object.keys(doc.paths)).toEqual(['/items/{itemId}', '/search', '/users/{userName}']);
  });

  it('explains bad input', async () => {
    writeFileSync(join(work, 'bad.har'), 'not json');
    expect((await cli(['bad.har'])).err).toMatch(/not JSON/);
    expect((await cli(['missing.har'])).code).toBe(2);
    writeFileSync(join(work, 'empty.har'), JSON.stringify({ log: { entries: [] } }));
    const empty = await cli(['empty.har']);
    expect(empty.code).toBe(1);
    expect(empty.err).toMatch(/no API calls found/);
    expect((await cli(['https://x.test'])).err).toContain('apixray record https://x.test');
    expect((await cli(['--version'])).out).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe('browser discovery', () => {
  it('knows where Chrome-family browsers live', () => {
    expect(browserCandidates({ PROGRAMFILES: 'C:\\PF', LOCALAPPDATA: 'C:\\L' }, 'win32')).toContain(
      join('C:\\PF', 'Google\\Chrome\\Application\\chrome.exe'),
    );
    expect(browserCandidates({}, 'darwin')[0]).toContain('Google Chrome.app');
    expect(browserCandidates({ PATH: '/usr/bin' }, 'linux')).toContain(
      join('/usr/bin', 'google-chrome'),
    );
  });
});

const chromiumPath = chromium.executablePath();
describe.skipIf(!existsSync(chromiumPath))('record', () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = await start(0);
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  });
  afterAll(() => server.close());

  it('records a real browser session into a spec, a client and a HAR', async () => {
    const r = await cli([
      'record',
      url,
      '--browser',
      chromiumPath,
      '--headless',
      '--duration',
      '4',
      '-o',
      'rec',
    ]);
    expect(r.code).toBe(0);
    expect(r.err).toContain('captured 7 API calls');
    expect(r.err).toContain('DELETE /users/{userId}');
    expect(r.err).toContain('auth: bearer (JWT)');
    const spec = parseYaml(readFileSync(join(work, 'rec', 'openapi.yaml'), 'utf8'));
    expect(Object.keys(spec.paths)).toEqual(['/users', '/users/{userId}']);
    expect(Object.keys(spec.paths['/users/{userId}'])).toEqual(['get', 'delete']);
    expect(Object.keys(spec.paths['/users/{userId}'].get.responses)).toEqual(['200', '404']);
    expect(spec.components.securitySchemes.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
    const capture = JSON.parse(readFileSync(join(work, 'rec', 'capture.har'), 'utf8'));
    expect(capture.log.entries).toHaveLength(7);
    const yaml = readFileSync(join(work, 'rec', 'openapi.yaml'), 'utf8');
    expect(yaml).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(yaml).not.toContain('m@example.com');
  });

  it('fails clearly without a browser', async () => {
    const r = await cli(['record', url, '--browser', join(work, 'no-such-browser.exe')]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Browser not found');
    expect((await cli(['record', url, '--headless', '--browser', chromiumPath])).err).toContain(
      '--headless needs --duration',
    );
  });
});
