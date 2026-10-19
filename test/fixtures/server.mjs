// A small app with a JSON API, used by the recorder tests and for local demos.
import { createServer } from 'node:http';

const users = [
  {
    id: 1,
    name: 'Ada',
    email: 'ada@example.com',
    role: 'admin',
    createdAt: '2026-01-02T10:00:00Z',
  },
  {
    id: 2,
    name: 'Linus',
    email: 'linus@example.com',
    role: 'member',
    createdAt: '2026-02-03T11:30:00Z',
  },
  {
    id: 3,
    name: 'Grace',
    email: 'grace@example.com',
    role: 'member',
    createdAt: '2026-03-04T12:45:00Z',
  },
];

const page = `<!doctype html><html><body><h1>Team</h1><ul id="list"></ul><script>
const h = { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl' };
(async () => {
  const list = await (await fetch('/api/v1/users?page=1&limit=10', { headers: h })).json();
  for (const u of list.items) await fetch('/api/v1/users/' + u.id, { headers: h });
  await fetch('/api/v1/users', { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Margaret', email: 'm@example.com', role: 'member' }) });
  await fetch('/api/v1/users/2', { method: 'DELETE', headers: h });
  await fetch('/api/v1/users/99', { headers: h });
  document.title = 'done';
})();
</script></body></html>`;

export function start(port = 0) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(page);
    }
    if (url.pathname === '/api/v1/users' && req.method === 'GET') {
      return json(200, {
        items: users.map(({ id, name }) => ({ id, name })),
        page: 1,
        total: users.length,
      });
    }
    if (url.pathname === '/api/v1/users' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () =>
        json(201, { id: 4, ...JSON.parse(body), createdAt: '2026-10-19T09:00:00Z' }),
      );
    }
    const m = /^\/api\/v1\/users\/(\d+)$/.exec(url.pathname);
    if (m) {
      const u = users.find((x) => x.id === Number(m[1]));
      if (req.method === 'DELETE') return json(204);
      return u ? json(200, u) : json(404, { error: 'not_found', message: 'No such user' });
    }
    json(404, { error: 'not_found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1]?.endsWith('server.mjs')) {
  const s = await start(Number(process.argv[2] ?? 4321));
  console.log(`http://127.0.0.1:${s.address().port}/`);
}
