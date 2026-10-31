// Precio minorista de la tienda Hiper Gualeguaychú por EAN.
// Sirve para estimar el margen de reventa y detectar errores groseros.
import { config } from './config.js';
import { request, mapLimit, sleep } from './http.js';
import { lookupStorePrice } from './retail-catalog.js';

export async function lookupRetail(ean) {
  // Siempre el precio de la tienda de Gualeguaychú (nunca el nacional)
  const n = await lookupStorePrice(ean);
  const ts = new Date().toISOString();
  if (!n) return { found: false, ts };
  return { found: true, available: true, price: n.price, listPrice: n.listPrice, name: n.name, url: n.url, ts };
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
