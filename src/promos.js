// Beneficios bancarios de Carrefour por día (promos.json) y vigilancia de cambios
// en la página oficial de Carrefour Banco.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';
import { request } from './http.js';
import { log } from './log.js';

const BANK_URL = 'https://carrefourbanco.com.ar/promociones-carrefour/';

export function loadPromos() {
  try {
    return JSON.parse(fs.readFileSync(config.promosFile, 'utf8'));
  } catch {
    return { promos: [] };
  }
}

/** Fecha y día de semana en Argentina (aunque el servidor esté en otra zona) */
export function todayAR(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const iso = `${get('year')}-${get('month')}-${get('day')}`;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { iso, dow };
}

/**
 * Mejor beneficio que aplica hoy a un producto.
 * item: { source|kind, sector, section, category, promo, seller, listPrice }
 * medios: medios de pago que tiene el usuario (por defecto la Prepaga)
 */
export function promoFor(item, { promos = loadPromos().promos, medios = ['prepaga'], date = new Date() } = {}) {
  const { iso, dow } = todayAR(date);
  const kind = item.source || item.kind;
  const text = `${item.sector || ''} ${item.section || ''} ${item.category || ''}`;
  const hasOffer = Boolean(item.promo || (item.listPrice && item.listPrice > item.price));
  let best = null;
  for (const pr of promos || []) {
    if (!medios.includes(pr.medio)) continue;
    if (!pr.fuentes?.includes(kind)) continue;
    if (!pr.dias?.includes(dow)) continue;
    if ((pr.desde && iso < pr.desde) || (pr.hasta && iso > pr.hasta)) continue;
    if (pr.excluye_rubros && new RegExp(pr.excluye_rubros, 'i').test(text)) continue;
    if (pr.excluye_promos && item.promo && new RegExp(pr.excluye_promos, 'i').test(item.promo)) continue;
    if (pr.excluye_marketplace && item.seller) continue;
    if (!pr.acumulable && hasOffer) continue;
    if (!best || pr.pct > best.pct) best = pr;
  }
  return best;
}

/** Una vez por día revisa si cambió el texto legal de las promos del banco. */
export async function checkBankPromos(state, notifySystem) {
  const { iso } = todayAR();
  if (state.bankPromos?.checkedOn === iso) return null;
  try {
    const html = await request(BANK_URL, { retries: 1, timeoutMs: 30000 });
    // Sólo los textos legales (cambian cuando cambia una promo), no banners ni scripts
    const legal = [...html.matchAll(/(DESCUENTO EXCLUSIVO|PROMOCI[OÓ]N|FINANCIACI[OÓ]N EXCLUSIVA)[^<]{80,}/g)].map((m) => m[0].replace(/\s+/g, ' ').trim());
    if (!legal.length) return null;
    const hash = crypto.createHash('sha256').update(legal.join('\n')).digest('hex').slice(0, 16);
    const prev = state.bankPromos?.hash;
    state.bankPromos = { hash, checkedOn: iso, count: legal.length };
    if (prev && prev !== hash) {
      await notifySystem('Cambiaron las promos de Carrefour Banco', `Revisá los días de descuento: ${BANK_URL}\nSi cambió algo de la Prepaga, actualizá promos.json para que la web calcule bien el precio del día.`);
      return 'changed';
    }
    return 'ok';
  } catch (err) {
    log.warn(`No pude revisar las promos del banco: ${err.message}`);
    return null;
  }
}
