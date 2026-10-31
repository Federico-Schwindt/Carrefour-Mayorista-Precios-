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
    CF_NAME: '',
    CF_COOKIE: 'PHPSESSID=ok',
    SESSION_SECRET: '',
    HTTP_DELAY_MS: '0',
    HTTP_RETRIES: '0',
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

test('ciclo completo: base → bajas → avisos → falla de sesión', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-'));

  // 1) primera corrida = base
  let r = await run(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  let products = read(dir, 'products.json');
  assert.equal(products.items.length, 60);
  assert.equal(read(dir, 'alerts.json').alerts.length, 0);
  assert.equal(read(dir, 'status.json').ok, true);
  assert.equal(ntfy.length, 0);
  for (const f of ['history.json', 'retail.json', 'state.json']) assert.ok(fs.existsSync(path.join(dir, f)));

  // 2) bajas: una de 60% (error) y otra de 20% (baja)
  prices.set('7790000000010', 400);
  prices.set('7790000000020', Math.round(prices.get('7790000000020') * 0.8));
  r = await run(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const alerts = read(dir, 'alerts.json').alerts;
  const by = Object.fromEntries(alerts.map((a) => [a.ean, a]));
  assert.equal(by['7790000000010']?.type, 'error');
  assert.equal(by['7790000000020']?.types.includes('baja'), true);
  assert.equal(ntfy.length >= 2, true, 'debería notificar por ntfy');
  assert.ok(by['7790000000010'].notified);
  const hist = read(dir, 'history.json');
  assert.equal(hist['7790000000010'].length, 2);

  // 3) misma situación → no repite avisos
  const before = ntfy.length;
  r = await run(dir);
  assert.equal(r.status, 0);
  assert.equal(ntfy.length, before);

  // 4) sin sesión → registra falla, no pisa datos
  r = await run(dir, { CF_COOKIE: 'PHPSESSID=mala' });
  assert.equal(r.status, 1);
  const st = read(dir, 'status.json');
  assert.equal(st.ok, false);
  assert.equal(st.consecutiveFailures, 1);
  assert.equal(read(dir, 'products.json').items.length, 60);

  // nada personal en los datos publicados
  const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(!/PHPSESSID/.test(all), 'no debe guardar cookies en data/');
});
