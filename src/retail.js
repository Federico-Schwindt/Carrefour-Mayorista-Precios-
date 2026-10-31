// Precio minorista en carrefour.com.ar (VTEX, API pública) por EAN.
// Sirve para estimar el margen de reventa y detectar errores groseros.
import { config } from './config.js';
import { request, mapLimit, sleep } from './http.js';

export async function lookupRetail(ean) {
  const url = `${config.retailApi}?fq=alternateIds_Ean:${encodeURIComponent(ean)}`;
  const data = await request(url, { expect: 'json', retries: 2, timeoutMs: 20000 });
  const now = new Date().toISOString();
  if (!Array.isArray(data) || !data.length) return { found: false, ts: now };
  const prod = data[0];
  const item = (prod.items || []).find((i) => i.ean === ean) || prod.items?.[0];
  const offers = (item?.sellers || []).map((s) => s.commertialOffer).filter(Boolean);
  const best = offers.filter((o) => o.Price > 0).sort((a, b) => a.Price - b.Price)[0];
  if (!best) return { found: true, available: false, ts: now, name: prod.productName, url: prod.link };
  return {
    found: true,
    available: (best.AvailableQuantity ?? 0) > 0,
    price: best.Price,
    listPrice: best.ListPrice > best.Price ? best.ListPrice : null,
    name: prod.productName,
    url: prod.link,
    ts: now,
  };
}

/**
 * Actualiza el cache de precios minoristas.
 * priority: EANs a consultar sí o sí (candidatos a alerta)
 * Luego completa con los más viejos hasta batchPerRun.
 */
export async function refreshRetail(retailCache, products, priority = []) {
  if (!config.retail.enabled) return { checked: 0 };
  const maxAge = config.retail.maxAgeHours * 3600e3;
  const now = Date.now();
  const age = (ean) => (retailCache[ean]?.ts ? now - Date.parse(retailCache[ean].ts) : Infinity);

  const queue = [];
  const seen = new Set();
  for (const ean of priority) {
    if (!seen.has(ean) && age(ean) > 2 * 3600e3) {
      queue.push(ean);
      seen.add(ean);
    }
  }
  const rest = [...products.keys()]
    .filter((e) => !seen.has(e) && age(e) > maxAge)
    .sort((a, b) => age(b) - age(a));
  for (const ean of rest) {
    if (queue.length >= config.retail.batchPerRun + priority.length) break;
    queue.push(ean);
  }

  let checked = 0;
  let errors = 0;
  await mapLimit(queue, config.retail.concurrency, async (ean) => {
    try {
      retailCache[ean] = await lookupRetail(ean);
      checked++;
    } catch {
      errors++;
    }
    await sleep(150);
  });
  return { checked, errors };
}
