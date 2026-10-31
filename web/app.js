// Radar Maxi — web estática. Lee los JSON de ./data/ que genera el monitor.
// Fuentes separadas: mayorista (una por sucursal Maxi) y minorista (tienda Hiper Gualeguaychú).
const DATA = './data/';
const MAXI = 'https://comerciante.carrefour.com.ar/';
const CHUNK = 40;
const TZ = 'America/Argentina/Buenos_Aires';
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const DAYS_FULL = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const SIG = {
  descuento: { label: 'Descuento', tag: 'drop', sign: '−' },
  sucursal: { label: 'Más barato que otra sucursal', short: 'Entre sucursales', tag: 'may', sign: '−' },
  reventa: { label: 'Margen de reventa', short: 'Reventa', tag: 'good', sign: '+' },
  bajoMayorista: { label: 'Más barato que en Maxi', short: 'Más barato que Maxi', tag: 'min', sign: '−' },
  kilo: { label: 'Precio por kg bajo', short: 'Por kg', tag: 'warn', sign: '−' },
  bajas: { label: 'Bajaron en 7 días', short: 'Bajaron', tag: 'drop', sign: '−' },
};
const TYPE = {
  error: { label: 'Posible error', tag: 'drop' },
  oportunidad: { label: 'Oportunidad', tag: 'offer' },
  reventa: { label: 'Reventa', tag: 'good' },
  baja: { label: 'Baja fuerte', tag: 'drop' },
  minimo: { label: 'Mínimo histórico', tag: 'may' },
};
const LEGACY = [
  { id: 'may-legacy', kind: 'mayorista', name: 'Carrefour Maxi', files: { products: 'products.json', alerts: 'alerts.json', history: 'history.json' } },
  { id: 'min', kind: 'minorista', name: 'Hiper Gualeguaychú', files: { products: 'min-products.json', alerts: 'min-alerts.json', history: 'min-history.json' } },
];

// ---------- almacenamiento local (sólo comodidades de este navegador) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};
const DEFAULTS = {
  theme: 'system',
  medios: { prepaga: true, credito: false, anses: false },
  maxPrice: 40000,
  hidden: { mayorista: [], minorista: [] },
  hideUnseen: true,
  maxMinQty: 0,
  oppMinPct: 30,
  oppMinMargin: 35,
  kind: '',
  branch: '',
  view: 'ofertas',
};
const SET = { ...DEFAULTS, ...store.get('radar.settings', {}) };
SET.medios = { ...DEFAULTS.medios, ...(SET.medios || {}) };
SET.hidden = { mayorista: [], minorista: [], ...(SET.hidden || {}) };
const saveSettings = () => store.set('radar.settings', SET);
let FAVS = store.get('radar.favs', {});
const saveFavs = () => store.set('radar.favs', FAVS);

// ---------- estado ----------
const blank = () => ({ products: [], byEan: new Map(), alerts: [], history: null, loaded: false, updatedAt: null });
const S = { manifest: [], data: {}, status: null, opp: null, retail: null, promos: null, ajustes: null, oppSig: '', alertType: '' };
const srcOf = (id) => S.manifest.find((s) => s.id === id);
const mayList = () => S.manifest.filter((s) => s.kind === 'mayorista');
const minSrc = () => S.manifest.find((s) => s.kind === 'minorista');
// Nombre de la tienda minorista (siempre Hiper Gualeguaychú, nunca el precio online general)
const minName = () => { const n = dataOf(minSrc()?.id || 'min').store || minSrc()?.name; return n && !/carrefour\.com/i.test(n) ? n : 'Hiper Gualeguaychú'; };
const kindOf = (id) => srcOf(id)?.kind || (id === 'min' ? 'minorista' : 'mayorista');
const curId = () => (SET.kind === 'minorista' ? minSrc()?.id : SET.branch);
const dataOf = (id) => S.data[id] || (S.data[id] = blank());
const D = () => dataOf(curId());

// ---------- utilidades ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n, d = 0) => Number(n).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const ars = (n) => (n || n === 0 ? `$${fmt(Math.round(n))}` : '—');
const pct = (x) => `${Math.round(x * 100)}%`;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const title = (s) => String(s || '').toLowerCase().replace(/(^|[\s(-])\S/g, (c) => c.toUpperCase());
const icon = (id, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const NOIMG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#F2F3F5"/><path d="M22 40l8-9 6 6 6-8 6 11z" fill="#C7CCD3"/><circle cx="25" cy="25" r="4" fill="#C7CCD3"/></svg>');
function ago(ts) {
  if (!ts) return '—';
  const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
  if (m < 1) return 'recién';
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}
const fmtDate = (d, withYear = false) => new Date(d).toLocaleString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit', ...(withYear ? { year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' });
function todayAR(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t)?.value;
  return { iso: `${g('year')}-${g('month')}-${g('day')}`, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')) };
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}
async function getJson(name) {
  const r = await fetch(`${DATA}${name}?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
}
const repo = (() => {
  const owner = location.hostname.endsWith('github.io') ? location.hostname.split('.')[0] : 'kiwiplusapp';
  const name = location.hostname.endsWith('github.io') ? location.pathname.split('/')[1] : 'Carrefour-Mayorista-Precios-';
  return `https://github.com/${owner}/${name}`;
})();

// ---------- imágenes con respaldo ----------
const fullImg = (x) => {
  if (!x) return null;
  const u = /^https?:/.test(x) ? x : `https://carrefourar.vteximg.com.br/arquivos/ids/${x}`;
  return u.replace(/((?:vteximg\.com\.br|vtexassets\.com)\/arquivos\/ids\/)(\d+)\//, '$1$2-240-240/');
};
const fullUrl = (x) => (!x ? null : /^https?:/.test(x) ? x : `https://www.carrefour.com.ar/${x}/p`);
const proxyImg = (u) => `https://wsrv.nl/?url=${encodeURIComponent(u.replace(/^https?:\/\//, ''))}&w=240&h=240&fit=contain&bg=white&output=jpg`;
function imgCandidates(v) {
  const list = [];
  const own = fullImg(v.im);
  if (own) list.push(own);
  if (v.kind === 'mayorista' && /^\d+$/.test(v.ean)) list.push(`https://tupedido.carrefour.com.ar/imagenesPDA/${v.ean}.jpg`);
  const alt = v.kind === 'mayorista' ? S.data[minSrc()?.id]?.byEan?.get(v.ean) : null;
  if (alt?.im) list.push(fullImg(alt.im));
  if (list[0]) list.push(proxyImg(list[0]));
  return [...new Set(list)];
}
function imgTag(v, cls, lazy = true) {
  const [src, ...rest] = imgCandidates(v);
  return `<img class="${cls}"${lazy ? ' loading="lazy"' : ''} decoding="async" referrerpolicy="no-referrer" src="${esc(src || NOIMG)}" data-fb="${esc(rest.map(encodeURIComponent).join('|'))}" alt="">`;
}
document.addEventListener('error', (e) => {
  const el = e.target;
  if (el.tagName !== 'IMG' || !('fb' in el.dataset)) return;
  const list = el.dataset.fb.split('|').filter(Boolean);
  const next = list.shift();
  el.dataset.fb = list.join('|');
  el.src = next ? decodeURIComponent(next) : NOIMG;
  if (!next) delete el.dataset.fb;
}, true);

// ---------- cantidades y precio por kg ----------
function parseQty(desc, multipack) {
  const d = ` ${String(desc || '').toLowerCase().replace(/,/g, '.')} `;
  const U = '(kgs?|kilos?|k|grs?|grm|gramos?|g|ml|cc|cm3|lts?|litros?|l)';
  const n2 = (n, u) => (/^(kgs?|kilos?|k)$/.test(u) ? { q: n, u: 'kg' } : /^(grs?|grm|gramos?|g)$/.test(u) ? { q: n / 1000, u: 'kg' } : /^(ml|cc|cm3)$/.test(u) ? { q: n / 1000, u: 'l' } : { q: n, u: 'l' });
  const m = d.match(new RegExp(`(?<![\\w.])(\\d+)\\s*(?:u\\.?|un\\.?|unid\\.?|unidades)?\\s*x\\s*(\\d+(?:\\.\\d+)?)\\s*${U}\\b`));
  if (m && !multipack) return n2(+m[2], m[3]);
  if (m && +m[1] > 1 && +m[1] <= 200) { const b = n2(+m[2], m[3]); return { q: b.q * +m[1], u: b.u }; }
  const all = [...d.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${U}(?![a-z])`, 'g'))];
  if (all.length) { const l = all[all.length - 1]; const r = n2(+l[1], l[2]); if (r.q > 0) return r; }
  return null;
}
const NON_UNIT = /electro|tecnolog|hogar|indumentaria|jugueter|librer|automotor|aire libre|beb[eé]|bazar|textil/i;
function unitPrice(v) {
  if (v.up && v.uu) return { price: v.up, u: v.uu };
  if (NON_UNIT.test(v.sector || '')) return null;
  const q = parseQty(v.name, v.kind !== 'mayorista');
  return q && q.q > 0 ? { price: v.price / q.q, u: q.u } : null;
}

// ---------- modelo de producto para mostrar ----------
function vm(p, id) {
  const price = p.e ?? p.p;
  return {
    id, kind: kindOf(id), ean: p.ean, name: p.n, sector: p.s, section: p.sc, category: p.c, price,
    was: p.pp && p.p > p.pp ? p.p : p.lp && p.lp > price ? p.lp : null,
    promo: p.pr || null, minQty: p.q || null, pack: p.pk || null, lim: p.lim || null, seller: p.sl || null,
    up: p.up || null, uu: p.uu || null, im: p.im || null, u: p.u || null, l: p.l || null, f: p.f || null,
  };
}
function vmFrom(item, id) {
  const p = dataOf(id).byEan.get(item.ean);
  if (p) return vm(p, id);
  return vm({ ean: item.ean, n: item.name, s: item.sector, c: item.category, e: item.price, p: item.basePrice || item.price, lp: item.listPrice, pr: item.promo, q: item.minQty, u: item.url, im: item.image, sl: item.seller }, id);
}
const unseen = (v) => v.l && dataOf(v.id).updatedAt && Date.parse(v.l) < Date.parse(dataOf(v.id).updatedAt) - 3600e3;
function passes(v) {
  if (SET.maxPrice && v.price > SET.maxPrice) return false;
  if ((SET.hidden[v.kind] || []).includes(v.sector)) return false;
  if (SET.hideUnseen && unseen(v)) return false;
  if (SET.maxMinQty && v.minQty > SET.maxMinQty) return false;
  return true;
}

// ---------- descuentos por día (promos.json + medios de pago elegidos) ----------
function activePromos(kind, dow, iso = todayAR().iso) {
  return (S.promos?.promos || []).filter((pr) => SET.medios[pr.medio] && pr.fuentes?.includes(kind) && pr.dias?.includes(dow) && (!pr.desde || iso >= pr.desde) && (!pr.hasta || iso <= pr.hasta));
}
function promoFor(v) {
  const { iso, dow } = todayAR();
  const text = `${v.sector || ''} ${v.section || ''} ${v.category || ''}`;
  const hasOffer = Boolean(v.promo || v.was);
  let best = null;
  for (const pr of activePromos(v.kind, dow, iso)) {
    if (pr.excluye_rubros && new RegExp(pr.excluye_rubros, 'i').test(text)) continue;
    if (pr.excluye_promos && v.promo && new RegExp(pr.excluye_promos, 'i').test(v.promo)) continue;
    if (pr.excluye_marketplace && v.seller) continue;
    if (!pr.acumulable && hasOffer) continue;
    if (!best || pr.pct > best.pct) best = pr;
  }
  return best;
}
const medioName = (m) => S.promos?.medios?.[m] || m;

// ---------- piezas de interfaz ----------
function priceHtml(n, { big = false, cu = true } = {}) {
  if (!n && n !== 0) return '<span class="price">—</span>';
  const r = Math.round(n * 100) / 100;
  const ent = Math.floor(r);
  const cents = Math.round((r - ent) * 100);
  return `<span class="price${big ? ' price--lg' : ''}"><span class="cur">$</span>${fmt(ent)}${cents ? `<sup>${String(cents).padStart(2, '0')}</sup>` : ''}${cu ? '<span class="cu">c/u</span>' : ''}</span>`;
}
function srcLabel(id) {
  const s = srcOf(id);
  if (kindOf(id) === 'minorista') return `<span class="src src--min">${esc(minName())}</span>`;
  return `<span class="src src--may">Maxi ${esc(title(s?.name || ''))}</span>`;
}
function subLine(v) {
  const u = unitPrice(v);
  const parts = [];
  if (u) parts.push(`${ars(u.price)}/${u.u}`);
  if (v.minQty) parts.push(`mín. ${v.minQty} u.`);
  if (v.lim) parts.push(`máx. ${v.lim} u.`);
  if (v.pack) parts.push(`bulto ${v.pack}`);
  return parts.length ? `<div class="row__sub">${parts.map((x) => `<span>${x}</span>`).join('')}</div>` : '';
}
const starBtn = (v) => {
  const on = Boolean(FAVS[`${v.id}|${v.ean}`]);
  return `<button type="button" class="iconbtn star row__star" data-fav="${esc(v.id)}|${esc(v.ean)}" aria-pressed="${on}" aria-label="${on ? 'Quitar de favoritos' : 'Guardar en favoritos'}">${icon('star')}</button>`;
};
function rowHtml(v, { tags = [], reasons = [], pctTag = '', note = '' } = {}) {
  const pr = promoFor(v);
  const today = pr ? `<span class="today-price">${icon('card')}Hoy con ${pr.medio === 'prepaga' ? 'Prepaga' : 'tarjeta'}: ${ars(v.price * (1 - pr.pct / 100))}</span>` : '';
  const all = [...(v.promo ? [`<span class="tag tag--offer">${esc(v.promo)}</span>`] : []), ...tags, ...(unseen(v) ? [`<span class="tag tag--plain">No visto ${ago(v.l)}</span>`] : [])];
  return `<div class="row" data-open="${esc(v.id)}|${esc(v.ean)}">
    ${imgTag(v, 'row__img')}
    <div class="row__body">
      <div class="row__meta">${srcLabel(v.id)}<span>${esc(v.category || v.section || '')}</span></div>
      <button type="button" class="row__open"><span class="row__name">${esc(v.name)}</span></button>
      <div class="row__priceline">${priceHtml(v.price, { cu: v.kind === 'mayorista' })}${v.was ? `<span class="was">${ars(v.was)}</span>` : ''}${pctTag}</div>
      ${subLine(v)}
      ${all.length ? `<div class="row__tags">${all.join('')}</div>` : ''}
      ${today}
      ${reasons.length ? `<ul class="row__why">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${note}
    </div>
    ${starBtn(v)}
  </div>`;
}
const emptyHtml = (ic, head, text) => `<div class="empty">${icon(ic)}<b>${esc(head)}</b><p>${text}</p></div>`;

// Lista infinita: dibuja de a 40 y sigue al llegar al final
const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) appendMore(e.target.parentElement);
}, { rootMargin: '600px' }) : null;
function mountList(el, items, render, empty) {
  el._items = items;
  el._render = render;
  el._n = 0;
  el.innerHTML = '';
  const next = el.nextElementSibling;
  if (next?.classList.contains('empty')) next.remove();
  if (!items.length) {
    el.hidden = true;
    el.insertAdjacentHTML('afterend', empty);
    return;
  }
  el.hidden = false;
  appendMore(el);
}
function appendMore(el) {
  if (!el._items) return;
  el.querySelector('.more')?.remove();
  const chunk = el._items.slice(el._n, el._n + CHUNK);
  el.insertAdjacentHTML('beforeend', chunk.map(el._render).join(''));
  el._n += chunk.length;
  if (el._n < el._items.length) {
    el.insertAdjacentHTML('beforeend', `<div class="more">Mostrando ${fmt(el._n)} de ${fmt(el._items.length)}</div>`);
    const s = el.querySelector('.more');
    if (io) io.observe(s);
    else s.addEventListener('click', () => appendMore(el));
  }
}

// ---------- carga de datos ----------
async function loadSource(id) {
  const s = srcOf(id);
  const d = dataOf(id);
  if (!s) return d;
  const [products, alerts] = await Promise.allSettled([getJson(s.files.products), getJson(s.files.alerts)]);
  d.products = products.value?.items || [];
  d.byEan = new Map(d.products.map((p) => [p.ean, p]));
  d.updatedAt = products.value?.updatedAt || null;
  d.store = products.value?.store || null;
  d.alerts = (alerts.value?.alerts || []).map((a) => ({ ...a, sourceId: a.sourceId || id }));
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
async function loadAll() {
  const [status, manifest, opp, promos, ajustes] = await Promise.allSettled([getJson('status.json'), getJson('sources.json'), getJson('oportunidades.json'), getJson('promos.json'), getJson('ajustes.json')]);
  S.status = status.value || null;
  S.manifest = manifest.value?.sources?.length ? manifest.value.sources : LEGACY;
  S.opp = opp.value || { items: [] };
  S.promos = promos.value || { promos: [] };
  S.ajustes = ajustes.value || null;
  S.data = {};
  await Promise.all(S.manifest.map((s) => loadSource(s.id)));
  if (!SET.branch || !srcOf(SET.branch)) SET.branch = mayList()[0]?.id || '';
  if (!SET.kind) SET.kind = mayList().length && D().products.length ? 'mayorista' : 'minorista';
  if (SET.kind === 'mayorista' && !mayList().length) SET.kind = 'minorista';
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

// ---------- encabezado, fuente y sucursal ----------
function renderHeader() {
  document.body.dataset.kind = SET.kind;
  document.querySelectorAll('.switch__btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === SET.kind)));
  const day = (kind) => S.manifest.filter((s) => s.kind === kind).reduce((n, s) => n + dataOf(s.id).alerts.filter((a) => Date.parse(a.ts) > Date.now() - 864e5).length, 0);
  $('#cntMay').textContent = day('mayorista') || '';
  $('#cntMin').textContent = day('minorista') || '';
  $('#alertDot').hidden = !D().alerts.some((a) => Date.parse(a.ts) > Date.now() - 864e5);
  const list = mayList();
  $('#branches').innerHTML = SET.kind === 'mayorista' && list.length > 1
    ? list.map((s) => {
        const bad = S.status?.sources?.[s.id]?.ok === false;
        return `<button type="button" class="branch" data-branch="${esc(s.id)}" aria-pressed="${s.id === SET.branch}">${esc(title(s.name))}${bad ? '<i class="warn" aria-label="con problemas"></i>' : ''}</button>`;
      }).join('')
    : '';
  const st = S.status?.sources?.[curId()];
  const n = st?.products ? ` · ${fmt(st.products)} productos` : '';
  $('#subline').textContent = SET.kind === 'mayorista' ? `Maxi ${title(srcOf(SET.branch)?.name || '')}${n}` : `Minorista · ${minName()}${n}`;
  const btn = $('#statusBtn');
  btn.classList.remove('is-ok', 'is-warn', 'is-bad');
  if (!st?.lastSuccess) {
    btn.classList.add('is-bad');
    $('#statusText').textContent = 'Sin datos';
  } else {
    const mins = (Date.now() - Date.parse(st.lastSuccess)) / 60000;
    const iv = S.status.intervalMinutes || 30;
    btn.classList.add(!st.ok || mins > iv * 6 ? 'is-bad' : mins > iv * 2.5 ? 'is-warn' : 'is-ok');
    $('#statusText').textContent = ago(st.lastSuccess);
  }
  renderNotice();
}
function renderNotice() {
  const id = curId();
  const st = S.status?.sources?.[id];
  const box = $('#notice');
  let html = '';
  if (SET.kind === 'mayorista') {
    const bad = (S.status?.cookies || []).find((c) => !c.ok && (!c.branch || `may-${norm(c.branch).replace(/[^a-z0-9]+/g, '-')}` === id));
    if (!mayList().length) html = `<b>Mayorista sin datos.</b> Falta cargar la cookie de Carrefour Maxi. <button type="button" class="link" data-goto="sesiones">Ver cómo</button>`;
    else if (bad || st?.ok === false) html = `<b>Se venció la sesión de Maxi ${esc(title(srcOf(id)?.name || ''))}.</b> Ves precios de ${esc(ago(st?.lastSuccess))}. <button type="button" class="link" data-goto="sesiones">Cómo renovarla</button>`;
  } else if (st?.ok === false) {
    html = `<b>La última lectura de ${esc(minName())} falló.</b> Ves precios de ${esc(ago(st.lastSuccess))}.`;
  }
  if (!html && st?.lastSuccess && (Date.now() - Date.parse(st.lastSuccess)) / 60000 > (S.status.intervalMinutes || 30) * 3) {
    html = `<b>Los precios no se actualizan desde ${esc(ago(st.lastSuccess))}.</b> Revisá el estado del monitor en Ajustes.`;
  }
  box.hidden = !html;
  box.innerHTML = html ? `${icon('info')}<div>${html}</div>` : '';
}

// ---------- OFERTAS ----------
async function oppItems() {
  const id = curId();
  const q = norm($('#oppSearch').value);
  let items;
  if (S.oppSig === 'bajas') {
    const history = await ensureHistory(id);
    const t = Date.now() / 60000 - 7 * 1440;
    items = [];
    for (const p of D().products) {
      const s = history[p.ean];
      const v = vm(p, id);
      if (!s?.length || !v.price) continue;
      const old = priceAt(s, t) ?? s[0][1];
      if (!old || old <= v.price) continue;
      const drop = 1 - v.price / old;
      if (drop < 0.05) continue;
      items.push({ v, signals: { bajas: drop }, reasons: [`Antes ${ars(old)} · bajó ${pct(drop)}`], score: drop, pctMain: drop });
    }
  } else {
    items = (S.opp?.items || [])
      .filter((o) => (SET.kind === 'minorista' ? o.kind === 'minorista' : o.sourceId === SET.branch))
      .map((o) => {
        const sig = {};
        for (const [k, val] of Object.entries(o.signals || {})) {
          if (k === 'reventa' ? val * 100 >= SET.oppMinMargin : val * 100 >= SET.oppMinPct || k === 'kilo') sig[k] = val;
        }
        return { v: vmFrom(o, o.sourceId), signals: sig, reasons: o.reasons || [], stale: o.stale, score: o.score, pctMain: Math.max(0, ...Object.entries(sig).filter(([k]) => k !== 'reventa').map(([, x]) => x)) };
      })
      .filter((it) => Object.keys(it.signals).length && (!S.oppSig || S.oppSig in it.signals));
  }
  items = items.filter((it) => passes(it.v) && (!q || norm(`${it.v.name} ${it.v.ean} ${it.v.category}`).includes(q)));
  const sort = $('#oppSort').value;
  if (sort === 'pct') items.sort((a, b) => b.pctMain - a.pctMain);
  else if (sort === 'price') items.sort((a, b) => a.v.price - b.v.price);
  else items.sort((a, b) => b.score - a.score);
  return items;
}
function sigTags(signals) {
  return Object.entries(signals).map(([k, val]) => `<span class="tag tag--${SIG[k].tag}">${esc(SIG[k].short || SIG[k].label)} ${SIG[k].sign}${pct(val)}</span>`);
}
async function renderOfertas() {
  renderToday();
  const counts = {};
  for (const o of S.opp?.items || []) {
    if (SET.kind === 'minorista' ? o.kind !== 'minorista' : o.sourceId !== SET.branch) continue;
    for (const k of Object.keys(o.signals || {})) counts[k] = (counts[k] || 0) + 1;
  }
  const keys = SET.kind === 'mayorista' ? ['descuento', 'sucursal', 'reventa', 'bajas', 'kilo'] : ['descuento', 'bajoMayorista', 'bajas', 'kilo'];
  if (S.oppSig && !keys.includes(S.oppSig)) S.oppSig = '';
  $('#oppChips').innerHTML = [`<button type="button" class="chip" data-sig="" aria-pressed="${!S.oppSig}">Todas</button>`]
    .concat(keys.filter((k) => k === 'bajas' || counts[k]).map((k) => `<button type="button" class="chip" data-sig="${k}" aria-pressed="${S.oppSig === k}">${esc(SIG[k].short || SIG[k].label)}${counts[k] ? ` <small>${fmt(counts[k])}</small>` : ''}</button>`))
    .join('');
  const items = await oppItems();
  $('#oppCount').textContent = `${fmt(items.length)} ${items.length === 1 ? 'producto' : 'productos'}${S.opp?.updatedAt ? ` · calculado ${ago(S.opp.updatedAt)}` : ''}`;
  mountList($('#oppList'), items, (it) => rowHtml(it.v, { tags: [...sigTags(it.signals), ...(it.stale ? ['<span class="tag tag--plain">De la última lectura</span>'] : [])], reasons: it.reasons.slice(0, 2) }),
    S.oppSig === 'bajas'
      ? emptyHtml('down', 'Todavía no hay bajas registradas', 'El historial se arma con cada lectura. En unos días vas a ver acá lo que bajó en la última semana.')
      : emptyHtml('tag', 'No hay ofertas con estos filtros', 'Probá con otra categoría o bajá el descuento mínimo en Ajustes.'));
}
function renderToday() {
  const { dow } = todayAR();
  const kind = SET.kind;
  const best = (d) => activePromos(kind, d).sort((a, b) => b.pct - a.pct)[0];
  const now = best(dow);
  $('#todayDay').textContent = DAYS[dow];
  const where = kind === 'mayorista' ? 'Carrefour Maxi' : esc(minName());
  if (now) {
    $('#todayText').innerHTML = `<b>${now.pct}% con ${esc(medioName(now.medio))}</b> en ${where}. ${now.acumulable ? 'Se suma a las ofertas' : 'No se suma a otras ofertas'}${now.tope ? `, tope ${ars(now.tope)}` : ', sin tope'}.`;
  } else {
    let next = null;
    for (let i = 1; i <= 7 && !next; i++) { const d = (dow + i) % 7; const p = best(d); if (p) next = { d, p }; }
    $('#todayText').innerHTML = next
      ? `Hoy no hay descuento con tus medios de pago. <b>${title(DAYS_FULL[next.d])}: ${next.p.pct}%</b> con ${esc(medioName(next.p.medio))}.`
      : 'No hay descuentos por día con los medios de pago que elegiste. Cambialos en Ajustes.';
  }
  const order = [1, 2, 3, 4, 5, 6, 0];
  $('#todayWeek').innerHTML = order.map((d) => {
    const p = best(d);
    return `<span class="${p ? 'on' : ''}${d === dow ? ' now' : ''}"><b>${DAYS[d]}</b>${p ? `${p.pct}%` : '·'}</span>`;
  }).join('');
}
function openPromos() {
  const { iso } = todayAR();
  const list = (S.promos?.promos || []).slice().sort((a, b) => (SET.medios[b.medio] ? 1 : 0) - (SET.medios[a.medio] ? 1 : 0));
  const row = (pr) => `<div class="srow srow--stack"><div class="srow__label"><b>${esc(pr.titulo)}</b><span>${esc(pr.detalle)}</span>
      <span class="row__tags" style="margin-top:6px"><span class="tag ${SET.medios[pr.medio] ? 'tag--good' : 'tag--plain'}">${esc(medioName(pr.medio))}${SET.medios[pr.medio] ? '' : ' · no la tenés marcada'}</span>
      <span class="tag tag--plain">${pr.dias.map((d) => DAYS[d]).join(' · ')}</span>${pr.hasta ? `<span class="tag ${iso > pr.hasta ? 'tag--drop' : 'tag--plain'}">${iso > pr.hasta ? 'Vencida' : 'Hasta'} ${pr.hasta.split('-').reverse().join('/')}</span>` : ''}</span></div></div>`;
  openSheet(`
    <div class="d-sec"><h3>Descuentos por día</h3><h2 id="sheetTitle" style="margin:0;font-size:20px">Cuándo conviene comprar</h2>
      <p class="lead" style="font-size:14px">Según tus medios de pago, la web muestra el <b>precio de hoy</b> con el descuento ya aplicado. Elegí tus medios de pago en Ajustes.</p></div>
    <div class="group"><h2>Carrefour Maxi</h2><div class="group__box">${list.filter((p) => p.fuentes.includes('mayorista')).map(row).join('')}</div></div>
    <div class="group"><h2>Carrefour minorista</h2><div class="group__box">${list.filter((p) => p.fuentes.includes('minorista')).map(row).join('')}</div></div>
    <p class="group__hint">Fuente: <a href="${esc(S.promos?.fuente || '#')}" target="_blank" rel="noopener">Carrefour Banco</a>, actualizado ${esc((S.promos?.actualizado || '').split('-').reverse().join('/'))}. El monitor te avisa si cambian.</p>`);
}

// ---------- ALERTAS ----------
function renderAlertas() {
  const q = norm($('#alertSearch').value);
  const hours = Number($('#alertRange').value);
  const since = hours ? Date.now() - hours * 3600e3 : 0;
  const base = D().alerts.filter((a) => (!since || Date.parse(a.ts) >= since));
  const counts = {};
  for (const a of base) for (const t of a.types || [a.type]) counts[t] = (counts[t] || 0) + 1;
  if (S.alertType && !counts[S.alertType]) S.alertType = '';
  $('#alertChips').innerHTML = [`<button type="button" class="chip" data-type="" aria-pressed="${!S.alertType}">Todas <small>${fmt(base.length)}</small></button>`]
    .concat(Object.keys(TYPE).filter((t) => counts[t]).map((t) => `<button type="button" class="chip" data-type="${t}" aria-pressed="${S.alertType === t}">${TYPE[t].label} <small>${fmt(counts[t])}</small></button>`))
    .join('');
  const items = base
    .filter((a) => (!S.alertType || (a.types || [a.type]).includes(S.alertType)) && (!q || norm(`${a.name} ${a.ean} ${a.category}`).includes(q)))
    .map((a) => ({ a, v: vmFrom(a, a.sourceId) }))
    .filter((x) => passes(x.v));
  $('#alertCount').textContent = `${fmt(items.length)} ${items.length === 1 ? 'alerta' : 'alertas'}`;
  mountList($('#alertList'), items, ({ a, v }) => {
    const tags = (a.types || [a.type]).map((t) => `<span class="tag tag--${TYPE[t]?.tag || 'plain'}">${TYPE[t]?.label || t}</span>`);
    const pctTag = a.prev && a.prev > a.price ? `<span class="tag tag--drop">−${pct(a.dropPct || 1 - a.price / a.prev)}</span>` : '';
    const note = `<span class="mono">${esc(ago(a.ts))}${a.notified ? ' · avisada al celular' : ''}</span>`;
    return rowHtml({ ...v, price: a.price, was: a.prev && a.prev > a.price ? a.prev : v.was }, { tags, reasons: (a.reasons || []).slice(0, 2), pctTag, note });
  }, emptyHtml('bell', 'Sin alertas en este período', 'Las alertas aparecen cuando un precio baja fuerte, parece un error o llega a su mínimo. Necesitan algunas lecturas de historial.'));
}

// ---------- BUSCAR ----------
async function renderBuscar() {
  const id = curId();
  const q = norm($('#q').value);
  const sector = $('#searchSector').value;
  const sort = $('#searchSort').value;
  let items = D().products.map((p) => vm(p, id)).filter((v) => passes(v) && (!sector || v.sector === sector) && (!q || norm(`${v.name} ${v.ean} ${v.category}`).includes(q)));
  let extra = () => ({});
  if (sort === 'priceAsc') items.sort((a, b) => a.price - b.price);
  else if (sort === 'priceDesc') items.sort((a, b) => b.price - a.price);
  else if (sort === 'offer') items.sort((a, b) => (b.promo || b.was ? 1 : 0) - (a.promo || a.was ? 1 : 0));
  else if (sort === 'unit') items = items.map((v) => ({ v, u: unitPrice(v)?.price ?? Infinity })).sort((a, b) => a.u - b.u).map((x) => x.v);
  else if (sort === 'margin' && SET.kind === 'mayorista') {
    const r = await ensureRetail();
    items = items.filter((v) => r[v.ean]?.price).map((v) => ({ v, m: r[v.ean].price / v.price - 1 })).sort((a, b) => b.m - a.m).map((x) => x.v);
    extra = (v) => ({ tags: [`<span class="tag tag--good">Reventa +${pct(r[v.ean].price / v.price - 1)}</span>`], reasons: [`En ${minName()} sale ${ars(r[v.ean].price)}`] });
  } else if (sort === 'drop') {
    const h = await ensureHistory(id);
    const t = Date.now() / 60000 - 7 * 1440;
    items = items.map((v) => { const s = h[v.ean]; const old = s?.length ? priceAt(s, t) ?? s[0][1] : null; return { v, d: old && old > v.price ? 1 - v.price / old : 0, old }; }).filter((x) => x.d > 0).sort((a, b) => b.d - a.d);
    const map = new Map(items.map((x) => [x.v.ean, x]));
    items = items.map((x) => x.v);
    extra = (v) => ({ pctTag: `<span class="tag tag--drop">−${pct(map.get(v.ean).d)}</span>`, reasons: [`Antes ${ars(map.get(v.ean).old)}`] });
  } else items.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  $('#searchCount').textContent = `${fmt(items.length)} productos`;
  mountList($('#searchList'), items, (v) => rowHtml(v, extra(v)), emptyHtml('search', 'Sin resultados', 'Probá con otra palabra, el código de barras o revisá las categorías ocultas en Ajustes.'));
}
function fillSectors() {
  const sectors = [...new Set(D().products.map((p) => p.s).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const sel = $('#searchSector');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Todas las secciones</option>' + sectors.filter((s) => !(SET.hidden[SET.kind] || []).includes(s)).map((s) => `<option>${esc(s)}</option>`).join('');
  sel.value = sectors.includes(cur) ? cur : '';
  const marginOpt = $('#searchSort option[value="margin"]');
  marginOpt.hidden = SET.kind !== 'mayorista';
  if (SET.kind !== 'mayorista' && $('#searchSort').value === 'margin') $('#searchSort').value = 'name';
}

// ---------- FAVORITOS ----------
function renderFavoritos() {
  const items = Object.values(FAVS).sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  mountList($('#favList'), items, (f) => {
    const p = dataOf(f.id).byEan.get(f.ean);
    const v = p ? vm(p, f.id) : vm({ ean: f.ean, n: f.name, e: f.price, im: f.im }, f.id);
    const ch = p && f.price ? v.price / f.price - 1 : 0;
    const pctTag = Math.abs(ch) >= 0.005 ? `<span class="tag ${ch < 0 ? 'tag--good' : 'tag--drop'}">${ch < 0 ? '▼' : '▲'} ${pct(Math.abs(ch))}</span>` : '';
    const note = `<span class="mono">Guardado ${esc(ago(f.addedAt))} a ${ars(f.price)}${p ? '' : ' · ya no aparece'}</span>`;
    return rowHtml(v, { pctTag, note });
  }, emptyHtml('star', 'Todavía no guardaste productos', 'Tocá la estrella de cualquier producto para seguir su precio desde acá.'));
}
function toggleFav(key) {
  const [id, ean] = key.split('|');
  if (FAVS[key]) {
    delete FAVS[key];
    toast('Quitado de favoritos');
  } else {
    const p = dataOf(id).byEan.get(ean);
    const v = p ? vm(p, id) : null;
    FAVS[key] = { id, ean, name: v?.name || ean, price: v?.price || null, im: v?.im || null, addedAt: new Date().toISOString() };
    toast('Guardado en favoritos');
  }
  saveFavs();
  document.querySelectorAll(`[data-fav="${CSS.escape(key)}"]`).forEach((b) => {
    const on = Boolean(FAVS[key]);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? 'Quitar de favoritos' : 'Guardar en favoritos');
  });
  if (SET.view === 'favoritos') renderFavoritos();
}

// ---------- AJUSTES ----------
const toggleHtml = (id, on, label, hint) => `<div class="srow"><label class="srow__label" for="${id}"><b>${label}</b>${hint ? `<span>${hint}</span>` : ''}</label><span class="toggle"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></span></div>`;
function renderAjustes() {
  const kind = SET.kind;
  const sectors = {};
  for (const p of D().products) sectors[p.s] = (sectors[p.s] || 0) + 1;
  const hidden = SET.hidden[kind] || [];
  const st = S.status || {};
  const ch = st.channels || {};
  const anyCh = ch.telegram || ch.ntfy || ch.discord;
  const av = S.ajustes?.avisos || {};
  const cookies = st.cookies || [];
  const srcRows = S.manifest.map((s) => {
    const x = st.sources?.[s.id] || {};
    return `<div class="srow"><div class="srow__label"><b>${s.kind === 'minorista' ? esc(minName()) : `Maxi ${esc(title(s.name))}`}</b><span>${x.lastSuccess ? `Última lectura ${esc(ago(x.lastSuccess))} · ${fmt(x.products || 0)} productos` : 'Sin lecturas'}${x.lastError ? ` · ${esc(x.lastError)}` : ''}</span></div><span class="pill ${x.ok ? 'ok' : 'bad'}"><i></i>${x.ok ? 'Bien' : 'Con error'}</span></div>`;
  }).join('');
  const runs = (st.runs || []).slice(0, 12).map((r) => `<tr><td>${esc(fmtDate(r.at))}</td><td>${Object.entries(r.results || {}).map(([id, x]) => `${esc(srcOf(id) ? (srcOf(id).kind === 'minorista' ? 'Web' : title(srcOf(id).name)) : id)} ${x.ok ? '✓' : '✗'}`).join(' · ')}</td><td>${r.ms ? `${Math.round(r.ms / 1000)} s` : ''}</td></tr>`).join('');
  $('#settingsBox').innerHTML = `<div class="set">
    <section class="group"><h2>Medios de pago</h2>
      <div class="group__box">
        ${toggleHtml('m-prepaga', SET.medios.prepaga, 'Prepaga / Cuenta Digital Carrefour', 'Maxi: 10% sábados y domingos. Web: 15% viernes y 10% fines de semana.')}
        ${toggleHtml('m-credito', SET.medios.credito, 'Tarjeta de crédito Carrefour', 'Maxi: 15% lunes y martes. Web: 20% martes, 15% el resto (menos jueves).')}
        ${toggleHtml('m-anses', SET.medios.anses, 'Mayor de 60 (ANSES)', 'Web: 10% de lunes a miércoles, tope $20.000 por mes.')}
      </div>
      <p class="group__hint">Con esto calculamos el <b>precio de hoy</b> en cada producto. <button type="button" class="link" data-act="promos">Ver todos los descuentos</button></p>
    </section>

    <section class="group"><h2>Qué productos ver</h2>
      <div class="group__box">
        <div class="srow srow--stack"><label class="srow__label" for="s-max"><b>Precio máximo por unidad</b><span>Los más caros que esto no se muestran.</span></label>
          <div class="range"><input id="s-max" type="range" min="1000" max="40000" step="500" value="${SET.maxPrice}"><output id="s-max-o">${ars(SET.maxPrice)}</output></div></div>
        <div class="srow"><label class="srow__label" for="s-minq"><b>Compra mínima hasta</b><span>Oculta productos que exigen llevar muchas unidades.</span></label>
          <select id="s-minq">${[0, 1, 3, 6, 12, 24].map((n) => `<option value="${n}" ${SET.maxMinQty === n ? 'selected' : ''}>${n ? `${n} u.` : 'Cualquiera'}</option>`).join('')}</select></div>
        ${toggleHtml('s-unseen', SET.hideUnseen, 'Ocultar sin stock', 'Productos que no aparecieron en la última lectura.')}
        <div class="srow srow--stack"><div class="srow__label"><b>Categorías de ${kind === 'mayorista' ? 'Carrefour Maxi' : esc(minName())}</b><span>Tocá para ocultar o mostrar. Afecta ofertas, alertas, búsqueda y favoritos.</span></div>
          <div class="cats">${Object.entries(sectors).sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([s, n]) => `<button type="button" class="cat" data-cat="${esc(s)}" aria-pressed="${!hidden.includes(s)}">${esc(title(s))} <small>${fmt(n)}</small></button>`).join('')}</div>
          ${hidden.length ? '<div><button type="button" class="btn btn--ghost" data-act="showall">Mostrar todas</button></div>' : ''}</div>
      </div>
    </section>

    <section class="group"><h2>Ofertas</h2>
      <div class="group__box">
        <div class="srow srow--stack"><label class="srow__label" for="s-pct"><b>Descuento mínimo</b><span>Para descuentos, diferencias entre sucursales y contra Maxi.</span></label>
          <div class="range"><input id="s-pct" type="range" min="10" max="80" step="5" value="${SET.oppMinPct}"><output id="s-pct-o">${SET.oppMinPct}%</output></div></div>
        <div class="srow srow--stack"><label class="srow__label" for="s-mg"><b>Margen mínimo de reventa</b><span>Diferencia entre Maxi y ${esc(minName())}.</span></label>
          <div class="range"><input id="s-mg" type="range" min="20" max="200" step="5" value="${SET.oppMinMargin}"><output id="s-mg-o">${SET.oppMinMargin}%</output></div></div>
      </div>
    </section>

    <section class="group" id="g-avisos"><h2>Avisos al celular</h2>
      <div class="group__box">
        <div class="srow"><div class="srow__label"><b>Estado</b><span>${anyCh ? `Activos por ${Object.entries(ch).filter(([, v]) => v).map(([k]) => k).join(', ')}.` : 'Todavía no hay ningún canal configurado.'}</span></div><span class="pill ${anyCh ? 'ok' : 'bad'}"><i></i>${anyCh ? 'Activos' : 'Apagados'}</span></div>
        ${anyCh ? '' : `<div class="srow srow--stack"><div class="srow__label"><b>Activarlos con ntfy (gratis, sin cuenta)</b></div>
          <ol class="steps"><li>Instalá la app <b>ntfy</b> en el celular.</li><li>Elegí un nombre difícil de adivinar y copialo:</li></ol>
          <div class="copy"><code id="ntfyName">${esc(store.get('radar.ntfy', '') || newTopic())}</code><button type="button" class="btn btn--ghost" data-copy="ntfyName">${icon('copy')}Copiar</button></div>
          <ol class="steps" start="3"><li>En ntfy tocá <b>+</b> y suscribite a ese nombre.</li><li>En GitHub creá el secret <b>NTFY_TOPIC</b> con el mismo nombre: <a href="${repo}/settings/secrets/actions/new" target="_blank" rel="noopener">abrir</a>.</li></ol></div>`}
        <div class="srow srow--stack"><div class="srow__label"><b>Cuándo te avisa</b><span>Baja fuerte: Maxi ${av.baja_fuerte_mayorista_pct ?? 15}% · web ${av.baja_fuerte_minorista_pct ?? 30}%. Posible error: ${av.posible_error_pct ?? 50}%. Reventa: ${av.margen_reventa_pct ?? 35}%. Oportunidades: descuento ${av.oportunidad_descuento_pct ?? 50}%, entre sucursales ${av.oportunidad_entre_sucursales_pct ?? 35}%, web más barata que Maxi ${av.oportunidad_minorista_mas_barato_pct ?? 40}%. Productos de hasta ${ars(S.ajustes?.precio_maximo_por_unidad ?? 40000)}.</span></div>
          <div><a class="btn btn--ghost" href="${repo}/edit/main/ajustes.json" target="_blank" rel="noopener">${icon('external')}Cambiar en GitHub</a></div></div>
      </div>
    </section>

    <section class="group" id="g-sesiones"><h2>Sesiones de Carrefour Maxi</h2>
      <div class="group__box">
        ${cookies.length ? cookies.map((c) => `<div class="srow"><div class="srow__label"><b>${esc(c.branch ? `Maxi ${title(c.branch)}` : c.var)}</b><span>${esc(c.var)}${c.ok ? ' · funcionando' : ` · ${esc(c.error || 'vencida')}`}</span></div><span class="pill ${c.ok ? 'ok' : 'bad'}"><i></i>${c.ok ? 'Activa' : 'Vencida'}</span></div>`).join('') : '<div class="srow"><div class="srow__label"><b>No hay cookies cargadas</b><span>Sin cookie no hay precios mayoristas.</span></div></div>'}
        <div class="srow srow--stack"><div class="srow__label"><b>Que no se corte</b><span>La sesión de Carrefour vence si pasa media hora sin uso, esté donde esté la cookie. Para que nunca se corte, creá un trabajo gratis en cron-job.org que toque esta dirección cada 5 minutos con el encabezado <b>Cookie: PHPSESSID=tu-cookie</b>.</span></div>
          <div class="copy"><code id="kaUrl">https://comerciante.carrefour.com.ar/products?currentUrl=sec%2Fbebidas&amp;filters=&amp;orderBy=default&amp;currentPage=1&amp;itemsPerPage=3&amp;method=productsList</code><button type="button" class="btn btn--ghost" data-copy="kaUrl">${icon('copy')}Copiar</button></div>
          <div><a class="btn btn--ghost" href="${repo}#que-la-sesión-no-se-corte-recomendado" target="_blank" rel="noopener">${icon('external')}Ver los pasos</a></div></div>
        <div class="srow srow--stack"><div class="srow__label"><b>Renovar o sumar una sucursal</b><span>Si la sesión ya se cortó, hay que volver a ingresar y cargar la cookie nueva.</span></div>
          <ol class="steps"><li>Para otra sucursal, primero borrá los datos del sitio: Ajustes del iPhone → Safari → Avanzado → Datos de sitios web → <b>carrefour</b>.</li><li>Entrá a Carrefour Maxi y elegí la sucursal.</li><li>Copiá la cookie <b>PHPSESSID</b> y cargala en GitHub como <b>CF_COOKIE</b> (Zárate en <b>CF_COOKIE_2</b>, Escobar en <b>CF_COOKIE_3</b>).</li></ol>
          <div class="actions"><a class="btn btn--primary" href="${MAXI}" target="_blank" rel="noopener">${icon('external')}Abrir Carrefour Maxi</a><a class="btn btn--ghost" href="${repo}/settings/secrets/actions" target="_blank" rel="noopener">${icon('external')}Secrets de GitHub</a></div></div>
      </div>
    </section>

    <section class="group"><h2>Apariencia</h2>
      <div class="group__box"><div class="srow"><div class="srow__label"><b>Tema</b></div>
        <div class="seg" role="group" aria-label="Tema">${[['system', 'Sistema'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([k, l]) => `<button type="button" data-theme-set="${k}" aria-pressed="${SET.theme === k}">${l}</button>`).join('')}</div></div></div>
    </section>

    <section class="group"><h2>Descargas (Excel)</h2>
      <div class="group__box"><div class="srow srow--stack"><div class="srow__label"><b>${SET.kind === 'mayorista' ? `Maxi ${esc(title(srcOf(SET.branch)?.name || ''))}` : esc(minName())}</b><span>Archivos CSV que se abren con Excel o Google Sheets.</span></div>
        <div class="actions"><button type="button" class="btn btn--ghost" data-dl="list">${icon('download')}Lista de precios</button><button type="button" class="btn btn--ghost" data-dl="history">${icon('download')}Historial completo</button><button type="button" class="btn btn--ghost" data-dl="opp">${icon('download')}Ofertas</button></div></div></div>
    </section>

    <section class="group" id="g-estado"><h2>Estado del monitor</h2>
      <div class="group__box">${srcRows}
        <div class="table-wrap"><table class="runs"><thead><tr><th>Lectura</th><th>Resultado</th><th>Duración</th></tr></thead><tbody>${runs}</tbody></table></div></div>
      <p class="group__hint">Lee todo cada 30 minutos.</p>
    </section>

    <section class="group"><div class="group__box"><div class="srow"><div class="srow__label"><b>Restablecer ajustes</b><span>Vuelve a los valores de fábrica. No borra favoritos.</span></div><button type="button" class="btn btn--ghost" data-act="reset">Restablecer</button></div></div></section>
  </div>`;
}
function newTopic() {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = 'radar-maxi-';
  const r = crypto.getRandomValues(new Uint8Array(10));
  for (const x of r) s += a[x % a.length];
  store.set('radar.ntfy', s);
  return s;
}

// ---------- detalle ----------
function chartHtml(series, retail) {
  if (!series?.length) return '<p class="mono">Todavía no hay historial: se arma con cada lectura.</p>';
  return `<div class="chart" id="chart" role="img" aria-label="Historial de precio desde ${esc(fmtDate(series[0][0] * 60000))}"><svg id="chartSvg"></svg><div class="tip" id="chartTip" hidden></div></div>`;
}
function drawChart(series, retail) {
  const box = $('#chart');
  const svg = $('#chartSvg');
  if (!box || !svg) return;
  const W = Math.max(280, box.clientWidth);
  const H = 190, L = 56, R = 12, T = 14, B = 24;
  const now = Date.now() / 60000;
  const pts = series.map((p) => [p[0], p[1]]);
  const x0 = pts[0][0];
  const x1 = Math.max(now, x0 + 60);
  const vals = pts.map((p) => p[1]).concat(retail ? [retail] : []);
  let y0 = Math.min(...vals), y1 = Math.max(...vals);
  if (y0 === y1) { y0 *= 0.92; y1 *= 1.08; }
  const pad = (y1 - y0) * 0.14; y0 -= pad; y1 += pad;
  const X = (t) => L + ((t - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  let d = `M${X(pts[0][0]).toFixed(1)},${Y(pts[0][1]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${X(pts[i][0]).toFixed(1)} V${Y(pts[i][1]).toFixed(1)}`;
  d += ` H${X(now).toFixed(1)}`;
  const area = `${d} V${H - B} H${X(pts[0][0]).toFixed(1)} Z`;
  const ticks = [y0 + pad, (y0 + y1) / 2, y1 - pad];
  const dl = (t) => new Date(t * 60000).toLocaleDateString('es-AR', { timeZone: TZ, day: '2-digit', month: '2-digit' });
  const last = pts[pts.length - 1];
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis" x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${ars(v)}</text>`).join('')}
    <path class="area" d="${area}"/><path class="line" d="${d}"/>
    ${retail ? `<line class="ref" x1="${L}" x2="${W - R}" y1="${Y(retail)}" y2="${Y(retail)}"/><text class="ref-label" x="${W - R}" y="${Y(retail) - 6}" text-anchor="end">web ${ars(retail)}</text>` : ''}
    <circle class="end" cx="${X(now)}" cy="${Y(last[1])}" r="4.5"/>
    <text class="axis" x="${L}" y="${H - 6}">${dl(x0)}</text><text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">hoy</text>
    <line class="cross" id="cx" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="dot" id="cd" r="5" visibility="hidden"/>`;
  const tip = $('#chartTip');
  const cx = svg.querySelector('#cx');
  const cd = svg.querySelector('#cd');
  const show = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const t = x0 + ((clientX - rect.left) / rect.width * W - L) / (W - L - R) * (x1 - x0);
    const tt = Math.min(Math.max(t, x0), x1);
    const v = priceAt(pts, tt) ?? pts[0][1];
    const px = X(tt);
    cx.setAttribute('x1', px); cx.setAttribute('x2', px); cx.setAttribute('visibility', 'visible');
    cd.setAttribute('cx', px); cd.setAttribute('cy', Y(v)); cd.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = `<b>${ars(v)}</b>${esc(fmtDate(tt * 60000))}`;
    tip.style.left = `${Math.min(Math.max(px / W * rect.width, 60), rect.width - 60)}px`;
  };
  const hide = () => { tip.hidden = true; cx.setAttribute('visibility', 'hidden'); cd.setAttribute('visibility', 'hidden'); };
  svg.onpointermove = (e) => show(e.clientX);
  svg.onpointerdown = (e) => show(e.clientX);
  svg.onpointerleave = hide;
}

let detailCtx = null;
async function openDetail(id, ean) {
  if (!srcOf(id)) return;
  const d = dataOf(id);
  if (!d.loaded) await loadSource(id);
  const p = d.byEan.get(ean);
  const opp = (S.opp?.items || []).find((o) => o.ean === ean && o.sourceId === id);
  const alert = d.alerts.find((a) => a.ean === ean);
  if (!p && !opp && !alert) return;
  const v = p ? vm(p, id) : vmFrom(opp || alert, id);
  detailCtx = { id, ean, v };
  const render = () => {
    const isMay = v.kind === 'mayorista';
    const series = d.history?.[ean] || [];
    const r = isMay ? S.retail?.[ean] : null;
    const vals = series.map((x) => x[1]);
    const pr = promoFor(v);
    const u = unitPrice(v);
    const rows = S.manifest.map((s) => {
      const x = dataOf(s.id).byEan.get(ean);
      return x ? { s, price: x.e ?? x.p, me: s.id === id } : null;
    }).filter(Boolean);
    if (isMay && r?.price && !rows.some((x) => x.s.kind === 'minorista')) rows.push({ s: { id: 'web', kind: 'minorista', name: minName() }, price: r.price });
    const tags = [...(v.promo ? [`<span class="tag tag--offer">${esc(v.promo)}</span>`] : []), ...(opp ? sigTags(opp.signals) : [])];
    const alerts = d.alerts.filter((a) => a.ean === ean).slice(0, 6);
    $('#sheetBody').innerHTML = `
      <div class="d-head">
        ${imgTag(v, '', false)}
        <div>
          <div class="row__meta">${srcLabel(id)}<span>${esc([v.sector, v.category].filter(Boolean).map(title).join(' › '))}</span></div>
          <h2 id="sheetTitle">${esc(v.name)}</h2>
          <div class="row__priceline">${priceHtml(v.price, { big: true, cu: isMay })}${v.was ? `<span class="was">${ars(v.was)}</span>` : ''}</div>
        </div>
      </div>
      ${subLine(v).replace('row__sub', 'row__sub mono')}
      ${tags.length ? `<div class="row__tags">${tags.join('')}</div>` : ''}
      ${pr ? `<div class="callout">${icon('card')}<div>Hoy ${esc(DAYS_FULL[todayAR().dow])} pagando con ${pr.medio === 'prepaga' ? 'la Prepaga Carrefour' : pr.medio === 'anses' ? 'Mi Carrefour (ANSES)' : 'la tarjeta Carrefour'}: <b>${ars(v.price * (1 - pr.pct / 100))}</b> (−${pr.pct}%${pr.tope ? `, tope ${ars(pr.tope)}` : ', sin tope'}). <button type="button" class="link" data-act="promos">Condiciones</button></div></div>` : ''}
      <div class="actions actions--detail">
        <a class="btn btn--primary" href="${esc(isMay ? `${MAXI}p/${ean}` : fullUrl(v.u) || 'https://www.carrefour.com.ar/')}" target="_blank" rel="noopener">${icon('external')}${isMay ? 'Ver en Maxi' : 'Ver en la web'}</a>
        <button type="button" class="btn btn--ghost" data-share>${icon('share')}Compartir</button>
        <button type="button" class="btn btn--ghost star" data-fav="${esc(id)}|${esc(ean)}" aria-pressed="${Boolean(FAVS[`${id}|${ean}`])}">${icon('star')}Favorito</button>
      </div>
      ${opp?.reasons?.length ? `<div class="d-sec"><h3>Por qué es oportunidad</h3><ul class="row__why">${opp.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${rows.length > 1 ? `<div class="d-sec"><h3>Comparación</h3><table class="cmp"><tbody>${rows.map((x) => `<tr class="${x.me ? 'me' : ''}"><td>${x.s.kind === 'minorista' ? esc(minName()) : `Maxi ${esc(title(x.s.name))}`}</td><td>${ars(x.price)}</td><td>${x.me ? '' : `<span class="tag ${x.price > v.price ? 'tag--good' : 'tag--drop'}">${x.price > v.price ? '+' : '−'}${pct(Math.abs(x.price / v.price - 1))}</span>`}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="d-sec"><h3>Historial de precio</h3>
        ${chartHtml(series, r?.price)}
        <div class="kv"><div><span>Habitual 30 días</span><b>${ars(series.length ? refPrice(series) : null)}</b></div><div><span>Mínimo</span><b>${ars(vals.length ? Math.min(...vals) : null)}</b></div><div><span>Máximo</span><b>${ars(vals.length ? Math.max(...vals) : null)}</b></div></div>
        ${series.length ? `<details class="table"><summary>Ver cambios de precio (${series.length})</summary><table><thead><tr><th>Desde</th><th>Precio</th></tr></thead><tbody>${series.slice().reverse().map((s2) => `<tr><td>${esc(fmtDate(s2[0] * 60000, true))}</td><td>${ars(s2[1])}</td></tr>`).join('')}</tbody></table></details>` : ''}
        <div><button type="button" class="btn btn--ghost" data-dl="product">${icon('download')}Descargar historial</button></div>
      </div>
      ${alerts.length ? `<div class="d-sec"><h3>Alertas</h3><ul class="row__why">${alerts.map((a) => `<li><b>${esc(TYPE[a.type]?.label || a.type)}</b> · ${esc(fmtDate(a.ts))} · ${ars(a.price)} — ${esc((a.reasons || [])[0] || '')}</li>`).join('')}</ul></div>` : ''}
      ${isMay ? '' : `<p class="group__hint" style="margin:0">Precio de la tienda <b>${esc(minName())}</b>. Es el mismo que ves en la web de Carrefour con esa tienda elegida para retirar.</p>`}
      <p class="mono">${/^\d+$/.test(ean) ? `EAN ${esc(ean)} · ` : ''}${u ? `${ars(u.price)} por ${u.u} · ` : ''}visto ${esc(ago(v.l))}</p>`;
    if (series.length) drawChart(series, r?.price);
  };
  openSheet('');
  render();
  history.replaceState(null, '', `#src=${encodeURIComponent(id)}&p=${encodeURIComponent(ean)}`);
  await Promise.all([ensureHistory(id), v.kind === 'mayorista' ? ensureRetail() : null]);
  if (detailCtx?.ean === ean && !$('#sheet').hidden) render();
}
let lastFocus = null;
function openSheet(html) {
  if ($('#sheet').hidden) lastFocus = document.activeElement;
  if (html) $('#sheetBody').innerHTML = html;
  $('#sheet').hidden = false;
  $('#backdrop').hidden = false;
  document.documentElement.style.overflow = 'hidden';
  $('#sheet').scrollTop = 0;
  $('#sheetClose').focus({ preventScroll: true });
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#backdrop').hidden = true;
  document.documentElement.style.overflow = '';
  detailCtx = null;
  if (/^#src=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
}
async function share() {
  if (!detailCtx) return;
  const { id, ean, v } = detailCtx;
  const where = v.kind === 'mayorista' ? `Maxi ${title(srcOf(id)?.name || '')}` : minName();
  const url = `${location.origin}${location.pathname}#src=${encodeURIComponent(id)}&p=${encodeURIComponent(ean)}`;
  const text = `${title(v.name)} — ${ars(v.price)} en ${where}`;
  if (navigator.share) {
    try { await navigator.share({ title: title(v.name), text, url }); } catch { /* cancelado */ }
    return;
  }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Enlace copiado'); } catch { toast(url); }
}

// ---------- CSV (Excel en español: separador ";" y coma decimal) ----------
const csvNum = (n) => (n === null || n === undefined || n === '' ? '' : String(Math.round(Number(n) * 100) / 100).replace('.', ','));
const csvCell = (x) => { const s = String(x ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function downloadCsv(filename, header, rows) {
  const text = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  toast('Descarga lista');
}
const day = () => new Date().toISOString().slice(0, 10);
const tagOf = (id) => (kindOf(id) === 'minorista' ? 'web' : `maxi-${norm(srcOf(id)?.name || '').replace(/[^a-z0-9]+/g, '-')}`);
function historyRows(series, nowPrice) {
  const rows = series.map((s, i) => [fmtDate(s[0] * 60000, true), series[i + 1] ? fmtDate(series[i + 1][0] * 60000, true) : 'hoy', csvNum(s[1]), csvNum(s[2] ?? '')]);
  if (!rows.length && nowPrice) rows.push([fmtDate(Date.now(), true), 'hoy', csvNum(nowPrice), '']);
  return rows;
}
async function download(kind) {
  const id = curId();
  if (kind === 'product' && detailCtx) {
    const { v } = detailCtx;
    const series = dataOf(detailCtx.id).history?.[detailCtx.ean] || [];
    return downloadCsv(`historial-${tagOf(detailCtx.id)}-${detailCtx.ean}-${day()}.csv`, ['EAN', 'Producto', 'Desde', 'Hasta', 'Precio', 'Precio sin promo'], historyRows(series, v.price).map((r) => [detailCtx.ean, v.name, ...r]));
  }
  if (kind === 'list') {
    const retail = SET.kind === 'mayorista' ? await ensureRetail() : {};
    const rows = D().products.map((p) => vm(p, id)).filter(passes).map((v) => {
      const u = unitPrice(v);
      const r = retail[v.ean];
      const pr = promoFor(v);
      return [v.ean, v.name, v.sector, v.category, csvNum(v.price), csvNum(v.was ?? ''), v.promo || '', pr ? csvNum(v.price * (1 - pr.pct / 100)) : '', v.minQty || '', v.lim || '', u ? csvNum(u.price) : '', u?.u || '', r?.price ? csvNum(r.price) : '', r?.price ? csvNum((r.price / v.price - 1) * 100) : ''];
    });
    return downloadCsv(`precios-${tagOf(id)}-${day()}.csv`, ['EAN', 'Producto', 'Sección', 'Categoría', 'Precio', 'Precio anterior', 'Promo', 'Precio hoy con tu medio de pago', 'Compra mínima', 'Máximo por compra', 'Precio por unidad de medida', 'Unidad', 'Precio en la web', 'Margen %'], rows);
  }
  if (kind === 'history') {
    const h = await ensureHistory(id);
    const rows = [];
    for (const p of D().products) for (const r of historyRows(h[p.ean] || [], p.e ?? p.p)) rows.push([p.ean, p.n, p.c, ...r]);
    return downloadCsv(`historial-${tagOf(id)}-${day()}.csv`, ['EAN', 'Producto', 'Categoría', 'Desde', 'Hasta', 'Precio', 'Precio sin promo'], rows);
  }
  if (kind === 'opp') {
    const items = await oppItems();
    return downloadCsv(`ofertas-${tagOf(id)}-${day()}.csv`, ['EAN', 'Producto', 'Categoría', 'Precio', 'Señales', 'Motivos'], items.map((it) => [it.v.ean, it.v.name, it.v.category, csvNum(it.v.price), Object.entries(it.signals).map(([k, x]) => `${SIG[k].label} ${pct(x)}`).join(' | '), it.reasons.join(' | ')]));
  }
}

// ---------- navegación ----------
const VIEWS = { ofertas: renderOfertas, alertas: renderAlertas, buscar: renderBuscar, favoritos: renderFavoritos, ajustes: renderAjustes };
function setView(view, { scroll = true } = {}) {
  if (!VIEWS[view]) view = 'ofertas';
  SET.view = view;
  saveSettings();
  document.body.dataset.view = view;
  document.querySelectorAll('.view').forEach((s) => (s.hidden = s.id !== `view-${view}`));
  document.querySelectorAll('.tab').forEach((t) => (t.dataset.view === view ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
  VIEWS[view]();
  if (scroll) window.scrollTo({ top: 0 });
}
async function setSource(kind, branch) {
  SET.kind = kind;
  if (branch && srcOf(branch)) SET.branch = branch;
  saveSettings();
  if (curId() && !D().loaded) await loadSource(curId());
  renderHeader();
  fillSectors();
  setView(SET.view, { scroll: false });
}
function applyTheme() {
  if (SET.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = SET.theme;
}
const debounce = (fn, ms = 180) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
async function routeHash() {
  const m = location.hash.match(/^#src=([^&]+)&p=([\w-]+)/);
  if (!m) return;
  const id = decodeURIComponent(m[1]);
  if (!srcOf(id)) return;
  const k = kindOf(id);
  if (k !== SET.kind || (k === 'mayorista' && id !== SET.branch)) await setSource(k, k === 'mayorista' ? id : SET.branch);
  openDetail(id, m[2]);
}

function bind() {
  document.querySelectorAll('.switch__btn').forEach((b) => b.addEventListener('click', () => setSource(b.dataset.kind)));
  $('#branches').addEventListener('click', (e) => { const b = e.target.closest('[data-branch]'); if (b) setSource('mayorista', b.dataset.branch); });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
  $('#statusBtn').addEventListener('click', () => { setView('ajustes'); setTimeout(() => $('#g-estado')?.scrollIntoView({ block: 'start' }), 30); });
  $('#todayCard').addEventListener('click', openPromos);
  $('#oppChips').addEventListener('click', (e) => { const c = e.target.closest('[data-sig]'); if (c) { S.oppSig = c.dataset.sig; renderOfertas(); } });
  $('#alertChips').addEventListener('click', (e) => { const c = e.target.closest('[data-type]'); if (c) { S.alertType = c.dataset.type; renderAlertas(); } });
  $('#oppSearch').addEventListener('input', debounce(renderOfertas));
  $('#oppSort').addEventListener('change', renderOfertas);
  $('#alertSearch').addEventListener('input', debounce(renderAlertas));
  $('#alertRange').addEventListener('change', renderAlertas);
  $('#q').addEventListener('input', debounce(renderBuscar, 220));
  $('#searchSector').addEventListener('change', renderBuscar);
  $('#searchSort').addEventListener('change', renderBuscar);
  $('#backdrop').addEventListener('click', closeSheet);
  $('#sheetClose').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
    // Foco atrapado dentro de la hoja abierta
    if (e.key === 'Tab' && !$('#sheet').hidden) {
      const f = [...$('#sheet').querySelectorAll('a[href], button:not([disabled]), input, select, summary, [tabindex="0"]')].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  document.addEventListener('click', async (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); return; }
    if (e.target.closest('[data-share]')) return share();
    const dl = e.target.closest('[data-dl]');
    if (dl) return download(dl.dataset.dl);
    const go = e.target.closest('[data-goto]');
    if (go) { setView('ajustes'); setTimeout(() => $(`#g-${go.dataset.goto}`)?.scrollIntoView({ block: 'start' }), 30); return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.dataset.act === 'promos') return openPromos();
      if (act.dataset.act === 'showall') { SET.hidden[SET.kind] = []; saveSettings(); fillSectors(); return renderAjustes(); }
      if (act.dataset.act === 'reset') { const keep = { kind: SET.kind, branch: SET.branch, view: 'ajustes' }; Object.assign(SET, structuredClone(DEFAULTS), keep); saveSettings(); applyTheme(); fillSectors(); renderAjustes(); return toast('Ajustes restablecidos'); }
    }
    const cat = e.target.closest('[data-cat]');
    if (cat) {
      const list = new Set(SET.hidden[SET.kind] || []);
      list.has(cat.dataset.cat) ? list.delete(cat.dataset.cat) : list.add(cat.dataset.cat);
      SET.hidden[SET.kind] = [...list];
      saveSettings();
      cat.setAttribute('aria-pressed', String(!list.has(cat.dataset.cat)));
      fillSectors();
      return;
    }
    const th = e.target.closest('[data-theme-set]');
    if (th) { SET.theme = th.dataset.themeSet; saveSettings(); applyTheme(); document.querySelectorAll('[data-theme-set]').forEach((b) => b.setAttribute('aria-pressed', String(b === th))); return; }
    const cp = e.target.closest('[data-copy]');
    if (cp) { const t = $(`#${cp.dataset.copy}`)?.textContent || ''; try { await navigator.clipboard.writeText(t); toast('Copiado'); } catch { getSelection().selectAllChildren($(`#${cp.dataset.copy}`)); toast('Seleccionado: copialo'); } return; }
    const row = e.target.closest('.row[data-open]');
    if (row) { const [id, ean] = row.dataset.open.split('|'); openDetail(id, ean); }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 's-max') { SET.maxPrice = Number(t.value); $('#s-max-o').textContent = ars(SET.maxPrice); saveSettings(); }
    if (t.id === 's-pct') { SET.oppMinPct = Number(t.value); $('#s-pct-o').textContent = `${SET.oppMinPct}%`; saveSettings(); }
    if (t.id === 's-mg') { SET.oppMinMargin = Number(t.value); $('#s-mg-o').textContent = `${SET.oppMinMargin}%`; saveSettings(); }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 's-minq') { SET.maxMinQty = Number(t.value); saveSettings(); }
    if (t.id === 's-unseen') { SET.hideUnseen = t.checked; saveSettings(); }
    if (t.id?.startsWith('m-')) { SET.medios[t.id.slice(2)] = t.checked; saveSettings(); renderToday(); }
  });
  window.addEventListener('hashchange', routeHash);
  window.addEventListener('resize', debounce(() => { if (detailCtx && !$('#sheet').hidden) { const s = dataOf(detailCtx.id).history?.[detailCtx.ean]; if (s?.length) drawChart(s, S.retail?.[detailCtx.ean]?.price); } }, 150));
}

(async function init() {
  applyTheme();
  bind();
  await loadAll();
  renderHeader();
  fillSectors();
  setView(SET.view || 'ofertas', { scroll: false });
  routeHash();
  setInterval(async () => {
    if (!$('#sheet').hidden) return;
    S.retail = null;
    await loadAll();
    renderHeader();
    fillSectors();
    VIEWS[SET.view]?.();
  }, 5 * 60e3);
  setInterval(renderHeader, 60e3);
})();
