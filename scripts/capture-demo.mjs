// Record the demo capture: a real browsing session on https://hn.algolia.com (Hacker News search),
// saved as a HAR file. Credentials and cookies are scrubbed before it is written to examples/.
// Usage: node scripts/capture-demo.mjs
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const raw = 'examples/hn-search.raw.har';
const browser = await chromium.launch();
const context = await browser.newContext({ recordHar: { path: raw, content: 'embed' } });
const page = await context.newPage();
const pause = (ms) => page.waitForTimeout(ms);

await page.goto('https://hn.algolia.com/?q=sqlite', { waitUntil: 'networkidle' });
for (const q of ['webassembly', 'postgres', 'rust compiler']) {
  const box = page.locator('input[type="search"]').first();
  await box.fill(q);
  await pause(1500);
}
await page.goto(
  'https://hn.algolia.com/?dateRange=pastWeek&page=0&prefix=true&query=openapi&sort=byDate&type=story',
  { waitUntil: 'networkidle' },
);
await pause(1000);
await page.goto(
  'https://hn.algolia.com/?dateRange=all&page=1&prefix=false&query=reverse%20engineering&sort=byPopularity&type=comment',
  { waitUntil: 'networkidle' },
);
await pause(1000);
// Open a few stories (the item endpoint) through the API the site uses.
const ids = await page.evaluate(async () => {
  const r = await fetch('https://hn.algolia.com/api/v1/search?tags=front_page');
  const j = await r.json();
  return j.hits.slice(0, 3).map((h) => h.objectID);
});
for (const id of ids) {
  await page.evaluate(
    async (id) => (await fetch(`https://hn.algolia.com/api/v1/items/${id}`)).json(),
    id,
  );
}
for (const user of ['pg', 'dang']) {
  await page.evaluate(
    async (u) => (await fetch(`https://hn.algolia.com/api/v1/users/${u}`)).json(),
    user,
  );
}
await context.close();
await browser.close();

const har = JSON.parse(readFileSync(raw, 'utf8'));
const SECRET = /^(x-algolia-api-key|x-algolia-application-id|cookie|set-cookie)$/i;
for (const e of har.log.entries) {
  for (const h of [...e.request.headers, ...e.response.headers])
    if (SECRET.test(h.name)) h.value = 'scrubbed';
  e.request.cookies = [];
  e.response.cookies = [];
  for (const q of e.request.queryString ?? []) if (/api-key/i.test(q.name)) q.value = 'scrubbed';
  e.request.url = e.request.url.replace(/(x-algolia-api-key=)[^&]+/i, '$1scrubbed');
}
// Keep the file small: bodies of pages, scripts, styles and images are never analysed.
for (const e of har.log.entries) {
  const mime = e.response.content?.mimeType ?? '';
  if (!/json/i.test(mime) && e.response.content) {
    delete e.response.content.text;
    delete e.response.content.encoding;
  }
}
writeFileSync('examples/hn-search.har', JSON.stringify(har, null, 1));
rmSync(raw);
console.log(`${har.log.entries.length} entries`);
