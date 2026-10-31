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
const prices = new Map(); // Gualeguaychú
for (let i = 0; i < 60; i++) {
  const ean = String(7790000000000 + i);
  const sec = i % 2 ? 'bebidas' : 'almacén';
  SECTIONS[sec].push({ ean, name: `producto prueba ${String.fromCharCode(97 + (i % 26))} x 1 kg`, sec });
  prices.set(ean, 1000 + i * 10);
}
const listPrices = new Map([['7790000000009', 4000]]); // precio tachado (73% off)
const pricesZ = new Map(prices); // Zárate: igual salvo un producto mucho más barato
pricesZ.set('7790000000007', 500);
const BRANCH = { ok: 'GUALEGUAYCHU', zar: 'ZARATE' };
const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2 }); // como el sitio: 1,090.00
// Catálogo minorista falso (formato VTEX)
const minPrices = new Map();
for (let i = 0; i < 300; i++) minPrices.set(String(7791000000000 + i), 2000 + i * 5);
minPrices.set('7790000000005', 600); // mismo EAN que un mayorista, más barato en minorista
const vtex = (ean, price) => ({
  productId: ean.slice(-4),
  productName: `Producto minorista ${ean.slice(-3)} 500 grs`,
  brand: 'Marca',
  link: `/${ean}/p`,
  categories: ['/Almacén/Aceites/Aceites comunes/', '/Almacén/Aceites/', '/Almacén/'],
  properties: [{ name: 'Cantidad Maxima Permitida', values: ['12'] }, { name: 'Gramaje de unidad de consumo', values: ['500.00'] }, { name: 'Gramaje de unidad de medida', values: ['GRM'] }],
  items: [{ itemId: ean.slice(-5), ean, images: [{ imageUrl: `http://img/${ean}.jpg?v=1` }], sellers: [{ sellerId: '1', sellerName: 'CARREFOUR', commertialOffer: { Price: price, ListPrice: price, AvailableQuantity: 10, discountHighlights: [] } }] }],
});
const searchCalls = [];
const ntfy = [];
let server;
let base;

function card(p, branch) {
  const table = branch === 'ZARATE' ? pricesZ : prices;
  const price = branch ? table.get(p.ean) : null;
  const lp = branch && listPrices.get(p.ean);
  return `<div class="item_card${branch ? '' : '_public'}"><div class="item_card__description">${p.name}</div>
    ${branch ? `<div class="title_price">Llevando 3 o más</div><div class="price_container"><div class="number_price">$ ${fmt(price)}</div></div>` : ''}
    ${lp ? `<div class="discounted_number_price"><s>$ ${fmt(lp)}</s></div>` : ''}
    <div class="cart_button" data-ean="${p.ean}" data-description="${p.name}" data-um="3" data-saleName="" data-price="${branch ? fmt(price) : 'private'}" data-sector="${p.sec}" data-section="Sec" data-category="Cat ${p.sec}"></div></div>`;
}

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const sid = ((req.headers.cookie || '').match(/PHPSESSID=([^;]+)/) || [])[1];
    const branch = BRANCH[sid] || null;
    if (u.pathname === '/products') {
      const m = u.searchParams.get('method');
      if (m === 'menu') return res.end(Object.keys(SECTIONS).map((s) => `<div onclick="gotoPage('sec', '${s}')"></div>`).join(''));
      const cu = u.searchParams.get('currentUrl');
      const list = cu === 'sale' ? SECTIONS.bebidas.slice(0, 3) : SECTIONS[cu.replace('sec/', '')] || [];
      if (m === 'countProducts') return res.end(String(list.length));
      return res.end(list.map((p) => card(p, branch)).join('\n'));
    }
    if (/\/category\/tree\/\d$/.test(u.pathname)) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify([{ id: 161, name: 'Almacén', url: 'http://retail/almacen', children: [{ id: 162, name: 'Aceites', children: [] }] }, { id: 3, name: 'Electro', url: 'http://retail/electro', children: [] }]));
    }
    // Búsqueda con la región de la tienda (precio de Hiper Gualeguaychú)
    if (u.pathname.startsWith('/api/io/_v/api/intelligent-search/product_search')) {
      searchCalls.push(u.searchParams.get('regionId'));
      const count = Number(u.searchParams.get('count'));
      const page = Number(u.searchParams.get('page'));
      const query = u.searchParams.get('query');
      let all = [...minPrices].map(([e, p]) => vtex(e, p));
      if (query) all = all.filter((p) => p.items[0].ean === query);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ recordsFiltered: all.length, products: all.slice((page - 1) * count, page * count) }));
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
    // home: "Pedido entregado por <strong>SUCURSAL</strong>"
    res.end(branch ? `<html><div class="title-suc cursor"><span class="default_text">Pedido entregado por </span><strong onclick="openStoreChangeModal()">${branch}</strong></div></html>` : '<html></html>');
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
    CF_COOKIE_2: '',
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

const titlesOf = (list) => list.map((n) => Buffer.from(String(n.title).replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString());

test('ciclo completo: sucursales, minorista, oportunidades, migración y fallas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-'));
  const nowMin = Math.round(Date.now() / 60000);
  // Datos con el formato viejo (antes de multi-sucursal) → deben migrar a Gualeguaychú
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify({ items: [{ ean: '7790000000001', n: 'viejo', p: 1010, e: 1010, f: new Date().toISOString(), l: new Date().toISOString() }] }));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ '7790000000001': [[nowMin - 5000, 1010]] }));
  fs.writeFileSync(path.join(dir, 'alerts.json'), JSON.stringify({ alerts: [] }));

  // 1) primera corrida con dos sucursales + minorista
  let r = await run(dir, { CF_COOKIE: 'ok', CF_COOKIE_2: 'PHPSESSID=zar' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!fs.existsSync(path.join(dir, 'products.json')), 'migró los archivos viejos');
  assert.equal(read(dir, 'may-gualeguaychu-history.json')['7790000000001'][0][0], nowMin - 5000, 'conserva el historial viejo');
  assert.equal(read(dir, 'may-gualeguaychu-products.json').items.length, 60);
  assert.equal(read(dir, 'may-zarate-products.json').items.length, 60);
  assert.equal(read(dir, 'min-products.json').items.length, 301);
  assert.equal(read(dir, 'min-products.json').store, 'Hiper Gualeguaychú', 'precios de la tienda de Gualeguaychú');
  assert.ok(searchCalls.includes(Buffer.from('SW#carrefourar0240').toString('base64')), 'usa la región de la tienda');
  assert.equal(read(dir, 'min-products.json').items.find((i) => i.ean === '7791000000000').lim, 12, 'límite por compra');
  const g9 = read(dir, 'may-gualeguaychu-products.json').items.find((i) => i.ean === '7790000000009');
  assert.equal(g9.e, 1090, 'lee el formato 1,090.00');
  assert.equal(g9.lp, 4000, 'lee el precio tachado');
  assert.equal(g9.q, 3, 'compra mínima');
  const ids = read(dir, 'sources.json').sources.map((x) => x.id);
  assert.deepEqual(ids, ['may-gualeguaychu', 'may-zarate', 'min']);
  let st = read(dir, 'status.json');
  assert.equal(st.ok, true);
  assert.equal(st.sources['may-gualeguaychu'].ok, true);
  assert.equal(st.sources['may-zarate'].ok, true);
  assert.equal(st.sources.min.ok, true);
  assert.deepEqual(st.cookies.map((c) => [c.var, c.ok, c.branch]), [['CF_COOKIE', true, 'GUALEGUAYCHU'], ['CF_COOKIE_2', true, 'ZARATE']]);

  // Oportunidades desde la primera lectura (sin historial)
  const opp = read(dir, 'oportunidades.json').items;
  const find = (sid, ean) => opp.find((o) => o.sourceId === sid && o.ean === ean);
  assert.ok(find('may-zarate', '7790000000007')?.signals.sucursal >= 0.5, 'más barato que otra sucursal');
  assert.ok(find('may-gualeguaychu', '7790000000009')?.signals.descuento >= 0.7, 'gran descuento vs tachado');
  assert.ok(find('min', '7790000000005')?.signals.bajoMayorista >= 0.4, 'minorista más barato que Maxi');
  let titles = titlesOf(ntfy);
  assert.ok(titles.some((t) => t.includes('MAYORISTA ZARATE') && t.includes('Oportunidad')), 'aviso de oportunidad con la sucursal');
  assert.ok(titles.some((t) => t.includes('MINORISTA') && t.includes('Oportunidad')), 'aviso de oportunidad minorista');
  assert.ok(read(dir, 'may-zarate-alerts.json').alerts.some((a) => a.type === 'oportunidad' && a.ean === '7790000000007'));

  // 2) bajas en las fuentes
  prices.set('7790000000010', 400); // Gualeguaychú -60%
  prices.set('7790000000020', Math.round(prices.get('7790000000020') * 0.8)); // Gualeguaychú -20%
  minPrices.set('7791000000050', 800); // minorista -64%
  minPrices.set('7791000000060', Math.round(minPrices.get('7791000000060') * 0.8)); // minorista -20% (< umbral 30%)
  const beforeOpp = titlesOf(ntfy).filter((t) => t.includes('Oportunidad') && !t.includes('7790000000010')).length;
  r = await run(dir, { CF_COOKIE: 'ok', CF_COOKIE_2: 'zar' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const may = Object.fromEntries(read(dir, 'may-gualeguaychu-alerts.json').alerts.filter((a) => a.type !== 'oportunidad').map((a) => [a.ean, a]));
  const min = Object.fromEntries(read(dir, 'min-alerts.json').alerts.filter((a) => a.type !== 'oportunidad').map((a) => [a.ean, a]));
  assert.equal(may['7790000000010']?.type, 'error');
  assert.equal(may['7790000000010'].branch, 'GUALEGUAYCHU');
  assert.ok(may['7790000000020']?.types.includes('baja'));
  assert.equal(min['7791000000050']?.type, 'error');
  assert.equal(min['7791000000060'], undefined, 'en minorista una baja de 20% no alcanza');
  assert.equal(may['7791000000050'], undefined, 'las alertas no se mezclan');
  titles = titlesOf(ntfy);
  assert.ok(titles.some((t) => t.includes('MAYORISTA GUALEGUAYCHU') && t.includes('error')), 'aviso con sucursal');
  const sameOpp = ['7790000000007', '7790000000009', '7790000000005'];
  void sameOpp;
  assert.ok(titles.filter((t) => t.includes('Oportunidad') && !t.includes('7790000000010')).length >= beforeOpp);

  // 3) misma situación → no repite avisos
  const before = ntfy.length;
  r = await run(dir, { CF_COOKIE: 'ok', CF_COOKIE_2: 'zar' });
  assert.equal(r.status, 0);
  assert.equal(ntfy.length, before, 'no repite avisos ni oportunidades');

  // 4) se vence la cookie de Zárate → Gualeguaychú y minorista siguen
  r = await run(dir, { CF_COOKIE: 'ok', CF_COOKIE_2: 'mala' });
  assert.equal(r.status, 0, 'si una fuente funciona, la corrida no falla');
  st = read(dir, 'status.json');
  assert.equal(st.sources['may-zarate'].ok, false);
  assert.equal(st.sources['may-zarate'].consecutiveFailures, 1);
  assert.equal(st.sources['may-gualeguaychu'].ok, true);
  assert.equal(st.cookies[1].branch, 'ZARATE', 'recuerda de qué sucursal era la cookie');
  assert.ok(read(dir, 'sources.json').sources.some((x) => x.id === 'may-zarate'), 'sigue mostrando los datos viejos de Zárate');
  assert.ok(titlesOf(ntfy).slice(before).some((t) => /ZARATE/.test(t) && /venci/.test(t)), 'avisa que venció Zárate');

  // 5) dos cookies de la misma sucursal → error claro en la segunda
  r = await run(dir, { CF_COOKIE: 'ok', CF_COOKIE_2: 'ok', MIN_ENABLED: '0' });
  assert.equal(r.status, 0);
  assert.match(read(dir, 'status.json').cookies[1].error, /misma sucursal/);

  // 6) ninguna fuente funciona → la corrida falla
  r = await run(dir, { CF_COOKIE: 'mala', CF_COOKIE_2: '', MIN_ENABLED: '0' });
  assert.equal(r.status, 1);
  assert.equal(read(dir, 'status.json').consecutiveFailures, 1);

  // nada personal en los datos publicados
  const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(!/PHPSESSID=(ok|mala|zar)/.test(all), 'no debe guardar valores de cookie en data/');
});
