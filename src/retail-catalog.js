// Catálogo MINORISTA de carrefour.com.ar (API pública de catálogo VTEX, sin login).
// Lee sólo productos con stock de los rubros configurados, de a 50 por pedido,
// subcategoría por subcategoría (la API corta en 2.500 resultados por consulta).
import { config } from './config.js';
import { request, mapLimit, sleep } from './http.js';
import { log } from './log.js';

const API = () => config.retailApi.replace(/\/products\/search$/, '');
const PAGE = 50;
const MAX_WINDOW = 2500;

async function getTree(depth = 3) {
  return request(`${API()}/category/tree/${depth}`, { expect: 'json', retries: 3, timeoutMs: 30000 });
}

const spec = (p, key) => (Array.isArray(p[key]) ? p[key][0] : p[key]) ?? null;

/** Precio oficial por kg/l: "($5,700.00 x 1 K.)" + pricePerUnit = 5700 */
function officialUnit(p) {
  const label = String(spec(p, 'Precio x unidad') || '');
  const ppu = Number(spec(p, 'pricePerUnit'));
  if (!(ppu > 0)) return {};
  if (/x\s*1\s*k/i.test(label)) return { unitPrice: ppu, unit: 'kg' };
  if (/x\s*1\s*l/i.test(label)) return { unitPrice: ppu, unit: 'l' };
  return {};
}

/** Convierte un producto VTEX en el formato común del monitor. */
export function normalizeRetailProduct(p) {
  const out = [];
  // "Cantidad Maxima Permitida" = tope de unidades por compra en carrefour.com.ar
  const limit = Number(spec(p, 'Cantidad Maxima Permitida')) || null;
  const unitInfo = officialUnit(p);
  const cats = (p.categories || []).slice().sort((a, b) => b.length - a.length)[0] || '';
  const parts = cats.split('/').filter(Boolean);
  for (const it of p.items || []) {
    const offers = (it.sellers || [])
      .map((s) => ({ seller: s.sellerName, sellerId: s.sellerId, ...s.commertialOffer }))
      .filter((o) => o.Price > 0 && (o.AvailableQuantity ?? 0) > 0)
      .sort((a, b) => a.Price - b.Price);
    if (!offers.length) continue;
    const best = offers[0];
    const ean = /^\d{8,14}$/.test(it.ean || '') ? it.ean : null;
    out.push({
      ean: ean || `sku${it.itemId}`,
      realEan: ean,
      name: (p.items.length > 1 && it.name && !p.productName.includes(it.name) ? `${p.productName} ${it.name}` : p.productName).trim(),
      brand: p.brand || null,
      sector: parts[0] || '',
      section: parts[1] || '',
      category: parts[parts.length - 1] || '',
      price: best.Price,
      listPrice: best.ListPrice > best.Price ? best.ListPrice : null,
      promoPrice: null,
      url: p.link || (p.linkText ? `https://www.carrefour.com.ar/${p.linkText}/p` : null),
      image: it.images?.[0]?.imageUrl?.split('?')[0] || null,
      seller: best.sellerId !== '1' ? best.seller : null,
      limit: p.items.length === 1 ? limit : null,
      ...(p.items.length === 1 ? unitInfo : {}),
      private: false,
    });
  }
  return out;
}

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

/**
 * Devuelve { products: Map, sections: {name: count}, failed: [] }
 */
export async function fetchRetailCatalog() {
  const tree = await getTree(3);
  const wanted = new Set(config.minorista.categories.map(String));
  const tops = tree.filter((n) => wanted.has(String(n.id)));
  if (!tops.length) throw new Error('No encontré los rubros configurados en carrefour.com.ar (MIN_CATEGORIES).');

  // Tareas a nivel subcategoría (nivel 2)
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
      // Si la subcategoría supera la ventana de 2.500, bajamos un nivel más
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
  for (const [k, v] of Object.entries(sections)) log.info(`  minorista ${k}: ${v} productos`);
  return { products, sections, failed };
}
