// Catálogo MINORISTA de carrefour.com.ar (sin login).
//
// Por defecto lee los precios de UNA TIENDA (la de Gualeguaychú), igual que la
// web cuando el cliente elige "Retirar en Hiper Gualeguaychú": usa la búsqueda
// pública con la región de esa tienda. Cada tienda tiene su propio precio.
// Si eso falla, cae al catálogo online general (precio nacional) y lo avisa.
import { config } from './config.js';
import { request, mapLimit, sleep } from './http.js';
import { log } from './log.js';

const API = () => config.retailApi.replace(/\/products\/search$/, '');
const SEARCH = () => config.retailApi.replace(/\/api\/catalog_system\/pub\/products\/search$/, '/api/io/_v/api/intelligent-search/product_search');
const PAGE = 50;
const MAX_WINDOW = 2500;
const IS_PAGE = 100;
const IS_MAX_PAGES = 60;

/** Región de una tienda (lo que la web guarda al elegir dónde retirar) */
export const storeRegionId = (seller) => Buffer.from(`SW#${seller}`).toString('base64');

async function getTree(depth = 3) {
  return request(`${API()}/category/tree/${depth}`, { expect: 'json', retries: 3, timeoutMs: 30000 });
}

/** Especificaciones: en el catálogo vienen como claves sueltas; en la búsqueda, en "properties" */
function specOf(p) {
  const map = {};
  for (const x of p.properties || []) map[x.name] = x.values;
  return (key) => {
    const v = map[key] ?? p[key];
    return (Array.isArray(v) ? v[0] : v) ?? null;
  };
}

/** Cantidad neta oficial: "Gramaje de unidad de consumo" 1250 + "CM3" = 1,25 l */
function officialQty(spec) {
  const g = Number(spec('Gramaje de unidad de consumo'));
  const u = String(spec('Gramaje de unidad de medida') || '').toUpperCase();
  if (!(g > 0)) return null;
  if (/^GR/.test(u)) return { qty: g / 1000, unit: 'kg' };
  if (/^(CM3|CC|ML)$/.test(u)) return { qty: g / 1000, unit: 'l' };
  if (/^KG/.test(u)) return { qty: g, unit: 'kg' };
  if (/^(L|LT|LTS)$/.test(u)) return { qty: g, unit: 'l' };
  return null;
}

/** "PROMO-20% Off Mi Crf Max 24 unidades -Reg-1-20-Black30 al 11/11" → "20% Off Mi Crf Max 24 unidades" */
export function cleanPromo(name) {
  if (!name) return null;
  const s = String(name).replace(/^PROMO[-\s]*/i, '').trim();
  let label = s.split(/\s+-/)[0].trim();
  const pct = s.match(/(\d+)\s*%/);
  if (pct && !/%/.test(label)) label = `${label} ${pct[1]}%`;
  return label || null;
}

/** Convierte un producto (catálogo o búsqueda) en el formato común del monitor. */
export function normalizeRetailProduct(p) {
  const out = [];
  const spec = specOf(p);
  // "Cantidad Maxima Permitida" = tope de unidades por compra en carrefour.com.ar
  const limit = Number(spec('Cantidad Maxima Permitida')) || null;
  const qty = officialQty(spec);
  const cats = (p.categories || []).slice().sort((a, b) => b.length - a.length)[0] || '';
  const parts = cats.split('/').filter(Boolean);
  const link = p.link ? (p.link.startsWith('http') ? p.link : `https://www.carrefour.com.ar${p.link}`) : p.linkText ? `https://www.carrefour.com.ar/${p.linkText}/p` : null;
  for (const it of p.items || []) {
    const offers = (it.sellers || [])
      .map((s) => ({ seller: s.sellerName, sellerId: s.sellerId, ...s.commertialOffer }))
      .filter((o) => o.Price > 0 && (o.AvailableQuantity ?? 0) > 0)
      .sort((a, b) => a.Price - b.Price);
    if (!offers.length) continue;
    const best = offers[0];
    const ean = /^\d{8,14}$/.test(it.ean || '') ? it.ean : null;
    const single = p.items.length === 1;
    out.push({
      ean: ean || `sku${it.itemId}`,
      realEan: ean,
      skuId: it.itemId || null,
      name: (p.items.length > 1 && it.name && !p.productName.includes(it.name) ? `${p.productName} ${it.name}` : p.productName).trim(),
      brand: p.brand || null,
      sector: parts[0] || '',
      section: parts[1] || '',
      category: parts[parts.length - 1] || '',
      price: best.Price,
      listPrice: best.ListPrice > best.Price ? best.ListPrice : null,
      promoPrice: null,
      promo: cleanPromo(best.discountHighlights?.[0]?.name),
      url: link,
      image: it.images?.[0]?.imageUrl?.split('?')[0] || null,
      seller: best.sellerId !== '1' ? best.seller : null,
      limit: single ? limit : null,
      // precio por kg/l calculado con el gramaje oficial y el precio de ESTA tienda
      ...(single && qty ? { unitPrice: Math.round((best.Price / qty.qty) * 100) / 100, unit: qty.unit } : {}),
      private: false,
    });
  }
  return out;
}

// ---------- Precio de una tienda (búsqueda regionalizada) ----------
async function fetchStoreCategory(slug, regionId, onItems) {
  let count = 0;
  let total = null;
  for (let page = 1; page <= IS_MAX_PAGES; page++) {
    const q = new URLSearchParams({ count: String(IS_PAGE), page: String(page), regionId, hideUnavailableItems: 'true' });
    const data = await request(`${SEARCH()}/category-1/${encodeURIComponent(slug)}?${q}`, { expect: 'json', timeoutMs: 30000 });
    const list = data?.products || [];
    total ??= data?.recordsFiltered ?? null;
    for (const p of list) onItems(normalizeRetailProduct(p));
    count += list.length;
    if (list.length < IS_PAGE || (total !== null && count >= total)) break;
    await sleep(config.minorista.delayMs);
  }
  return { count, total };
}

async function fetchStoreCatalog() {
  const tree = await getTree(1);
  const wanted = new Set(config.minorista.categories.map(String));
  const tops = tree.filter((n) => wanted.has(String(n.id)));
  if (!tops.length) throw new Error('No encontré los rubros configurados en carrefour.com.ar (minorista_rubros).');
  const regionId = storeRegionId(config.minorista.store);
  const products = new Map();
  const sections = {};
  const failed = [];
  const add = (items) => {
    for (const it of items) if (!products.has(it.ean)) products.set(it.ean, it);
  };
  await mapLimit(tops, config.minorista.concurrency, async (top) => {
    const slug = (top.url ? new URL(top.url).pathname : `/${top.name}`).replace(/^\/+|\/+$/g, '');
    try {
      const r = await fetchStoreCategory(slug, regionId, add);
      sections[top.name] = r.count;
      if (r.total && r.count < r.total * 0.9) log.warn(`  minorista ${top.name}: ${r.count} de ${r.total} (la búsqueda cortó antes)`);
    } catch (err) {
      failed.push(top.name);
      log.warn(`  minorista ${top.name}: falló (${err.message})`);
    }
  });
  for (const [k, v] of Object.entries(sections)) log.info(`  minorista ${k}: ${v} productos (${config.minorista.storeName})`);
  return { products, sections, failed, store: config.minorista.storeName };
}

// ---------- Precio online general (respaldo) ----------
async function fetchCategory(path, onItems) {
  let count = 0;
  for (let from = 0; from < MAX_WINDOW; from += PAGE) {
    const q = new URLSearchParams();
    q.append('fq', `C:${path}`);
    q.append('fq', 'isAvailablePerSalesChannel_1:1');
    q.set('_from', String(from));
    q.set('_to', String(Math.min(from + PAGE, MAX_WINDOW) - 1));
    const data = await request(`${config.retailApi}?${q.toString()}`, { expect: 'json', timeoutMs: 30000 });
    if (!Array.isArray(data)) break;
    for (const p of data) onItems(normalizeRetailProduct(p));
    count += data.length;
    if (data.length < PAGE) return { count, truncated: false };
    await sleep(config.minorista.delayMs);
  }
  return { count, truncated: true };
}

async function fetchNationalCatalog() {
  const tree = await getTree(3);
  const wanted = new Set(config.minorista.categories.map(String));
  const tops = tree.filter((n) => wanted.has(String(n.id)));
  if (!tops.length) throw new Error('No encontré los rubros configurados en carrefour.com.ar (minorista_rubros).');
  const tasks = [];
  for (const top of tops) {
    const children = top.children?.length ? top.children : [top];
    for (const c of children) tasks.push({ top, node: c, path: children === top.children ? `/${top.id}/${c.id}/` : `/${top.id}/` });
  }
  const products = new Map();
  const sections = {};
  const failed = [];
  const add = (items) => {
    for (const it of items) if (!products.has(it.ean)) products.set(it.ean, it);
  };
  await mapLimit(tasks, config.minorista.concurrency, async ({ top, node, path }) => {
    try {
      let r = await fetchCategory(path, add);
      if (r.truncated && node.children?.length) {
        for (const g of node.children) {
          const r2 = await fetchCategory(`${path}${g.id}/`, add);
          r = { count: r.count + r2.count };
        }
      }
      sections[top.name] = (sections[top.name] || 0) + r.count;
    } catch (err) {
      failed.push(`${top.name} › ${node.name}`);
      log.warn(`  minorista ${top.name} › ${node.name}: falló (${err.message})`);
    }
  });
  for (const [k, v] of Object.entries(sections)) log.info(`  minorista ${k}: ${v} productos (online general)`);
  return { products, sections, failed, store: null };
}

/**
 * Devuelve { products: Map, sections, failed, store }.
 * store = nombre de la tienda si se leyeron sus precios; null si es el precio online general.
 */
export async function fetchRetailCatalog() {
  if (config.minorista.store) {
    try {
      const r = await fetchStoreCatalog();
      if (r.products.size >= 200) return r;
      log.warn(`Sólo ${r.products.size} productos con precios de ${config.minorista.storeName}; uso el precio online general.`);
    } catch (err) {
      log.warn(`No pude leer los precios de ${config.minorista.storeName} (${err.message}); uso el precio online general.`);
    }
  }
  return fetchNationalCatalog();
}

/** Precio de la tienda para un EAN puntual (margen de reventa de productos sueltos). */
export async function lookupStorePrice(ean) {
  const q = new URLSearchParams({ query: ean, count: '3', page: '1', regionId: storeRegionId(config.minorista.store) });
  const data = await request(`${SEARCH()}/?${q}`, { expect: 'json', retries: 2, timeoutMs: 20000 });
  for (const p of data?.products || []) {
    for (const n of normalizeRetailProduct(p)) if (n.realEan === ean) return n;
  }
  return null;
}
