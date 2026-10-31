// Radar Maxi — dashboard estático. Lee los JSON de ./data/ que genera el monitor.
// Fuentes SEPARADAS: 🏪 mayorista (una por sucursal Maxi) y 🛒 minorista (carrefour.com.ar).
const DATA = './data/';
const PAGE = 60;
const TYPE_LABEL = { error: '🚨 Posible error', oportunidad: '🔥 Oportunidad', reventa: '💰 Reventa', baja: '📉 Baja fuerte', minimo: '🏆 Mínimo histórico' };
const SIG_LABEL = { descuento: '🏷️ Descuento', sucursal: '🏪 Entre sucursales', reventa: '💰 Reventa', bajoMayorista: '🛒 Más barato que Maxi', kilo: '⚖️ Precio por kg' };
const MAXI = 'https://comerciante.carrefour.com.ar/';
const LEGACY = [
  { id: 'may-legacy', kind: 'mayorista', name: 'Carrefour Maxi', files: { products: 'products.json', alerts: 'alerts.json', history: 'history.json' } },
  { id: 'min', kind: 'minorista', name: 'carrefour.com.ar', files: { products: 'min-products.json', alerts: 'min-alerts.json', history: 'min-history.json' } },
];

const blank = () => ({ products: [], byEan: new Map(), alerts: [], history: null, loaded: false, updatedAt: null });
const S = {
  manifest: [],
  data: {},
  kind: 'mayorista',
  branch: null,
  status: null,
  retail: null,
  opp: null,
  tab: 'oportunidades',
  alertType: '',
  oppSig: '',
  limits: { oportunidades: PAGE, alertas: PAGE, reventa: PAGE, bajas: PAGE, buscar: PAGE },
};
const srcOf = (id) => S.manifest.find((s) => s.id === id);
const mayList = () => S.manifest.filter((s) => s.kind === 'mayorista');
const minSrc = () => S.manifest.find((s) => s.kind === 'minorista');
const curId = () => (S.kind === 'minorista' ? minSrc()?.id : S.branch);
const dataOf = (id) => S.data[id] || (S.data[id] = blank());
const D = () => dataOf(curId());

// ---------- utilidades ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ars = (n) => (n || n === 0 ? '$' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: Number(n) < 100 ? 2 : 0 }) : '—');
const pct = (x) => `${Math.round(x * 100)}%`;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const title = (s) => String(s || '').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const NOIMG = 'https://tupedido.carrefour.com.ar/imagenesPDA/noimage-svg.svg';
const fullImg = (x) => (!x ? null : /^https?:/.test(x) ? x : `https://carrefourar.vteximg.com.br/arquivos/ids/${x}`);
const fullUrl = (x) => (!x ? null : /^https?:/.test(x) ? x : `https://www.carrefour.com.ar/${x}/p`);
const kindOf = (id) => srcOf(id)?.kind || (id === 'min' ? 'minorista' : 'mayorista');
const imgOf = (p, id = curId()) => fullImg(p.im || p.image) || (kindOf(id) === 'mayorista' && /^\d+$/.test(p.ean) ? `https://tupedido.carrefour.com.ar/imagenesPDA/${p.ean}.jpg` : NOIMG);
const linkOf = (p, id = curId()) => (kindOf(id) === 'minorista' ? fullUrl(p.u || p.url) || 'https://www.carrefour.com.ar/' : `${MAXI}p/${p.ean}`);
const unseen = (p) => p.l && D().updatedAt && Date.parse(p.l) < Date.parse(D().updatedAt) - 3600e3;
function srcBadge(id = curId()) {
  const s = srcOf(id);
  if (kindOf(id) === 'minorista') return '<span class="src min">MINORISTA</span>';
  return `<span class="src may">MAYORISTA${s && mayList().length > 1 ? ` · ${esc(title(s.name))}` : ''}</span>`;
}
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin storage */ } },
};
function ago(ts) {
  if (!ts) return '—';
  const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
  if (m < 1) return 'recién';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}
const fmtDate = (d) => new Date(d).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtDateFull = (d) => new Date(d).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

async function getJson(name) {
  const r = await fetch(`${DATA}${name}?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
}

// ---------- CSV (se abre en Excel: separador ";" y coma decimal) ----------
const csvNum = (n) => (n === null || n === undefined || n === '' ? '' : String(Math.round(Number(n) * 100) / 100).replace('.', ','));
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function downloadCsv(filename, header, rows) {
  const text = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
const today = () => new Date().toISOString().slice(0, 10);
const srcFileTag = (id) => (kindOf(id) === 'minorista' ? 'minorista' : `mayorista-${(srcOf(id)?.name || 'maxi').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
function historyRows(series, nowPrice) {
  const rows = [];
  for (let i = 0; i < series.length; i++) {
    const [t, price, base] = series[i];
    const next = series[i + 1];
    rows.push([fmtDateFull(t * 60000), next ? fmtDateFull(next[0] * 60000) : 'hoy', csvNum(price), csvNum(base ?? '')]);
  }
  if (!series.length && nowPrice) rows.push([fmtDateFull(Date.now()), 'hoy', csvNum(nowPrice), '']);
  return rows;
}

// Unidad (kg/l/u) desde la descripción — misma lógica que el monitor
function parseQty(desc, multipack = true) {
  const d = ` ${String(desc || '').toLowerCase().replace(/,/g, '.')} `;
  const U = '(kgs?|kilos?|k|grs?|grm|gramos?|g|ml|cc|cm3|lts?|litros?|l)';
  const n2 = (n, u) => (/^(kgs?|kilos?|k)$/.test(u) ? { q: n, u: 'kg' } : /^(grs?|grm|gramos?|g)$/.test(u) ? { q: n / 1000, u: 'kg' } : /^(ml|cc|cm3)$/.test(u) ? { q: n / 1000, u: 'l' } : { q: n, u: 'l' });
  let m = d.match(new RegExp(`(?<![\\w.])(\\d+)\\s*(?:u\\.?|un\\.?|unid\\.?|unidades)?\\s*x\\s*(\\d+(?:\\.\\d+)?)\\s*${U}\\b`));
  if (m && !multipack) return n2(+m[2], m[3]); // en Maxi el precio es por unidad aunque diga "12 x 90 grs"
  if (m && +m[1] > 1 && +m[1] <= 200) { const b = n2(+m[2], m[3]); return { q: b.q * +m[1], u: b.u }; }
  const all = [...d.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${U}(?![a-z])`, 'g'))];
  if (all.length) { const l = all[all.length - 1]; const r = n2(+l[1], l[2]); if (r.q > 0) return r; }
  m = d.match(/(?:x\s*)?(?<![\w.])(\d+)\s*(?:u|un|uni|unid|unidades|rollos|saquitos|sobres)\b/);
  return m && +m[1] > 0 ? { q: +m[1], u: 'u' } : null;
}
const NON_UNIT = /electro|tecnolog|hogar|indumentaria|jugueter|librer|automotor|aire libre|beb[eé]|bazar|textil/i;
function unitOf(p, id = curId()) {
  if (NON_UNIT.test(p.s || '')) return null;
  const q = parseQty(p.n, kindOf(id) !== 'mayorista');
  return q && q.u !== 'u' && q.q > 0 ? q : null;
}

// ---------- historial ----------
function priceAt(series, t) {
  let out = null;
  for (const p of series) { if (p[0] <= t) out = p[1]; else break; }
  return out;
}
function median(a) {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function refPrice(series) {
  const now = Date.now() / 60000;
  const out = [];
  for (let d = 0; d < 30; d++) {
    const t = now - d * 1440;
    if (series.length && t < series[0][0]) break;
    const v = priceAt(series, t);
    if (v) out.push(v);
  }
  return median(out);
}

// ---------- carga ----------
async function loadSource(id) {
  const s = srcOf(id);
  const d = dataOf(id);
  if (!s) return d;
  const [products, alerts] = await Promise.allSettled([getJson(s.files.products), getJson(s.files.alerts)]);
  d.products = products.value?.items || [];
  d.byEan = new Map(d.products.map((p) => [p.ean, p]));
  d.updatedAt = products.value?.updatedAt || null;
  d.alerts = (alerts.value?.alerts || []).map((a) => ({ ...a, source: a.source || s.kind, sourceId: a.sourceId || id }));
  d.loaded = true;
  return d;
}
async function ensureHistory(id = curId()) {
  const d = dataOf(id);
  if (!d.history) { try { d.history = await getJson(srcOf(id).files.history); } catch { d.history = {}; } }
  return d.history;
}
async function ensureRetail() {
  if (!S.retail) { try { S.retail = await getJson('retail.json'); } catch { S.retail = {}; } }
  return S.retail;
}
async function ensureAllProducts() {
  await Promise.all(S.manifest.filter((s) => !dataOf(s.id).loaded).map((s) => loadSource(s.id)));
}

async function loadAll() {
  try { S.status = await getJson('status.json'); } catch { S.status = null; }
  try { S.manifest = (await getJson('sources.json')).sources || []; } catch { S.manifest = []; }
  if (!S.manifest.length) S.manifest = LEGACY;
  try { S.opp = await getJson('oportunidades.json'); } catch { S.opp = { items: [] }; }
  S.data = {};
  await Promise.all(S.manifest.map((s) => loadSource(s.id)));
  if (!S.branch || !srcOf(S.branch)) S.branch = store.get('branch', '') && srcOf(store.get('branch', '')) ? store.get('branch', '') : mayList()[0]?.id || null;
  updateBadges();
  renderBranches();
}

// ---------- tarjetas ----------
function productCard(p, { right = '', extra = '', id = curId() } = {}) {
  const promo = p.pr ? `<span class="pill promo">${esc(p.pr)}</span>` : p.pp || p.o ? '<span class="pill promo">Oferta</span>' : '';
  const minq = p.q ? `<span class="meta">mín. ${p.q} u.${p.pk ? ` · bulto ${p.pk}` : ''}</span>` : '';
  const was = p.pp && p.p > p.pp ? p.p : p.lp && p.lp > (p.e ?? p.p) ? p.lp : null;
  return `<button class="card ${kindOf(id) === 'minorista' ? 'min' : 'may'}" data-ean="${esc(p.ean)}" data-src="${esc(id)}">
    <img loading="lazy" src="${esc(imgOf(p, id))}" onerror="this.onerror=null;this.src='${NOIMG}'" alt="">
    <div>
      <div class="meta">${srcBadge(id)}${esc(p.c || p.sc || '')}</div>
      <div class="name">${esc(p.n)}</div>
      <div><span class="price">${ars(p.e ?? p.p)}</span>${was ? `<span class="was">${ars(was)}</span>` : ''} ${right}</div>
      <div style="margin-top:4px">${unseen(p) ? `<span class="pill">no visto desde ${ago(p.l)}</span>` : ''}${promo}${minq}${p.sl ? `<span class="meta">Vende: ${esc(p.sl)}</span>` : ''}${extra}</div>
    </div>
  </button>`;
}

function alertCard(a) {
  const id = a.sourceId || curId();
  const types = (a.types || [a.type]).map((t) => `<span class="pill ${t}">${TYPE_LABEL[t] || t}</span>`).join('');
  const was = a.prev && a.prev > a.price ? `<span class="was">${ars(a.prev)}</span> <span class="neg">-${pct(a.dropPct || 1 - a.price / a.prev)}</span>` : a.listPrice && a.listPrice > a.price ? `<span class="was">${ars(a.listPrice)}</span>` : '';
  const retail = a.retail ? `<div class="meta">Minorista ${ars(a.retail)}${a.margin != null ? ` · margen <span class="pos">${pct(a.margin)}</span>` : ''}</div>` : '';
  return `<button class="card ${kindOf(id) === 'minorista' ? 'min' : 'may'}" data-ean="${esc(a.ean)}" data-src="${esc(id)}">
    <img loading="lazy" src="${esc(imgOf(a, id))}" onerror="this.onerror=null;this.src='${NOIMG}'" alt="">
    <div>
      <div>${srcBadge(id)}${types}${a.suppressed ? '<span class="pill">no notificada</span>' : ''}</div>
      <div class="name">${esc(a.name)}</div>
      <div><span class="price">${ars(a.price)}</span>${was}</div>
      ${retail}${a.promo ? `<span class="pill promo">${esc(a.promo)}</span>` : ''}${a.seller ? `<div class="meta">Vende: ${esc(a.seller)}</div>` : ''}
      <ul class="reasons">${(a.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <div class="meta" style="margin-top:4px">${esc(a.category || '')} · ${ago(a.ts)}${a.notified ? ' · 🔔 avisada' : ''}</div>
    </div>
  </button>`;
}

function oppCard(o) {
  const sigs = Object.entries(o.signals || {}).map(([k, v]) => `<span class="sig ${k}">${SIG_LABEL[k] || k} ${k === 'reventa' ? '+' : '-'}${pct(v)}</span>`).join('');
  return `<button class="card ${o.kind === 'minorista' ? 'min' : 'may'}" data-ean="${esc(o.ean)}" data-src="${esc(o.sourceId)}">
    <img loading="lazy" src="${esc(imgOf(o, o.sourceId))}" onerror="this.onerror=null;this.src='${NOIMG}'" alt="">
    <div>
      <div class="meta">${srcBadge(o.sourceId)}${esc(o.category || '')}</div>
      <div class="name">${esc(o.name)}</div>
      <div><span class="price">${ars(o.price)}</span>${o.listPrice && o.listPrice > o.price ? `<span class="was">${ars(o.listPrice)}</span>` : ''}</div>
      <div style="margin-top:4px">${sigs}${o.promo ? `<span class="pill promo">${esc(o.promo)}</span>` : ''}${o.minQty ? `<span class="meta">mín. ${o.minQty} u.</span>` : ''}</div>
      <ul class="reasons">${(o.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    </div>
  </button>`;
}

function listHtml(items, render, key) {
  if (!items.length) return document.getElementById('emptyTpl').innerHTML;
  const lim = S.limits[key];
  let html = items.slice(0, lim).map(render).join('');
  if (items.length > lim) html += `<button class="more" data-more="${key}">Ver más (${items.length - lim})</button>`;
  return html;
}

// ---------- vistas ----------
function oppItems() {
  const q = norm($('#oppSearch').value);
  const scope = $('#oppScope').value;
  return (S.opp?.items || []).filter((o) => {
    if (o.kind !== S.kind) return false;
    if (S.kind === 'mayorista' && scope === 'branch' && o.sourceId !== S.branch) return false;
    if (S.oppSig && !(S.oppSig in (o.signals || {}))) return false;
    if (q && !norm(`${o.name} ${o.ean} ${o.category}`).includes(q)) return false;
    return true;
  });
}
function renderOpp() {
  const items = oppItems();
  $('#oppCount').textContent = `${items.length.toLocaleString('es-AR')} oportunidades${S.opp?.updatedAt ? ` · ${ago(S.opp.updatedAt)}` : ''}`;
  $('#oppList').innerHTML = items.length
    ? listHtml(items, oppCard, 'oportunidades')
    : '<div class="empty">No hay oportunidades con estos filtros. Se recalculan en cada lectura (cada 30 min).</div>';
}

function renderAlerts() {
  const q = norm($('#alertSearch').value);
  const hours = Number($('#alertRange').value);
  const since = hours ? Date.now() - hours * 3600e3 : 0;
  const items = D().alerts.filter((a) => {
    if (S.alertType && !(a.types || [a.type]).includes(S.alertType)) return false;
    if (since && Date.parse(a.ts) < since) return false;
    if (q && !norm(`${a.name} ${a.ean} ${a.category} ${a.brand || ''}`).includes(q)) return false;
    return true;
  });
  $('#alertList').innerHTML = listHtml(items, alertCard, 'alertas');
}

function updateBadges() {
  const day = (kind) => S.manifest.filter((s) => s.kind === kind).reduce((n, s) => n + dataOf(s.id).alerts.filter((a) => Date.parse(a.ts) > Date.now() - 864e5).length, 0);
  $('#badgeMay').textContent = day('mayorista') || '';
  $('#badgeMin').textContent = day('minorista') || '';
}

function renderBranches() {
  const list = mayList();
  const box = $('#branches');
  if (list.length < 2) { box.innerHTML = ''; return; }
  box.innerHTML = list.map((s) => {
    const st = S.status?.sources?.[s.id];
    const bad = st && st.ok === false;
    return `<button role="radio" data-branch="${esc(s.id)}" class="${s.id === S.branch ? 'active' : ''}" aria-checked="${s.id === S.branch}">${esc(title(s.name))}${bad ? ' <span class="stale">⚠️</span>' : ''}</button>`;
  }).join('');
}

async function renderResale() {
  if (S.kind !== 'mayorista') return setTab('oportunidades');
  if (!S.retail) $('#resaleList').innerHTML = '<div class="empty">Cargando precios minoristas…</div>';
  const retail = await ensureRetail();
  const min = Number($('#marginMin').value) / 100;
  $('#marginVal').textContent = pct(min);
  const q = norm($('#resaleSearch').value);
  const sector = $('#resaleSector').value;
  const items = [];
  for (const p of D().products) {
    const r = retail[p.ean];
    const price = p.e ?? p.p;
    if (!r?.price || !price || r.available === false || unseen(p)) continue;
    const margin = r.price / price - 1;
    if (margin < min) continue;
    if (sector && p.s !== sector) continue;
    if (q && !norm(`${p.n} ${p.ean}`).includes(q)) continue;
    items.push({ p, r, margin });
  }
  items.sort((a, b) => b.margin - a.margin);
  $('#resaleList').innerHTML = listHtml(items, ({ p, r, margin }) => productCard(p, {
    right: `<span class="pos">+${pct(margin)}</span>`,
    extra: `<div class="meta">Minorista ${ars(r.price)} · ganancia ${ars(r.price - (p.e ?? p.p))} por unidad</div>`,
  }), 'reventa');
}

async function renderDrops() {
  const id = curId();
  if (!dataOf(id).history) $('#dropList').innerHTML = '<div class="empty">Cargando historial…</div>';
  const history = await ensureHistory(id);
  if (id !== curId()) return;
  const w = $('#dropWindow').value;
  const sector = $('#dropSector').value;
  const t = Date.now() / 60000 - (w === 'ref' ? 0 : Number(w) * 1440);
  const items = [];
  for (const p of D().products) {
    const s = history[p.ean];
    const now = p.e ?? p.p;
    if (!s?.length || !now) continue;
    if (sector && p.s !== sector) continue;
    const old = w === 'ref' ? refPrice(s) : priceAt(s, t);
    if (!old || old <= now) continue;
    const drop = 1 - now / old;
    if (drop < 0.02) continue;
    items.push({ p, old, drop });
  }
  items.sort((a, b) => b.drop - a.drop);
  $('#dropList').innerHTML = items.length
    ? listHtml(items, ({ p, old, drop }) => productCard(p, { right: `<span class="neg">-${pct(drop)}</span>`, extra: `<div class="meta">Antes ${ars(old)}</div>` }), 'bajas')
    : '<div class="empty">Todavía no hay bajas registradas. El historial se arma con cada lectura; mientras tanto mirá 🔥 Oportunidades.</div>';
}

function searchItems() {
  const q = norm($('#q').value);
  const sector = $('#searchSector').value;
  const sort = $('#searchSort').value;
  let items = D().products.filter((p) => (!sector || p.s === sector) && (!q || norm(`${p.n} ${p.ean} ${p.c} ${p.b || ''}`).includes(q)));
  const price = (p) => p.e ?? p.p ?? Infinity;
  const onSale = (p) => (p.pr || p.pp || p.o || (p.lp && p.lp > price(p)) ? 1 : 0);
  if (sort === 'priceAsc') items.sort((a, b) => price(a) - price(b));
  else if (sort === 'priceDesc') items.sort((a, b) => price(b) - price(a));
  else if (sort === 'promo') items.sort((a, b) => onSale(b) - onSale(a));
  else if (sort === 'unit') {
    const u = (p) => { const x = unitOf(p); return x ? price(p) / x.q : Infinity; };
    items = items.map((p) => ({ p, u: u(p) })).sort((a, b) => a.u - b.u).map((x) => x.p);
  }
  return items;
}
function renderSearch() {
  const items = searchItems();
  $('#searchCount').textContent = `${items.length.toLocaleString('es-AR')} productos ${S.kind === 'minorista' ? 'minoristas' : `mayoristas · ${title(srcOf(S.branch)?.name || '')}`}`;
  $('#searchList').innerHTML = listHtml(items, (p) => {
    const x = unitOf(p);
    return productCard(p, { extra: x ? `<div class="meta">${ars((p.e ?? p.p) / x.q)} por ${x.u}</div>` : '' });
  }, 'buscar');
}

function sourceBox(s) {
  const st = S.status?.sources?.[s.id];
  const head = s.kind === 'minorista' ? '🛒 Minorista · carrefour.com.ar' : `🏪 Mayorista · Maxi ${esc(title(s.name))}`;
  if (!st) return `<div class="box"><h3>${head}</h3><div class="meta">Sin datos todavía.</div></div>`;
  return `<div class="box"><h3>${head}</h3><dl class="kv">
    <dt>Estado</dt><dd>${st.ok ? '✅ Funcionando' : '❌ Con errores'}</dd>
    <dt>Última lectura OK</dt><dd>${st.lastSuccess ? `${fmtDate(st.lastSuccess)} (${ago(st.lastSuccess)})` : '—'}</dd>
    <dt>Productos</dt><dd>${(st.products || 0).toLocaleString('es-AR')}</dd>
    ${st.cookieVar ? `<dt>Cookie</dt><dd>${esc(st.cookieVar)}</dd>` : ''}
    ${st.lastError ? `<dt>Último error</dt><dd class="neg">${esc(st.lastError)}</dd>` : ''}
    ${(st.warnings || []).length ? `<dt>Avisos</dt><dd>${st.warnings.map(esc).join('<br>')}</dd>` : ''}
  </dl></div>`;
}

function renderStatus() {
  const s = S.status;
  if (!s) { $('#statusBox').innerHTML = '<div class="empty">Sin datos todavía. El monitor no corrió nunca o falta configurarlo.</div>'; return; }
  const ch = s.channels || {};
  const chans = Object.entries(ch).filter(([, v]) => v).map(([k]) => k).join(', ') || 'ninguno (sólo web)';
  const cookies = (s.cookies || []).map((c) => `<tr><td>${esc(c.var)}</td><td>${c.ok ? '✅' : '❌'}</td><td>${esc(c.branch ? title(c.branch) : '—')}</td><td class="meta">${esc(c.ok ? '' : (c.error || '').slice(0, 120))}</td></tr>`).join('');
  const names = Object.fromEntries(S.manifest.map((m) => [m.id, m.kind === 'minorista' ? '🛒' : title(m.name)]));
  const runs = (s.runs || []).slice(0, 48).map((r) => {
    const cells = Object.entries(r.results || {}).map(([id, x]) => `${names[id] || id}: ${x.ok ? `✅${x.alerts ? ` ${x.alerts}` : ''}` : '❌'}`).join(' · ');
    return `<tr><td>${fmtDate(r.at)}</td><td>${cells}</td><td>${r.opp ? r.opp.total : ''}</td><td>${r.ms ? (r.ms / 1000).toFixed(0) + ' s' : ''}</td></tr>`;
  }).join('');
  $('#statusBox').innerHTML = `
    <div class="status-grid">${S.manifest.map(sourceBox).join('')}</div>
    <div class="box"><h3>Cookies de sesión (una por sucursal)</h3><div class="table-wrap"><table>
      <thead><tr><th>Secret</th><th></th><th>Sucursal</th><th></th></tr></thead><tbody>${cookies || '<tr><td colspan="4">—</td></tr>'}</tbody></table></div></div>
    <div class="box"><dl class="kv">
      <dt>Frecuencia</dt><dd>cada ${s.intervalMinutes || 30} min</dd>
      <dt>Último intento</dt><dd>${s.lastRun ? `${fmtDate(s.lastRun)} (${ago(s.lastRun)})` : '—'}</dd>
      <dt>Avisos push</dt><dd>${esc(chans)}</dd>
      <dt>Oportunidades</dt><dd>${s.opportunities ? `${s.opportunities.total} (${s.opportunities.strong} fuertes)` : '—'}</dd>
    </dl></div>
    <div class="box"><h3>Últimas corridas</h3><div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>Resultado</th><th>Oport.</th><th>Dur.</th></tr></thead>
      <tbody>${runs}</tbody></table></div></div>`;
}

function updateStatusPill() {
  const id = curId();
  const s = S.status?.sources?.[id];
  const pill = $('#statusPill');
  pill.classList.remove('ok', 'warn', 'bad');
  const banner = $('#banner');
  const msgs = [];
  if (!s?.lastSuccess) {
    pill.classList.add('bad');
    $('#statusText').textContent = 'Sin datos';
    if (s?.lastError) msgs.push(`⚠️ ${s.lastError}`);
  } else {
    const mins = (Date.now() - Date.parse(s.lastSuccess)) / 60000;
    const interval = S.status.intervalMinutes || 30;
    pill.classList.add(!s.ok || mins > interval * 6 ? 'bad' : mins > interval * 2.5 ? 'warn' : 'ok');
    $('#statusText').textContent = ago(s.lastSuccess);
    if (!s.ok && s.lastError) msgs.push(`⚠️ La última lectura falló (se muestran datos de ${ago(s.lastSuccess)}): ${s.lastError}`);
    else if (mins > interval * 2.5) msgs.push(`⚠️ Los precios no se actualizan desde ${ago(s.lastSuccess)}.`);
    for (const w of s.warnings || []) if (/primera lectura|primera corrida/i.test(w)) msgs.push(`ℹ️ ${w}`);
  }
  if (S.kind === 'mayorista' && !mayList().length) msgs.push('⚠️ Mayorista sin datos: falta cargar la cookie (secret CF_COOKIE). Mientras tanto podés usar 🛒 Minorista.');
  for (const c of S.status?.cookies || []) if (!c.ok && S.kind === 'mayorista') msgs.push(`⚠️ ${c.var}${c.branch ? ` (${title(c.branch)})` : ''}: ${c.error}`);
  banner.hidden = !msgs.length;
  banner.innerHTML = [...new Set(msgs)].map(esc).join('<br>');
  const n = s?.products ? ` · ${s.products.toLocaleString('es-AR')} productos` : '';
  $('#branch').textContent = S.kind === 'mayorista' ? `Mayorista · Maxi ${title(srcOf(S.branch)?.name || '')}${n}` : `Minorista · carrefour.com.ar${n}`;
}

// ---------- detalle ----------
function chartSvg(series, retail) {
  const now = Date.now() / 60000;
  if (!series?.length) return '<div class="meta">Sin historial todavía.</div>';
  const pts = series.map((p) => [p[0], p[1]]);
  pts.push([now, pts[pts.length - 1][1]]);
  const W = 600, H = 180, L = 52, R = 10, T = 12, B = 24;
  const x0 = pts[0][0], x1 = Math.max(now, x0 + 60);
  const vals = pts.map((p) => p[1]).concat(retail ? [retail] : []);
  let y0 = Math.min(...vals), y1 = Math.max(...vals);
  if (y0 === y1) { y0 *= 0.9; y1 *= 1.1; }
  const pad = (y1 - y0) * 0.12; y0 -= pad; y1 += pad;
  const X = (t) => L + ((t - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  let d = `M${X(pts[0][0]).toFixed(1)},${Y(pts[0][1]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${X(pts[i][0]).toFixed(1)} V${Y(pts[i][1]).toFixed(1)}`;
  const area = `${d} V${H - B} H${X(pts[0][0]).toFixed(1)} Z`;
  const ticks = [y0 + pad, (y0 + y1) / 2, y1 - pad].map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${ars(v)}</text>`).join('');
  const dl = (t) => new Date(t * 60000).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
  const retailLine = retail ? `<line class="retail" x1="${L}" x2="${W - R}" y1="${Y(retail)}" y2="${Y(retail)}"/><text x="${W - R}" y="${Y(retail) - 4}" text-anchor="end">minorista ${ars(retail)}</text>` : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Historial de precio">
    ${ticks}<path class="area" d="${area}"/><path class="line" d="${d}"/>${retailLine}
    <text x="${L}" y="${H - 6}">${dl(x0)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">hoy</text></svg>`;
}

let detailCtx = null;
async function openDetail(ean, id = curId()) {
  if (!srcOf(id)) return;
  const d = dataOf(id);
  if (!d.loaded) await loadSource(id);
  const p = d.byEan.get(ean);
  const a0 = d.alerts.find((a) => a.ean === ean) || (S.opp?.items || []).find((o) => o.ean === ean && o.sourceId === id);
  if (!p && !a0) return;
  const dlg = $('#detail');
  const base = p || { ean, n: a0.name, c: a0.category, s: a0.sector, e: a0.price, p: a0.basePrice || a0.price, lp: a0.listPrice, u: a0.url, im: a0.image, sl: a0.seller };
  const isMay = kindOf(id) === 'mayorista';
  detailCtx = { ean, id, base };
  const render = () => {
    const series = d.history?.[ean] || [];
    const r = isMay ? S.retail?.[ean] : null;
    const price = base.e ?? base.p;
    const vals = series.map((x) => x[1]);
    const ref = series.length ? refPrice(series) : null;
    const q = unitOf(base);
    const alerts = d.alerts.filter((a) => a.ean === ean).slice(0, 10);
    const opp = (S.opp?.items || []).find((o) => o.ean === ean && o.sourceId === id);
    // Mismo producto en las otras fuentes (sólo referencia, sin mezclar datos)
    const rows = S.manifest.map((s) => {
      const x = dataOf(s.id).byEan.get(s.kind === 'minorista' && !isMay ? ean : ean);
      const xp = x ? x.e ?? x.p : null;
      return { s, xp, me: s.id === id };
    }).filter((r2) => r2.xp);
    const compare = rows.length > 1 ? `<table class="compare"><tbody>${rows.map(({ s, xp, me }) => `<tr class="${me ? 'me' : ''}"><td>${s.kind === 'minorista' ? '🛒 carrefour.com.ar' : `🏪 Maxi ${esc(title(s.name))}`}</td><td>${ars(xp)}</td><td>${me ? '' : `<span class="${xp > price ? 'pos' : 'neg'}">${xp > price ? '+' : ''}${pct(xp / price - 1)}</span>`}</td></tr>`).join('')}</tbody></table>` : '';
    $('#detailBody').innerHTML = `
      <div class="detail-head">
        <img src="${esc(imgOf(base, id))}" onerror="this.onerror=null;this.src='${NOIMG}'" alt="">
        <div>
          <div class="meta">${srcBadge(id)}${esc([base.s, base.c].filter(Boolean).join(' › '))}</div>
          <h2>${esc(base.n)}</h2>
          <div><span class="price">${ars(price)}</span>${base.pp && base.p > base.pp ? `<span class="was">${ars(base.p)}</span>` : base.lp && base.lp > price ? `<span class="was">${ars(base.lp)}</span>` : ''}</div>
          ${base.q ? `<div class="meta">Compra mínima ${base.q} u.${base.pk ? ` · bulto de ${base.pk}` : ''}</div>` : ''}
          ${base.pr ? `<span class="pill promo">${esc(base.pr)}</span>` : ''}
          ${base.sl ? `<div class="meta">Vendido por ${esc(base.sl)}</div>` : ''}
        </div>
      </div>
      ${opp ? `<div style="margin-top:10px">${Object.entries(opp.signals).map(([k, v]) => `<span class="sig ${k}">${SIG_LABEL[k] || k} ${k === 'reventa' ? '+' : '-'}${pct(v)}</span>`).join('')}<ul class="reasons">${opp.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      <div class="stats">
        <div class="stat"><div class="k">Precio habitual (30 d)</div><div class="v">${ars(ref)}</div></div>
        <div class="stat"><div class="k">Mínimo registrado</div><div class="v">${ars(vals.length ? Math.min(...vals) : null)}</div></div>
        <div class="stat"><div class="k">Máximo registrado</div><div class="v">${ars(vals.length ? Math.max(...vals) : null)}</div></div>
        ${isMay && r?.price && price ? `<div class="stat"><div class="k">Margen reventa</div><div class="v ${r.price > price ? 'pos' : 'neg'}">${pct(r.price / price - 1)}</div></div>` : ''}
        ${base.lp && base.lp > price ? `<div class="stat"><div class="k">Descuento vs ${isMay ? 'anterior' : 'lista'}</div><div class="v pos">${pct(1 - price / base.lp)}</div></div>` : ''}
        ${q && price ? `<div class="stat"><div class="k">Precio por ${q.u}</div><div class="v">${ars(price / q.q)}</div></div>` : ''}
      </div>
      ${compare ? `<h3 style="font-size:14px;margin:6px 0 0">Comparación</h3>${compare}` : ''}
      <h3 style="font-size:14px;margin:14px 0 4px">Historial de precio</h3>
      ${chartSvg(series, r?.price)}
      ${alerts.length ? `<h3 style="font-size:14px;margin:14px 0 6px">Alertas</h3><ul class="reasons">${alerts.map((a) => `<li><b>${TYPE_LABEL[a.type] || a.type}</b> · ${fmtDate(a.ts)} · ${ars(a.price)} — ${esc((a.reasons || [])[0] || '')}</li>`).join('')}</ul>` : ''}
      <div class="links">
        <a class="btn" href="${esc(linkOf(base, id))}" target="_blank" rel="noopener">${isMay ? 'Ver en Carrefour Maxi' : 'Ver en carrefour.com.ar'}</a>
        ${r?.url ? `<a class="btn ghost" href="${esc(r.url)}" target="_blank" rel="noopener">Ver minorista</a>` : ''}
        <button class="btn ghost" type="button" id="dlProduct">⬇️ Historial (CSV)</button>
        ${/^\d+$/.test(ean) ? `<span class="meta" style="align-self:center">EAN ${ean}</span>` : ''}
      </div>`;
  };
  render();
  if (!dlg.open) dlg.showModal();
  const hash = `#src=${encodeURIComponent(id)}&p=${encodeURIComponent(ean)}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  await Promise.all([ensureHistory(id), isMay ? ensureRetail() : null, ensureAllProducts()]);
  if (dlg.open && detailCtx?.ean === ean) render();
}

function downloadProductCsv() {
  if (!detailCtx) return;
  const { ean, id, base } = detailCtx;
  const series = dataOf(id).history?.[ean] || [];
  const s = srcOf(id);
  const rows = historyRows(series, base.e ?? base.p).map((r) => [ean, base.n, s.kind, s.name, ...r]);
  downloadCsv(`historial-${srcFileTag(id)}-${ean}-${today()}.csv`, ['EAN', 'Producto', 'Fuente', 'Sucursal', 'Desde', 'Hasta', 'Precio', 'Precio sin promo'], rows);
}

async function downloadListCsv() {
  const id = curId();
  const isMay = kindOf(id) === 'mayorista';
  const retail = isMay ? await ensureRetail() : {};
  const rows = searchItems().map((p) => {
    const price = p.e ?? p.p;
    const x = unitOf(p);
    const r = retail[p.ean];
    return [p.ean, p.n, p.s, p.c, csvNum(price), csvNum(p.lp && p.lp > price ? p.lp : ''), p.pr || '', p.q || '', p.pk || '', x ? csvNum(price / x.q) : '', x ? x.u : '', isMay && r?.price ? csvNum(r.price) : '', isMay && r?.price ? csvNum((r.price / price - 1) * 100) : '', unseen(p) ? 'no visto' : '', p.l ? fmtDateFull(p.l) : ''];
  });
  downloadCsv(`precios-${srcFileTag(id)}-${today()}.csv`, ['EAN', 'Producto', 'Sección', 'Categoría', 'Precio', 'Precio anterior/lista', 'Promo', 'Compra mínima', 'Bulto', 'Precio por unidad', 'Unidad', 'Precio minorista', 'Margen %', 'Estado', 'Visto'], rows);
}

async function downloadHistoryCsv() {
  const id = curId();
  const btn = $('#dlHistory');
  btn.disabled = true;
  btn.textContent = 'Preparando…';
  try {
    const history = await ensureHistory(id);
    const rows = [];
    for (const p of D().products) {
      for (const r of historyRows(history[p.ean] || [], p.e ?? p.p)) rows.push([p.ean, p.n, p.c, ...r]);
    }
    downloadCsv(`historial-${srcFileTag(id)}-${today()}.csv`, ['EAN', 'Producto', 'Categoría', 'Desde', 'Hasta', 'Precio', 'Precio sin promo'], rows);
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇️ Historial completo (CSV)';
  }
}

function downloadOppCsv() {
  const rows = oppItems().map((o) => [o.kind, o.branch || '', o.ean, o.name, o.category, csvNum(o.price), csvNum(o.listPrice || ''), ...['descuento', 'sucursal', 'reventa', 'bajoMayorista', 'kilo'].map((k) => (o.signals?.[k] !== undefined ? csvNum(o.signals[k] * 100) : '')), (o.reasons || []).join(' | ')]);
  downloadCsv(`oportunidades-${S.kind}-${today()}.csv`, ['Fuente', 'Sucursal', 'EAN', 'Producto', 'Categoría', 'Precio', 'Precio anterior/lista', 'Descuento %', 'Vs sucursales %', 'Margen reventa %', 'Vs Maxi %', 'Kg vs categoría %', 'Motivos'], rows);
}

function closeDetail() {
  $('#detail').close();
  detailCtx = null;
  if (/^#(p|may|min|src)=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
}

// ---------- navegación ----------
function setTab(tab) {
  if (tab === 'reventa' && S.kind !== 'mayorista') tab = 'oportunidades';
  S.tab = tab;
  store.set('tab', tab);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
  renderTab();
  window.scrollTo({ top: 0 });
}
function renderTab() {
  ({ oportunidades: renderOpp, alertas: renderAlerts, reventa: renderResale, bajas: renderDrops, buscar: renderSearch, estado: renderStatus })[S.tab]?.();
}

function resetFilterChips() {
  if (S.kind !== 'mayorista' && S.alertType === 'reventa') S.alertType = '';
  if ((S.kind !== 'mayorista' && ['sucursal', 'reventa'].includes(S.oppSig)) || (S.kind !== 'minorista' && S.oppSig === 'bajoMayorista')) S.oppSig = '';
  document.querySelectorAll('#typeChips .chip').forEach((x) => x.classList.toggle('active', x.dataset.type === S.alertType));
  document.querySelectorAll('#oppChips .chip').forEach((x) => x.classList.toggle('active', x.dataset.sig === S.oppSig));
}

async function setView(kind, branch = S.branch) {
  S.kind = kind === 'minorista' ? 'minorista' : 'mayorista';
  if (branch && srcOf(branch)) S.branch = branch;
  store.set('source', S.kind);
  if (S.branch) store.set('branch', S.branch);
  document.body.dataset.source = S.kind;
  document.querySelectorAll('.sources button').forEach((b) => {
    const on = b.dataset.source === S.kind;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  Object.keys(S.limits).forEach((k) => (S.limits[k] = PAGE));
  resetFilterChips();
  if (curId() && !D().loaded) await loadSource(curId());
  renderBranches();
  fillSectors();
  updateStatusPill();
  setTab(S.tab);
}

function fillSectors() {
  const sectors = [...new Set(D().products.map((p) => p.s).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  for (const id of ['#resaleSector', '#dropSector', '#searchSector']) {
    const sel = $(id);
    const cur = sel.value;
    sel.innerHTML = '<option value="">Todas las secciones</option>' + sectors.map((s) => `<option>${esc(s)}</option>`).join('');
    sel.value = sectors.includes(cur) ? cur : '';
  }
}

function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function routeHash() {
  const h = location.hash.slice(1);
  if (!h) return;
  const qs = new URLSearchParams(h.replace(/^(may|min|p)=/, (m, k) => `legacy=${k}&p=`));
  let id = qs.get('src');
  const ean = qs.get('p');
  if (!ean) return;
  if (!id) id = qs.get('legacy') === 'min' ? minSrc()?.id : mayList()[0]?.id;
  if (!srcOf(id)) return;
  const k = kindOf(id);
  if (k !== S.kind || (k === 'mayorista' && id !== S.branch)) await setView(k, k === 'mayorista' ? id : S.branch);
  openDetail(ean, id);
}

function bind() {
  document.querySelectorAll('.tabs [data-tab], #statusPill').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  document.querySelectorAll('.sources [data-source]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.source)));
  $('#branches').addEventListener('click', (e) => {
    const b = e.target.closest('[data-branch]');
    if (b) setView('mayorista', b.dataset.branch);
  });
  $('#typeChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    S.alertType = c.dataset.type;
    resetFilterChips();
    S.limits.alertas = PAGE;
    renderAlerts();
  });
  $('#oppChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    S.oppSig = c.dataset.sig;
    resetFilterChips();
    S.limits.oportunidades = PAGE;
    renderOpp();
  });
  const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);
  on('#oppSearch', 'input', debounce(renderOpp));
  on('#oppScope', 'change', renderOpp);
  on('#alertSearch', 'input', debounce(renderAlerts));
  on('#alertRange', 'change', renderAlerts);
  on('#marginMin', 'input', debounce(renderResale, 120));
  on('#resaleSearch', 'input', debounce(renderResale));
  on('#resaleSector', 'change', renderResale);
  on('#dropWindow', 'change', renderDrops);
  on('#dropSector', 'change', renderDrops);
  on('#q', 'input', debounce(() => { S.limits.buscar = PAGE; renderSearch(); }));
  on('#searchSector', 'change', renderSearch);
  on('#searchSort', 'change', renderSearch);
  on('#dlList', 'click', downloadListCsv);
  on('#dlHistory', 'click', downloadHistoryCsv);
  on('#dlOpp', 'click', downloadOppCsv);
  document.addEventListener('click', (e) => {
    if (e.target.closest('#dlProduct')) { downloadProductCsv(); return; }
    const more = e.target.closest('[data-more]');
    if (more) { S.limits[more.dataset.more] += PAGE * 2; renderTab(); return; }
    const card = e.target.closest('.card[data-ean]');
    if (card) openDetail(card.dataset.ean, card.dataset.src || curId());
  });
  on('#closeDetail', 'click', closeDetail);
  $('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') closeDetail(); });
  $('#detail').addEventListener('close', () => { if (/^#(p|may|min|src)=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search); });
  window.addEventListener('hashchange', routeHash);
}

(async function init() {
  bind();
  await loadAll();
  let kind = store.get('source', '');
  if (!['mayorista', 'minorista'].includes(kind)) kind = mayList().length ? 'mayorista' : 'minorista';
  if (kind === 'mayorista' && !mayList().length && minSrc()) kind = 'minorista';
  const tab = store.get('tab', 'oportunidades');
  S.tab = document.getElementById(`tab-${tab}`) ? tab : 'oportunidades';
  await setView(kind);
  routeHash();
  // refresco automático cada 5 minutos
  setInterval(async () => {
    S.retail = null;
    await loadAll();
    fillSectors();
    updateStatusPill();
    renderTab();
  }, 5 * 60e3);
  setInterval(updateStatusPill, 60e3);
})();
