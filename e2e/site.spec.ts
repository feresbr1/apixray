import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const errors: string[] = [];
test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
});
test.afterEach(() => expect(errors).toEqual([]));

test('landing explains the product and opens the real demo capture', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('X-ray any web app');
  await page.getByRole('button', { name: 'Try a real capture' }).click();
  await expect(page).toHaveURL(/#\/explore/);
  await expect(page.getByTestId('stats')).toContainText('5 endpoints');
  await expect(page.getByTestId('endpoint')).toBeVisible();
});

test('explorer: endpoint details, schema, example, curl and status tabs', async ({ page }) => {
  await page.goto('./#/explore?demo');
  await page.getByRole('button', { name: /\/items\/\{itemId\}/ }).click();
  const ep = page.getByTestId('endpoint');
  await expect(ep.locator('h2')).toContainText('/items/{itemId}');
  await expect(ep).toContainText('getItem');
  await expect(ep.locator('.field', { hasText: 'children' }).first()).toContainText('Item[]');
  await ep.getByRole('button', { name: 'Show real example' }).click();
  await expect(page.getByTestId('example')).toContainText('"author"');
  await expect(page.getByTestId('curl')).toContainText(
    "curl 'https://hn.algolia.com/api/v1/items/",
  );

  await page.getByRole('button', { name: /\/indexes\/\{indexName\}\/query/ }).click();
  await expect(ep).toContainText('queryIndex');
  await expect(ep).toContainText('Request body');
  await expect(page.getByTestId('curl')).toContainText('$API_KEY');
  await expect(page.getByTestId('curl')).not.toContainText('scrubbed');
});

test('host toggles change the API, telemetry is off by default', async ({ page }) => {
  await page.goto('./#/explore?demo');
  await expect(page.getByTestId('stats')).toContainText('5 endpoints');
  const ga = page.locator('label.chip', { hasText: 'www.google-analytics.com' });
  await expect(ga.locator('input')).not.toBeChecked();
  await page.locator('label.chip', { hasText: 'hn.algolia.com' }).click();
  await expect(page.getByTestId('stats')).toContainText('2 endpoints');
  await ga.click();
  await expect(page.getByTestId('stats')).not.toContainText('2 endpoints');
});

test('downloads a valid OpenAPI spec and a client, honouring excluded endpoints', async ({
  page,
}) => {
  await page.goto('./#/explore?demo');
  await page.getByRole('checkbox', { name: /Include GET \/isalive/ }).uncheck();
  const [yamlDl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download openapi.yaml' }).click(),
  ]);
  const spec = parseYaml(readFileSync((await yamlDl.path())!, 'utf8'));
  expect(spec.openapi).toBe('3.1.0');
  expect(Object.keys(spec.paths)).not.toContain('/isalive');
  expect(Object.keys(spec.paths)).toContain('/items/{itemId}');
  const [tsDl] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'client.ts' }).click(),
  ]);
  expect(readFileSync((await tsDl.path())!, 'utf8')).toContain('export class ApiClient');

  await page.getByRole('tab', { name: 'OpenAPI' }).click();
  await expect(page.getByTestId('spec')).toContainText('openapi: "3.1.0"');
  await page.getByRole('tab', { name: 'TypeScript' }).click();
  await expect(page.getByTestId('client')).toContainText('queryIndex(');
});

test('opens a dropped HAR file and explains invalid ones', async ({ page }) => {
  await page.goto('./');
  await page.locator('input[type=file]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  await expect(page.getByRole('alert')).toContainText('not JSON');
  await page.locator('input[type=file]').setInputFiles({
    name: 'shop.har',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        log: {
          entries: [1, 2].map((id) => ({
            _resourceType: 'fetch',
            request: { method: 'GET', url: `https://api.shop.test/v2/orders/${id}`, headers: [] },
            response: {
              status: 200,
              headers: [],
              content: { mimeType: 'application/json', text: JSON.stringify({ id, total: 9.5 }) },
            },
          })),
        },
      }),
    ),
  });
  await expect(page.getByTestId('stats')).toContainText('2 API calls → 1 endpoint');
  await expect(page.getByTestId('endpoint')).toContainText('/orders/{orderId}');
});

test('no horizontal scrolling; reload of the explorer falls back to the landing page', async ({
  page,
}) => {
  for (const hash of ['', '#/explore?demo']) {
    await page.goto(`./${hash}`);
    await expect(page.locator('main')).toBeVisible();
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
  await page.goto('about:blank');
  await page.goto('./#/explore');
  await expect(page.getByRole('button', { name: 'Try a real capture' })).toBeVisible();
});
