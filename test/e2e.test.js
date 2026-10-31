// Prueba de punta a punta contra un servidor falso que imita al sitio.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECTIONS = { bebidas: [], almacén: [] };
const prices = new Map();
for (let i = 0; i < 60; i++) {
  const ean = String(7790000000000 + i);
  const sec = i % 2 ? 'bebidas' : 'almacén';
  SECTIONS[sec].push({ ean, name: `producto prueba ${String.fromCharCode(97 + (i % 26))} x 1 kg`, sec });
  prices.set(ean, 1000 + i * 10);
}
// Catálogo minorista falso (formato VTEX)
const minPrices = new Map();
for (let i = 0; i < 300; i++) minPrices.set(String(7791000000000 + i), 2000 + i * 5);
const vtex = (ean, price) => ({
  productId: ean.slice(-4),
  productName: `Producto minorista ${ean.slice(-3)} 500 grs`,
  brand: 'Marca',
  link: `http://retail/${ean}/p`,
  categories: ['/Almacén/Aceites/Aceites comunes/', '/Almacén/Aceites/', '/Almacén/'],
  items: [{ itemId: ean.slice(-5), ean, images: [{ imageUrl: `http://img/${ean}.jpg?v=1` }], sellers: [{ sellerId: '1', sellerName: 'CARREFOUR', commertialOffer: { Price: price, ListPrice: price, AvailableQuantity: 10 } }] }],
});
const ntfy = [];
let server;
let base;

function card(p, logged) {
  const price = logged ? prices.get(p.ean) : 'private';
  return `<div class="item_card${logged ? '' : '_public'}"><div class="item_card__description">${p.name}</div>
    ${logged ? `<div class="number_price">$ ${price.toLocaleString('es-AR')}</div>` : ''}
    <div class="cart_button" data-ean="${p.ean}" data-description="${p.name}" data-price="${price}" data-sector="${p.sec}" data-section="Sec" data-category="Cat ${p.sec}"></div></div>`;
}

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const logged = /PHPSESSID=ok/.test(req.headers.cookie || '');
    if (u.pathname === '/products') {
      const m = u.searchParams.get('method');
      if (m === 'menu') return res.end(Object.keys(SECTIONS).map((s) => `<div onclick="gotoPage('sec', '${s}')"></div>`).join(''));
      const cu = u.searchParams.get('currentUrl');
      const list = cu === 'sale' ? SECTIONS.bebidas.slice(0, 3) : SECTIONS[cu.replace('sec/', '')] || [];
      if (m === 'countProducts') return res.end(String(list.length));
      return res.end(list.map((p) => card(p, logged)).join('\n'));
    }
    if (u.pathname.endsWith('/category/tree/3')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify([{ id: 161, name: 'Almacén', children: [{ id: 162, name: 'Aceites', children: [] }] }, { id: 3, name: 'Electro', children: [] }]));
    }
    if (u.pathname.startsWith('/api/catalog_system') && u.searchParams.getAll('fq').some((f) => f.startsWith('C:'))) {
      const from = Number(u.searchParams.get('_from'));
      const to = Number(u.searchParams.get('_to'));
      const list = [...minPrices].slice(from, to + 1).map(([e, p]) => vtex(e, p));
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(list));
    }
    if (u.pathname.startsWith('/api/catalog_system')) {
      const ean = (u.searchParams.get('fq') || '').split(':')[1];
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify([{ productName: 'x', link: 'http://retail/x', items: [{ ean, sellers: [{ commertialOffer: { Price: (prices.get(ean) || 1000) * 1.2, ListPrice: 0, AvailableQuantity: 10 } }] }] }]));
    }
    if (req.method === 'POST' && u.pathname.startsWith('/topic')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        ntfy.push({ title: req.headers.title, body });
        res.end('ok');
      });
      return;
    }
    res.end('<html></html>');
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function run(dataDir, extraEnv = {}) {
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    BASE_URL: `${base}/`,
    RETAIL_API: `${base}/api/catalog_system/pub/products/search`,
    NTFY_SERVER: base,
    NTFY_TOPIC: 'topic',
    TELEGRAM_BOT_TOKEN: '',
    DISCORD_WEBHOOK_URL: '',
    CF_COOKIE: 'PHPSESSID=ok',
    SESSION_SECRET: '',
    HTTP_DELAY_MS: '0',
    HTTP_RETRIES: '0',
    MIN_CATEGORIES: '161',
    MIN_DELAY_MS: '0',
    ...extraEnv,
  };
  // asíncrono: el servidor falso vive en este mismo proceso
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src/run.js')], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('close', (status) => {
      clearTimeout(t);
      resolve({ status, stdout, stderr });
    });
  });
}
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

test('ciclo completo con dos fuentes separadas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-'));

  // 1) primera corrida = base en ambas fuentes
  let r = await run(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(read(dir, 'products.json').items.length, 60);
  assert.equal(read(dir, 'min-products.json').items.length, 300);
  assert.equal(read(dir, 'min-products.json').source, 'minorista');
  assert.equal(read(dir, 'alerts.json').alerts.length, 0);
  assert.equal(read(dir, 'min-alerts.json').alerts.length, 0);
  let st = read(dir, 'status.json');
  assert.equal(st.ok, true);
  assert.equal(st.sources.mayorista.ok, true);
  assert.equal(st.sources.minorista.ok, true);
  assert.equal(ntfy.length, 0);
  // el minorista alimenta el margen de reventa del mayorista
  assert.ok(read(dir, 'retail.json')['7791000000000']?.price);

  // 2) bajas en las dos fuentes
  prices.set('7790000000010', 400); // mayorista -60%
  prices.set('7790000000020', Math.round(prices.get('7790000000020') * 0.8)); // mayorista -20%
  minPrices.set('7791000000050', 800); // minorista -64%
  minPrices.set('7791000000060', Math.round(minPrices.get('7791000000060') * 0.8)); // minorista -20% (< umbral 30%)
  r = await run(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const may = Object.fromEntries(read(dir, 'alerts.json').alerts.map((a) => [a.ean, a]));
  const min = Object.fromEntries(read(dir, 'min-alerts.json').alerts.map((a) => [a.ean, a]));
  assert.equal(may['7790000000010']?.type, 'error');
  assert.equal(may['7790000000010'].source, 'mayorista');
  assert.ok(may['7790000000020']?.types.includes('baja'));
  assert.equal(min['7791000000050']?.type, 'error');
  assert.equal(min['7791000000050'].source, 'minorista');
  assert.equal(min['7791000000060'], undefined, 'en minorista una baja de 20% no alcanza');
  assert.equal(may['7791000000050'], undefined, 'las alertas no se mezclan');
  const titles = ntfy.map((n) => Buffer.from(String(n.title).replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString());
  assert.ok(titles.some((t) => t.includes('MINORISTA')), 'aviso marcado MINORISTA');
  assert.ok(titles.some((t) => t.includes('MAYORISTA')), 'aviso marcado MAYORISTA');

  // 3) misma situación → no repite avisos
  const before = ntfy.length;
  r = await run(dir);
  assert.equal(r.status, 0);
  assert.equal(ntfy.length, before);

  // 4) sin sesión mayorista → el minorista sigue funcionando
  r = await run(dir, { CF_COOKIE: 'PHPSESSID=mala' });
  assert.equal(r.status, 0, 'si una fuente funciona, la corrida no falla');
  st = read(dir, 'status.json');
  assert.equal(st.ok, true);
  assert.equal(st.sources.mayorista.ok, false);
  assert.equal(st.sources.mayorista.consecutiveFailures, 1);
  assert.equal(st.sources.minorista.ok, true);
  assert.equal(read(dir, 'products.json').items.length, 60, 'no pisa los datos mayoristas');
  assert.ok(ntfy.length > before, 'avisa que falta la sesión');

  // 5) sólo mayorista y sin sesión → la corrida falla
  r = await run(dir, { CF_COOKIE: 'PHPSESSID=mala', MIN_ENABLED: '0' });
  assert.equal(r.status, 1);
  assert.equal(read(dir, 'status.json').consecutiveFailures, 1);

  // nada personal en los datos publicados
  const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(!/PHPSESSID=(ok|mala)/.test(all), 'no debe guardar valores de cookie en data/');
});
