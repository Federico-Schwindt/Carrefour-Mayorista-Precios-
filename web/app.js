// Radar Maxi — dashboard estático. Lee los JSON de ./data/ que genera el monitor.
const DATA = './data/';
const PAGE = 60;
const TYPE_LABEL = { error: '🚨 Posible error', reventa: '💰 Reventa', baja: '📉 Baja fuerte', minimo: '🏆 Mínimo histórico' };
const SITE = 'https://comerciante.carrefour.com.ar/';

const S = {
  status: null,
  products: [],
  byEan: new Map(),
  alerts: [],
  retail: null,
  history: null,
  tab: 'alertas',
  alertType: '',
  limits: { alertas: PAGE, reventa: PAGE, bajas: PAGE, buscar: PAGE },
};

// ---------- utilidades ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ars = (n) => (n || n === 0 ? '$' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: Number(n) < 100 ? 2 : 0 }) : '—');
const pct = (x) => `${Math.round(x * 100)}%`;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const img = (ean) => `https://tupedido.carrefour.com.ar/imagenesPDA/${ean}.jpg`;
const NOIMG = 'https://tupedido.carrefour.com.ar/imagenesPDA/noimage-svg.svg';
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
  const promo = p.pp ? `<span class="pill promo">${p.q ? `Llevando ${p.q}+` : 'Promo'}</span>` : p.o ? '<span class="pill promo">Oferta</span>' : '';
  return `<button class="card" data-ean="${p.ean}">
    <img loading="lazy" src="${img(p.ean)}" onerror="this.onerror=null;this.src='${NOIMG}'" alt="">
    <div>
      <div class="meta">${esc(p.c || p.sc || '')}</div>
      <div class="name">${esc(p.n)}</div>
      <div><span class="price">${ars(p.e ?? p.p)}</span>${p.pp && p.p > p.pp ? `<span class="was">${ars(p.p)}</span>` : p.lp ? `<span class="was">${ars(p.lp)}</span>` : ''} ${right}</div>
      <div style="margin-top:4px">${promo}${extra}</div>
    </div>
  </button>`;
}

function alertCard(a) {
  const types = (a.types || [a.type]).map((t) => `<span class="pill ${t}">${TYPE_LABEL[t] || t}</span>`).join('');
  const was = a.prev && a.prev > a.price ? `<span class="was">${ars(a.prev)}</span> <span class="neg">-${pct(a.dropPct || 1 - a.price / a.prev)}</span>` : '';
  const retail = a.retail ? `<div class="meta">Minorista ${ars(a.retail)}${a.margin != null ? ` · margen <span class="pos">${pct(a.margin)}</span>` : ''}</div>` : '';
  return `<button class="card" data-ean="${a.ean}">
    <img loading="lazy" src="${img(a.ean)}" onerror="this.onerror=null;this.src='${NOIMG}'" alt="">
    <div>
      <div>${types}${a.suppressed ? '<span class="pill">no notificada</span>' : ''}</div>
      <div class="name">${esc(a.name)}</div>
      <div><span class="price">${ars(a.price)}</span>${was}</div>
      ${retail}
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
  const items = S.alerts.filter((a) => {
    if (S.alertType && !(a.types || [a.type]).includes(S.alertType)) return false;
    if (since && Date.parse(a.ts) < since) return false;
    if (q && !norm(`${a.name} ${a.ean} ${a.category}`).includes(q)) return false;
    return true;
  });
  $('#alertList').innerHTML = listHtml(items, alertCard, 'alertas');
  const day = S.alerts.filter((a) => Date.parse(a.ts) > Date.now() - 864e5).length;
  $('#badgeAlerts').textContent = day ? String(day) : '';
}

async function renderResale() {
  if (!S.retail) {
    $('#resaleList').innerHTML = '<div class="empty">Cargando precios minoristas…</div>';
    try { S.retail = await getJson('retail.json'); } catch { S.retail = {}; }
  }
  const min = Number($('#marginMin').value) / 100;
  $('#marginVal').textContent = pct(min);
  const q = norm($('#resaleSearch').value);
  const sector = $('#resaleSector').value;
  const items = [];
  for (const p of S.products) {
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

async function renderDrops() {
  if (!S.history) {
    $('#dropList').innerHTML = '<div class="empty">Cargando historial…</div>';
    try { S.history = await getJson('history.json'); } catch { S.history = {}; }
  }
  const w = $('#dropWindow').value;
  const sector = $('#dropSector').value;
  const t = Date.now() / 60000 - (w === 'ref' ? 0 : Number(w) * 1440);
  const items = [];
  for (const p of S.products) {
    const s = S.history[p.ean];
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
  $('#dropList').innerHTML = items.length || Object.keys(S.history).length
    ? listHtml(items, ({ p, old, drop }) => productCard(p, { right: `<span class="neg">-${pct(drop)}</span>`, extra: `<div class="meta">Antes ${ars(old)}</div>` }), 'bajas')
    : '<div class="empty">Todavía no hay historial suficiente.</div>';
}

function renderSearch() {
  const q = norm($('#q').value);
  const sector = $('#searchSector').value;
  const sort = $('#searchSort').value;
  let items = S.products.filter((p) => (!sector || p.s === sector) && (!q || norm(`${p.n} ${p.ean} ${p.c}`).includes(q)));
  const price = (p) => p.e ?? p.p ?? Infinity;
  if (sort === 'priceAsc') items.sort((a, b) => price(a) - price(b));
  else if (sort === 'priceDesc') items.sort((a, b) => price(b) - price(a));
  else if (sort === 'promo') items.sort((a, b) => (b.pp || b.o ? 1 : 0) - (a.pp || a.o ? 1 : 0));
  else if (sort === 'unit') {
    const u = (p) => { const x = parseQty(p.n); return x ? price(p) / x.q : Infinity; };
    items = items.map((p) => ({ p, u: u(p) })).sort((a, b) => a.u - b.u).map((x) => x.p);
  }
  $('#searchCount').textContent = `${items.length.toLocaleString('es-AR')} productos`;
  $('#searchList').innerHTML = listHtml(items, (p) => {
    const x = parseQty(p.n);
    return productCard(p, { extra: x ? `<div class="meta">${ars((p.e ?? p.p) / x.q)} por ${x.u}</div>` : '' });
  }, 'buscar');
}

function renderStatus() {
  const s = S.status;
  if (!s) { $('#statusBox').innerHTML = '<div class="empty">Sin datos todavía. El monitor no corrió nunca o falta configurarlo.</div>'; return; }
  const ch = s.channels || {};
  const chans = Object.entries(ch).filter(([, v]) => v).map(([k]) => k).join(', ') || 'ninguno (sólo web)';
  const runs = (s.runs || []).slice(0, 48).map((r) => `<tr><td>${fmtDate(r.at)}</td><td>${r.ok ? '✅' : '❌'}</td><td>${r.products ?? '—'}</td><td>${r.changes ?? '—'}</td><td>${r.alerts ?? '—'}</td><td>${r.ms ? (r.ms / 1000).toFixed(0) + ' s' : ''}</td><td>${esc(r.error || (r.warnings || []).join(' | '))}</td></tr>`).join('');
  $('#statusBox').innerHTML = `
    <div class="box"><h3>Monitor</h3><dl class="kv">
      <dt>Estado</dt><dd>${s.ok ? '✅ Funcionando' : '❌ Con errores'}</dd>
      <dt>Última lectura OK</dt><dd>${s.lastSuccess ? `${fmtDate(s.lastSuccess)} (${ago(s.lastSuccess)})` : '—'}</dd>
      <dt>Último intento</dt><dd>${s.lastRun ? `${fmtDate(s.lastRun)} (${ago(s.lastRun)})` : '—'}</dd>
      <dt>Frecuencia</dt><dd>cada ${s.intervalMinutes || 30} min</dd>
      <dt>Productos</dt><dd>${(s.products || 0).toLocaleString('es-AR')}</dd>
      <dt>Sucursal</dt><dd>${esc(s.region || '')} · ${esc(s.seller || '')}</dd>
      <dt>Sesión</dt><dd>${esc(s.sessionSource || '—')}</dd>
      <dt>Avisos push</dt><dd>${esc(chans)}</dd>
      ${s.lastError ? `<dt>Último error</dt><dd class="neg">${esc(s.lastError)}</dd>` : ''}
      ${(s.warnings || []).length ? `<dt>Avisos</dt><dd>${s.warnings.map(esc).join('<br>')}</dd>` : ''}
    </dl></div>
    <div class="box"><h3>Últimas corridas</h3><div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th></th><th>Prod.</th><th>Cambios</th><th>Alertas</th><th>Dur.</th><th>Notas</th></tr></thead>
      <tbody>${runs}</tbody></table></div></div>`;
}

function updateStatusPill() {
  const s = S.status;
  const pill = $('#statusPill');
  pill.classList.remove('ok', 'warn', 'bad');
  if (!s?.lastSuccess) { pill.classList.add('bad'); $('#statusText').textContent = 'Sin datos'; return; }
  const mins = (Date.now() - Date.parse(s.lastSuccess)) / 60000;
  const interval = s.intervalMinutes || 30;
  pill.classList.add(!s.ok || mins > interval * 6 ? 'bad' : mins > interval * 2.5 ? 'warn' : 'ok');
  $('#statusText').textContent = ago(s.lastSuccess);
  const banner = $('#banner');
  const msgs = [];
  if (!s.ok && s.lastError) msgs.push(`⚠️ La última lectura falló: ${s.lastError}`);
  else if (mins > interval * 2.5) msgs.push(`⚠️ Los precios no se actualizan desde ${ago(s.lastSuccess)}.`);
  for (const w of s.warnings || []) if (/primera corrida/i.test(w)) msgs.push(`ℹ️ ${w}`);
  banner.hidden = !msgs.length;
  banner.innerHTML = msgs.map(esc).join('<br>');
  $('#branch').textContent = `Carrefour Maxi · ${s.region || ''}${s.products ? ` · ${s.products.toLocaleString('es-AR')} productos` : ''}`;
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

async function openDetail(ean) {
  const p = S.byEan.get(ean);
  const a0 = S.alerts.find((a) => a.ean === ean);
  if (!p && !a0) return;
  const dlg = $('#detail');
  const base = p || { ean, n: a0.name, c: a0.category, e: a0.price, p: a0.basePrice };
  const render = () => {
    const series = S.history?.[ean] || [];
    const r = S.retail?.[ean];
    const price = base.e ?? base.p;
    const vals = series.map((x) => x[1]);
    const ref = series.length ? refPrice(series) : null;
    const q = parseQty(base.n);
    const alerts = S.alerts.filter((a) => a.ean === ean).slice(0, 10);
    $('#detailBody').innerHTML = `
      <div class="detail-head">
        <img src="${img(ean)}" onerror="this.onerror=null;this.src='${NOIMG}'" alt="">
        <div>
          <div class="meta">${esc([base.s, base.c].filter(Boolean).join(' › '))}</div>
          <h2>${esc(base.n)}</h2>
          <div><span class="price">${ars(price)}</span>${base.pp && base.p > base.pp ? `<span class="was">${ars(base.p)}</span>` : ''}</div>
          ${base.pp ? `<div class="meta">Precio llevando ${base.q || 'varias'} unidades · normal ${ars(base.p)}</div>` : ''}
          ${base.pr ? `<span class="pill promo">${esc(base.pr)}</span>` : ''}
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="k">Precio habitual (30 d)</div><div class="v">${ars(ref)}</div></div>
        <div class="stat"><div class="k">Mínimo registrado</div><div class="v">${ars(vals.length ? Math.min(...vals) : null)}</div></div>
        <div class="stat"><div class="k">Máximo registrado</div><div class="v">${ars(vals.length ? Math.max(...vals) : null)}</div></div>
        <div class="stat"><div class="k">Minorista</div><div class="v">${r?.price ? ars(r.price) : r?.found === false ? 'no está' : '—'}</div></div>
        ${r?.price && price ? `<div class="stat"><div class="k">Margen reventa</div><div class="v ${r.price > price ? 'pos' : 'neg'}">${pct(r.price / price - 1)}</div></div>` : ''}
        ${q && price ? `<div class="stat"><div class="k">Precio por ${q.u}</div><div class="v">${ars(price / q.q)}</div></div>` : ''}
      </div>
      ${chartSvg(series, r?.price)}
      ${alerts.length ? `<h3 style="font-size:14px;margin:14px 0 6px">Alertas</h3><ul class="reasons">${alerts.map((a) => `<li><b>${TYPE_LABEL[a.type] || a.type}</b> · ${fmtDate(a.ts)} · ${ars(a.price)} — ${esc((a.reasons || [])[0] || '')}</li>`).join('')}</ul>` : ''}
      <div class="links">
        <a class="btn" href="${SITE}p/${ean}" target="_blank" rel="noopener">Ver en Carrefour Maxi</a>
        ${r?.url ? `<a class="btn ghost" href="${esc(r.url)}" target="_blank" rel="noopener">Ver minorista</a>` : ''}
        <span class="meta" style="align-self:center">EAN ${ean}</span>
      </div>`;
  };
  render();
  if (!dlg.open) dlg.showModal();
  if (location.hash !== `#p=${ean}`) history.replaceState(null, '', `#p=${ean}`);
  const loads = [];
  if (!S.history) loads.push(getJson('history.json').then((h) => (S.history = h)).catch(() => (S.history = {})));
  if (!S.retail) loads.push(getJson('retail.json').then((r) => (S.retail = r)).catch(() => (S.retail = {})));
  if (loads.length) { await Promise.all(loads); if (dlg.open) render(); }
}

function closeDetail() {
  $('#detail').close();
  if (location.hash.startsWith('#p=')) history.replaceState(null, '', location.pathname + location.search);
}

// ---------- navegación ----------
function setTab(tab) {
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

function fillSectors() {
  const sectors = [...new Set(S.products.map((p) => p.s).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  for (const id of ['#resaleSector', '#dropSector', '#searchSector']) {
    const sel = $(id);
    const cur = sel.value;
    sel.innerHTML = '<option value="">Todas las secciones</option>' + sectors.map((s) => `<option>${esc(s)}</option>`).join('');
    sel.value = cur;
  }
}

async function load() {
  const [status, products, alerts] = await Promise.allSettled([getJson('status.json'), getJson('products.json'), getJson('alerts.json')]);
  S.status = status.value || null;
  S.products = products.value?.items || [];
  S.byEan = new Map(S.products.map((p) => [p.ean, p]));
  S.alerts = alerts.value?.alerts || [];
  fillSectors();
  updateStatusPill();
  renderAlerts();
  if (S.tab !== 'alertas') renderTab();
}

function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function bind() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
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
    if (card) openDetail(card.dataset.ean);
  });
  on('#closeDetail', 'click', closeDetail);
  $('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') closeDetail(); });
  $('#detail').addEventListener('close', () => { if (location.hash.startsWith('#p=')) history.replaceState(null, '', location.pathname + location.search); });
  window.addEventListener('hashchange', () => { const m = location.hash.match(/^#p=(\d+)/); if (m) openDetail(m[1]); });
}

(async function init() {
  bind();
  const saved = store.get('tab', 'alertas');
  if (saved !== 'alertas' && document.getElementById(`tab-${saved}`)) setTab(saved);
  await load();
  const m = location.hash.match(/^#p=(\d+)/);
  if (m) openDetail(m[1]);
  // refresco automático cada 5 minutos
  setInterval(async () => {
    S.history = null; S.retail = null;
    await load();
  }, 5 * 60e3);
  setInterval(updateStatusPill, 60e3);
})();
