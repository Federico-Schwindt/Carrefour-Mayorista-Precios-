// Radar Maxi — dashboard estático. Lee los JSON de ./data/ que genera el monitor.
// Dos fuentes SEPARADAS: 🏪 mayorista (Carrefour Maxi) y 🛒 minorista (carrefour.com.ar).
const DATA = './data/';
const PAGE = 60;
const TYPE_LABEL = { error: '🚨 Posible error', reventa: '💰 Reventa', baja: '📉 Baja fuerte', minimo: '🏆 Mínimo histórico' };
const MAXI = 'https://comerciante.carrefour.com.ar/';
const SRC = {
  mayorista: { short: 'may', tag: 'MAYORISTA', name: 'Carrefour Maxi', files: { products: 'products.json', alerts: 'alerts.json', history: 'history.json' } },
  minorista: { short: 'min', tag: 'MINORISTA', name: 'carrefour.com.ar', files: { products: 'min-products.json', alerts: 'min-alerts.json', history: 'min-history.json' } },
};

const blank = () => ({ products: [], byEan: new Map(), alerts: [], history: null, loaded: false, updatedAt: null });
const S = {
  source: 'mayorista',
  data: { mayorista: blank(), minorista: blank() },
  status: null,
  retail: null,
  tab: 'alertas',
  alertType: '',
  limits: { alertas: PAGE, reventa: PAGE, bajas: PAGE, buscar: PAGE },
};
const D = () => S.data[S.source];

// ---------- utilidades ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ars = (n) => (n || n === 0 ? '$' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: Number(n) < 100 ? 2 : 0 }) : '—');
const pct = (x) => `${Math.round(x * 100)}%`;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const NOIMG = 'https://tupedido.carrefour.com.ar/imagenesPDA/noimage-svg.svg';
const fullImg = (x) => (!x ? null : /^https?:/.test(x) ? x : `https://carrefourar.vteximg.com.br/arquivos/ids/${x}`);
const fullUrl = (x) => (!x ? null : /^https?:/.test(x) ? x : `https://www.carrefour.com.ar/${x}/p`);
const imgOf = (p, src = S.source) => fullImg(p.im || p.image) || (src === 'mayorista' && /^\d+$/.test(p.ean) ? `https://tupedido.carrefour.com.ar/imagenesPDA/${p.ean}.jpg` : NOIMG);
const linkOf = (p, src = S.source) => (src === 'minorista' ? fullUrl(p.u || p.url) || 'https://www.carrefour.com.ar/' : `${MAXI}p/${p.ean}`);
// Producto que no apareció en la última lectura (sin stock o dado de baja)
const unseen = (p) => p.l && D().updatedAt && Date.parse(p.l) < Date.parse(D().updatedAt) - 3600e3;
const srcBadge = (src = S.source) => `<span class="src ${SRC[src].short}">${SRC[src].tag}</span>`;
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

async function getJson(name) {
  const r = await fetch(`${DATA}${name}?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
}

// Unidad (kg/l/u) desde la descripción — misma lógica que el monitor
function parseQty(desc) {
  const d = ` ${String(desc || '').toLowerCase().replace(/,/g, '.')} `;
  const U = '(kgs?|kilos?|k|grs?|grm|gramos?|g|ml|cc|cm3|lts?|litros?|l)';
  const n2 = (n, u) => (/^(kgs?|kilos?|k)$/.test(u) ? { q: n, u: 'kg' } : /^(grs?|grm|gramos?|g)$/.test(u) ? { q: n / 1000, u: 'kg' } : /^(ml|cc|cm3)$/.test(u) ? { q: n / 1000, u: 'l' } : { q: n, u: 'l' });
  let m = d.match(new RegExp(`(?<![\\w.])(\\d+)\\s*(?:u\\.?|un\\.?|unid\\.?|unidades)?\\s*x\\s*(\\d+(?:\\.\\d+)?)\\s*${U}\\b`));
  if (m && +m[1] > 1 && +m[1] <= 200) { const b = n2(+m[2], m[3]); return { q: b.q * +m[1], u: b.u }; }
  const all = [...d.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${U}(?![a-z])`, 'g'))];
  if (all.length) { const l = all[all.length - 1]; const r = n2(+l[1], l[2]); if (r.q > 0) return r; }
  m = d.match(/(?:x\s*)?(?<![\w.])(\d+)\s*(?:u|un|uni|unid|unidades|rollos|saquitos|sobres)\b/);
  return m && +m[1] > 0 ? { q: +m[1], u: 'u' } : null;
}
const NON_UNIT = /electro|tecnolog|hogar|indumentaria|jugueter|librer|automotor|aire libre/i;
const unitOf = (p) => (NON_UNIT.test(p.s || '') ? null : parseQty(p.n));

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

// ---------- tarjetas ----------
function productCard(p, { right = '', extra = '' } = {}) {
  const src = S.source;
  const promo = p.pp ? `<span class="pill promo">${p.q ? `Llevando ${p.q}+` : 'Promo'}</span>` : p.o ? '<span class="pill promo">Oferta</span>' : '';
  const was = p.pp && p.p > p.pp ? p.p : p.lp && p.lp > (p.e ?? p.p) ? p.lp : null;
  return `<button class="card ${SRC[src].short}" data-ean="${esc(p.ean)}">
    <img loading="lazy" src="${esc(imgOf(p))}" onerror="this.onerror=null;this.src='${NOIMG}'" alt="">
    <div>
      <div class="meta">${srcBadge(src)}${esc(p.c || p.sc || '')}</div>
      <div class="name">${esc(p.n)}</div>
      <div><span class="price">${ars(p.e ?? p.p)}</span>${was ? `<span class="was">${ars(was)}</span>` : ''} ${right}</div>
      <div style="margin-top:4px">${unseen(p) ? `<span class="pill">no visto desde ${ago(p.l)}</span>` : ''}${promo}${p.sl ? `<span class="meta">Vende: ${esc(p.sl)}</span>` : ''}${extra}</div>
    </div>
  </button>`;
}

function alertCard(a) {
  const src = a.source || S.source;
  const types = (a.types || [a.type]).map((t) => `<span class="pill ${t}">${TYPE_LABEL[t] || t}</span>`).join('');
  const was = a.prev && a.prev > a.price ? `<span class="was">${ars(a.prev)}</span> <span class="neg">-${pct(a.dropPct || 1 - a.price / a.prev)}</span>` : '';
  const retail = a.retail ? `<div class="meta">Minorista ${ars(a.retail)}${a.margin != null ? ` · margen <span class="pos">${pct(a.margin)}</span>` : ''}</div>` : '';
  return `<button class="card ${SRC[src].short}" data-ean="${esc(a.ean)}">
    <img loading="lazy" src="${esc(imgOf(a, src))}" onerror="this.onerror=null;this.src='${NOIMG}'" alt="">
    <div>
      <div>${srcBadge(src)}${types}${a.suppressed ? '<span class="pill">no notificada</span>' : ''}</div>
      <div class="name">${esc(a.name)}</div>
      <div><span class="price">${ars(a.price)}</span>${was}</div>
      ${retail}${a.seller ? `<div class="meta">Vende: ${esc(a.seller)}</div>` : ''}
      <ul class="reasons">${(a.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <div class="meta" style="margin-top:4px">${esc(a.category || '')} · ${ago(a.ts)}${a.notified ? ' · 🔔 avisada' : ''}</div>
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
  const day = (src) => S.data[src].alerts.filter((a) => Date.parse(a.ts) > Date.now() - 864e5).length;
  $('#badgeMay').textContent = day('mayorista') || '';
  $('#badgeMin').textContent = day('minorista') || '';
}

async function renderResale() {
  if (S.source !== 'mayorista') return setTab('alertas');
  if (!S.retail) {
    $('#resaleList').innerHTML = '<div class="empty">Cargando precios minoristas…</div>';
    try { S.retail = await getJson('retail.json'); } catch { S.retail = {}; }
  }
  const min = Number($('#marginMin').value) / 100;
  $('#marginVal').textContent = pct(min);
  const q = norm($('#resaleSearch').value);
  const sector = $('#resaleSector').value;
  const items = [];
  for (const p of D().products) {
    const r = S.retail[p.ean];
    const price = p.e ?? p.p;
    if (!r?.price || !price || r.available === false) continue;
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

async function ensureHistory(src = S.source) {
  const d = S.data[src];
  if (!d.history) { try { d.history = await getJson(SRC[src].files.history); } catch { d.history = {}; } }
  return d.history;
}

async function renderDrops() {
  if (!D().history) $('#dropList').innerHTML = '<div class="empty">Cargando historial…</div>';
  const src = S.source;
  const history = await ensureHistory(src);
  if (src !== S.source) return;
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
  $('#dropList').innerHTML = items.length || Object.keys(history).length
    ? listHtml(items, ({ p, old, drop }) => productCard(p, { right: `<span class="neg">-${pct(drop)}</span>`, extra: `<div class="meta">Antes ${ars(old)}</div>` }), 'bajas')
    : '<div class="empty">Todavía no hay historial suficiente.</div>';
}

function renderSearch() {
  const q = norm($('#q').value);
  const sector = $('#searchSector').value;
  const sort = $('#searchSort').value;
  let items = D().products.filter((p) => (!sector || p.s === sector) && (!q || norm(`${p.n} ${p.ean} ${p.c} ${p.b || ''}`).includes(q)));
  const price = (p) => p.e ?? p.p ?? Infinity;
  const onSale = (p) => (p.pp || p.o || (p.lp && p.lp > price(p)) ? 1 : 0);
  if (sort === 'priceAsc') items.sort((a, b) => price(a) - price(b));
  else if (sort === 'priceDesc') items.sort((a, b) => price(b) - price(a));
  else if (sort === 'promo') items.sort((a, b) => onSale(b) - onSale(a));
  else if (sort === 'unit') {
    const u = (p) => { const x = unitOf(p); return x ? price(p) / x.q : Infinity; };
    items = items.map((p) => ({ p, u: u(p) })).sort((a, b) => a.u - b.u).map((x) => x.p);
  }
  $('#searchCount').textContent = `${items.length.toLocaleString('es-AR')} productos ${SRC[S.source].tag.toLowerCase()}s`;
  $('#searchList').innerHTML = listHtml(items, (p) => {
    const x = unitOf(p);
    return productCard(p, { extra: x ? `<div class="meta">${ars((p.e ?? p.p) / x.q)} por ${x.u}</div>` : '' });
  }, 'buscar');
}

function sourceBox(key) {
  const s = S.status?.sources?.[key];
  const title = key === 'mayorista' ? '🏪 Mayorista · Carrefour Maxi' : '🛒 Minorista · carrefour.com.ar';
  if (!s) return `<div class="box"><h3>${title}</h3><div class="meta">Sin datos todavía.</div></div>`;
  return `<div class="box"><h3>${title}</h3><dl class="kv">
    <dt>Estado</dt><dd>${s.ok ? '✅ Funcionando' : '❌ Con errores'}</dd>
    <dt>Última lectura OK</dt><dd>${s.lastSuccess ? `${fmtDate(s.lastSuccess)} (${ago(s.lastSuccess)})` : '—'}</dd>
    <dt>Productos</dt><dd>${(s.products || 0).toLocaleString('es-AR')}</dd>
    ${key === 'mayorista' ? `<dt>Sucursal</dt><dd>${esc(s.region || '')} · ${esc(s.seller || '')}</dd><dt>Sesión</dt><dd>${esc(s.sessionSource || '—')}</dd>` : ''}
    ${s.lastError ? `<dt>Último error</dt><dd class="neg">${esc(s.lastError)}</dd>` : ''}
    ${(s.warnings || []).length ? `<dt>Avisos</dt><dd>${s.warnings.map(esc).join('<br>')}</dd>` : ''}
  </dl></div>`;
}

function renderStatus() {
  const s = S.status;
  if (!s) { $('#statusBox').innerHTML = '<div class="empty">Sin datos todavía. El monitor no corrió nunca o falta configurarlo.</div>'; return; }
  const ch = s.channels || {};
  const chans = Object.entries(ch).filter(([, v]) => v).map(([k]) => k).join(', ') || 'ninguno (sólo web)';
  const cell = (r) => (!r ? '—' : r.ok ? `✅ ${r.products ?? ''}${r.alerts ? ` · ${r.alerts} al.` : ''}` : `❌ <span class="meta">${esc((r.error || '').slice(0, 60))}</span>`);
  const runs = (s.runs || []).slice(0, 48).map((r) => `<tr><td>${fmtDate(r.at)}</td><td>${cell(r.mayorista)}</td><td>${cell(r.minorista)}</td><td>${r.ms ? (r.ms / 1000).toFixed(0) + ' s' : ''}</td></tr>`).join('');
  $('#statusBox').innerHTML = `
    <div class="status-grid">${sourceBox('mayorista')}${sourceBox('minorista')}</div>
    <div class="box"><dl class="kv">
      <dt>Frecuencia</dt><dd>cada ${s.intervalMinutes || 30} min</dd>
      <dt>Último intento</dt><dd>${s.lastRun ? `${fmtDate(s.lastRun)} (${ago(s.lastRun)})` : '—'}</dd>
      <dt>Avisos push</dt><dd>${esc(chans)}</dd>
    </dl></div>
    <div class="box"><h3>Últimas corridas</h3><div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>🏪 Mayorista</th><th>🛒 Minorista</th><th>Dur.</th></tr></thead>
      <tbody>${runs}</tbody></table></div></div>`;
}

function updateStatusPill() {
  const s = S.status?.sources?.[S.source];
  const pill = $('#statusPill');
  pill.classList.remove('ok', 'warn', 'bad');
  const banner = $('#banner');
  const msgs = [];
  if (!s?.lastSuccess) {
    pill.classList.add('bad');
    $('#statusText').textContent = 'Sin datos';
    if (s?.lastError) msgs.push(`⚠️ ${s.lastError}`);
    else if (S.source === 'mayorista') msgs.push('⚠️ Mayorista sin datos: falta cargar la sesión (CF_COOKIE). Mientras tanto podés usar 🛒 Minorista.');
  } else {
    const mins = (Date.now() - Date.parse(s.lastSuccess)) / 60000;
    const interval = S.status.intervalMinutes || 30;
    pill.classList.add(!s.ok || mins > interval * 6 ? 'bad' : mins > interval * 2.5 ? 'warn' : 'ok');
    $('#statusText').textContent = ago(s.lastSuccess);
    if (!s.ok && s.lastError) msgs.push(`⚠️ La última lectura falló: ${s.lastError}`);
    else if (mins > interval * 2.5) msgs.push(`⚠️ Los precios no se actualizan desde ${ago(s.lastSuccess)}.`);
    for (const w of s.warnings || []) if (/primera corrida/i.test(w)) msgs.push(`ℹ️ ${w}`);
  }
  banner.hidden = !msgs.length;
  banner.innerHTML = msgs.map(esc).join('<br>');
  const n = s?.products ? ` · ${s.products.toLocaleString('es-AR')} productos` : '';
  $('#branch').textContent = S.source === 'mayorista' ? `Mayorista · Carrefour Maxi${s?.region ? ` · ${s.region}` : ''}${n}` : `Minorista · carrefour.com.ar${n}`;
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

async function openDetail(ean, src = S.source) {
  const d = S.data[src];
  const p = d.byEan.get(ean);
  const a0 = d.alerts.find((a) => a.ean === ean);
  if (!p && !a0) return;
  const dlg = $('#detail');
  const base = p || { ean, n: a0.name, c: a0.category, s: a0.sector, e: a0.price, p: a0.basePrice, lp: a0.listPrice, u: a0.url, im: a0.image, sl: a0.seller };
  const isMay = src === 'mayorista';
  const render = () => {
    const series = d.history?.[ean] || [];
    const r = isMay ? S.retail?.[ean] : null;
    const price = base.e ?? base.p;
    const vals = series.map((x) => x[1]);
    const ref = series.length ? refPrice(series) : null;
    const q = unitOf(base);
    const alerts = d.alerts.filter((a) => a.ean === ean).slice(0, 10);
    // Mismo producto en la otra fuente (sólo como referencia, sin mezclar)
    const other = S.data[isMay ? 'minorista' : 'mayorista'].byEan.get(ean);
    $('#detailBody').innerHTML = `
      <div class="detail-head">
        <img src="${esc(imgOf(base, src))}" onerror="this.onerror=null;this.src='${NOIMG}'" alt="">
        <div>
          <div class="meta">${srcBadge(src)}${esc([base.s, base.c].filter(Boolean).join(' › '))}</div>
          <h2>${esc(base.n)}</h2>
          <div><span class="price">${ars(price)}</span>${base.pp && base.p > base.pp ? `<span class="was">${ars(base.p)}</span>` : base.lp && base.lp > price ? `<span class="was">${ars(base.lp)}</span>` : ''}</div>
          ${base.pp ? `<div class="meta">Precio llevando ${base.q || 'varias'} unidades · normal ${ars(base.p)}</div>` : ''}
          ${base.pr ? `<span class="pill promo">${esc(base.pr)}</span>` : ''}
          ${base.sl ? `<div class="meta">Vendido por ${esc(base.sl)}</div>` : ''}
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Precio habitual (30 d)</div><div class="v">${ars(ref)}</div></div>
        <div class="stat"><div class="k">Mínimo registrado</div><div class="v">${ars(vals.length ? Math.min(...vals) : null)}</div></div>
        <div class="stat"><div class="k">Máximo registrado</div><div class="v">${ars(vals.length ? Math.max(...vals) : null)}</div></div>
        ${isMay ? `<div class="stat"><div class="k">Minorista</div><div class="v">${r?.price ? ars(r.price) : r?.found === false ? 'no está' : '—'}</div></div>` : ''}
        ${isMay && r?.price && price ? `<div class="stat"><div class="k">Margen reventa</div><div class="v ${r.price > price ? 'pos' : 'neg'}">${pct(r.price / price - 1)}</div></div>` : ''}
        ${!isMay && base.lp && base.lp > price ? `<div class="stat"><div class="k">Descuento vs lista</div><div class="v pos">${pct(1 - price / base.lp)}</div></div>` : ''}
        ${q && price ? `<div class="stat"><div class="k">Precio por ${q.u}</div><div class="v">${ars(price / q.q)}</div></div>` : ''}
        ${other ? `<div class="stat"><div class="k">En ${isMay ? '🛒 minorista' : '🏪 mayorista'}</div><div class="v">${ars(other.e ?? other.p)}</div></div>` : ''}
      </div>
      ${chartSvg(series, r?.price)}
      ${alerts.length ? `<h3 style="font-size:14px;margin:14px 0 6px">Alertas</h3><ul class="reasons">${alerts.map((a) => `<li><b>${TYPE_LABEL[a.type] || a.type}</b> · ${fmtDate(a.ts)} · ${ars(a.price)} — ${esc((a.reasons || [])[0] || '')}</li>`).join('')}</ul>` : ''}
      <div class="links">
        <a class="btn" href="${esc(linkOf(base, src))}" target="_blank" rel="noopener">${isMay ? 'Ver en Carrefour Maxi' : 'Ver en carrefour.com.ar'}</a>
        ${r?.url ? `<a class="btn ghost" href="${esc(r.url)}" target="_blank" rel="noopener">Ver minorista</a>` : ''}
        ${/^\d+$/.test(ean) ? `<span class="meta" style="align-self:center">EAN ${ean}</span>` : ''}
      </div>`;
  };
  render();
  if (!dlg.open) dlg.showModal();
  const hash = `#${SRC[src].short}=${ean}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  const loads = [ensureHistory(src)];
  if (isMay && !S.retail) loads.push(getJson('retail.json').then((x) => (S.retail = x)).catch(() => (S.retail = {})));
  if (!S.data[isMay ? 'minorista' : 'mayorista'].loaded) loads.push(loadSource(isMay ? 'minorista' : 'mayorista'));
  await Promise.all(loads);
  if (dlg.open) render();
}

function closeDetail() {
  $('#detail').close();
  if (/^#(p|may|min)=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
}

// ---------- navegación ----------
function setTab(tab) {
  if (tab === 'reventa' && S.source !== 'mayorista') tab = 'alertas';
  S.tab = tab;
  store.set('tab', tab);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
  renderTab();
  window.scrollTo({ top: 0 });
}
function renderTab() {
  ({ alertas: renderAlerts, reventa: renderResale, bajas: renderDrops, buscar: renderSearch, estado: renderStatus })[S.tab]?.();
}

async function setSource(src) {
  if (!SRC[src]) return;
  S.source = src;
  store.set('source', src);
  document.body.dataset.source = src;
  document.querySelectorAll('.sources button').forEach((b) => {
    const on = b.dataset.source === src;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  Object.keys(S.limits).forEach((k) => (S.limits[k] = PAGE));
  if (src !== 'mayorista' && S.alertType === 'reventa') {
    S.alertType = '';
    document.querySelectorAll('#typeChips .chip').forEach((x) => x.classList.toggle('active', x.dataset.type === ''));
  }
  if (!D().loaded) {
    $('#alertList').innerHTML = '<div class="empty">Cargando…</div>';
    await loadSource(src);
  }
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

async function loadSource(src) {
  const f = SRC[src].files;
  const [products, alerts] = await Promise.allSettled([getJson(f.products), getJson(f.alerts)]);
  const d = S.data[src];
  d.products = products.value?.items || [];
  d.updatedAt = products.value?.updatedAt || null;
  d.byEan = new Map(d.products.map((p) => [p.ean, p]));
  d.alerts = (alerts.value?.alerts || []).map((a) => ({ ...a, source: a.source || src }));
  d.loaded = true;
  updateBadges();
}

async function loadAll() {
  try { S.status = await getJson('status.json'); } catch { S.status = null; }
  // compatibilidad con el formato viejo de status.json
  if (S.status && !S.status.sources) S.status.sources = { mayorista: S.status };
  await Promise.all([loadSource('mayorista'), loadSource('minorista')]);
}

function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function routeHash() {
  const m = location.hash.match(/^#(p|may|min)=([\w-]+)/);
  if (!m) return;
  const src = m[1] === 'min' ? 'minorista' : 'mayorista';
  if (src !== S.source) setSource(src).then(() => openDetail(m[2], src));
  else openDetail(m[2], src);
}

function bind() {
  document.querySelectorAll('.tabs [data-tab], #statusPill').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  document.querySelectorAll('.sources [data-source]').forEach((b) => b.addEventListener('click', () => setSource(b.dataset.source)));
  $('#typeChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    S.alertType = c.dataset.type;
    document.querySelectorAll('#typeChips .chip').forEach((x) => x.classList.toggle('active', x === c));
    S.limits.alertas = PAGE;
    renderAlerts();
  });
  const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);
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
  document.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { S.limits[more.dataset.more] += PAGE * 2; renderTab(); return; }
    const card = e.target.closest('.card[data-ean]');
    if (card) openDetail(card.dataset.ean, S.source);
  });
  on('#closeDetail', 'click', closeDetail);
  $('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') closeDetail(); });
  $('#detail').addEventListener('close', () => { if (/^#(p|may|min)=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search); });
  window.addEventListener('hashchange', routeHash);
}

(async function init() {
  bind();
  await loadAll();
  // Si el mayorista todavía no tiene datos y el minorista sí, arrancamos en minorista
  let src = store.get('source', '');
  if (!SRC[src]) src = !S.data.mayorista.products.length && S.data.minorista.products.length ? 'minorista' : 'mayorista';
  const tab = store.get('tab', 'alertas');
  S.tab = document.getElementById(`tab-${tab}`) ? tab : 'alertas';
  await setSource(src);
  routeHash();
  // refresco automático cada 5 minutos
  setInterval(async () => {
    for (const k of Object.keys(S.data)) S.data[k] = blank();
    S.retail = null;
    await loadAll();
    fillSectors();
    updateStatusPill();
    renderTab();
  }, 5 * 60e3);
  setInterval(updateStatusPill, 60e3);
})();
