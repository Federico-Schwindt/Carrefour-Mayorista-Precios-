// Descarga el catálogo completo de la sucursal (≈4000 productos en ~11 pedidos).
import { config } from './config.js';
import { request, sleep } from './http.js';
import { parseMenu, parseProductList } from './parse.js';
import { listUrl } from './session.js';
import { log } from './log.js';

export async function discoverSections(jar) {
  try {
    const html = await request(`${config.baseUrl}products?method=menu`, { jar, retries: 2 });
    const { sections } = parseMenu(html);
    if (sections.length >= 3) return sections;
  } catch (err) {
    log.warn(`No pude leer el menú (${err.message}); uso secciones por defecto.`);
  }
  return config.fallbackSections;
}

async function fetchListing(currentUrl, jar) {
  const per = config.itemsPerPage;
  const all = [];
  let total = null;
  for (let page = 1; page <= 50; page++) {
    const html = await request(listUrl(currentUrl, page, per), { jar });
    const items = parseProductList(html);
    all.push(...items);
    if (page === 1 && items.length >= per) {
      const c = Number(String(await request(listUrl(currentUrl, 1, per, 'countProducts'), { jar })).trim());
      total = Number.isFinite(c) ? c : null;
    }
    if (items.length < per || (total !== null && all.length >= total)) break;
    await sleep(config.http.delayBetweenRequestsMs);
  }
  return all;
}

/**
 * Devuelve { products: Map<ean, product>, sections: {name: count}, failed: [name], private: n }
 */
export async function fetchCatalog(jar) {
  const sections = await discoverSections(jar);
  const products = new Map();
  const counts = {};
  const failed = [];
  for (const sec of sections) {
    try {
      const items = await fetchListing(`sec/${sec}`, jar);
      counts[sec] = items.length;
      for (const it of items) if (!products.has(it.ean)) products.set(it.ean, it);
      log.info(`  ${sec}: ${items.length} productos`);
    } catch (err) {
      failed.push(sec);
      log.warn(`  ${sec}: falló (${err.message})`);
    }
    await sleep(config.http.delayBetweenRequestsMs);
  }

  // Lista de ofertas: marca los productos en promo y suma los que no estén
  try {
    const sale = await fetchListing('sale', jar);
    counts.ofertas = sale.length;
    for (const it of sale) {
      const p = products.get(it.ean);
      if (p) {
        p.onSale = true;
        if (!p.promoPrice && it.promoPrice) p.promoPrice = it.promoPrice;
        if (!p.promo && it.promo) p.promo = it.promo;
      } else {
        products.set(it.ean, { ...it, onSale: true });
      }
    }
  } catch (err) {
    log.warn(`  ofertas: falló (${err.message})`);
  }

  const privateCount = [...products.values()].filter((p) => p.private).length;
  return { products, sections: counts, failed, privateCount };
}
