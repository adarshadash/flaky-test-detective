// FlakyMart — a tiny, dependency-free demo shop that is *deliberately* full of the
// real-world behaviours that make UI tests flaky:
//   • API responses arrive after a random delay           (async rendering races)
//   • product order is not guaranteed unless ?sort=name    (nondeterministic data)
//   • a toast appears after a random delay, then vanishes  (timing / animation)
//   • the cart lives on the server and is shared by default (test-isolation leaks)
//   • the greeting depends on the browser's local hour    (environment dependency)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const PRODUCTS = [
  { id: 1, name: 'Arduino Uno', price: 24 },
  { id: 2, name: 'BACnet Gateway', price: 310 },
  { id: 3, name: 'CO2 Sensor', price: 58 },
  { id: 4, name: 'Damper Actuator', price: 145 },
  { id: 5, name: 'ESP32 Board', price: 9 },
];

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createServer() {
  /** cart contents keyed by session id; 'shared' is what you get if you don't send one */
  const carts = new Map();
  const cartFor = (sid) => {
    if (!carts.has(sid)) carts.set(sid, []);
    return carts.get(sid);
  };

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const sid = url.searchParams.get('sid') || 'shared';

    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = await readFile(path.join(here, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }

      if (url.pathname === '/api/products') {
        await sleep(rand(50, 450));
        // Unsorted requests come back in DB order most of the time… but not always
        // (think: a replica or cache that orders differently). Classic hidden flake.
        const sorted = [...PRODUCTS].sort((a, b) => a.name.localeCompare(b.name));
        const list = url.searchParams.get('sort') === 'name' || Math.random() < 0.5 ? sorted : shuffle(PRODUCTS);
        return json(res, 200, list);
      }

      if (url.pathname === '/api/cart' && req.method === 'GET') {
        return json(res, 200, cartFor(sid));
      }

      if (url.pathname === '/api/cart' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { id } = JSON.parse(body || '{}');
        const product = PRODUCTS.find((p) => p.id === id);
        if (!product) return json(res, 400, { error: 'unknown product' });
        await sleep(rand(20, 120));
        cartFor(sid).push(product);
        return json(res, 200, cartFor(sid));
      }

      if (url.pathname === '/api/cart' && req.method === 'DELETE') {
        carts.set(sid, []);
        return json(res, 200, []);
      }

      if (url.pathname === '/health') return json(res, 200, { ok: true });

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });
}

// `node demo-site/server.mjs [port]` starts it standalone.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.argv[2] || process.env.PORT || 4173);
  createServer().listen(port, () => console.log(`FlakyMart running on http://localhost:${port}`));
}
