// Reglas de detección. Funciones puras (sin red ni disco) para poder testearlas.
import { parseQuantity } from './parse.js';

export const TYPE_RANK = { error: 5, reventa: 4, baja: 3, minimo: 2 };
export const TYPE_LABEL = {
  error: 'Posible error de precio',
  reventa: 'Buen margen para reventa',
  baja: 'Baja fuerte',
  minimo: 'Mínimo histórico',
};

const DAY_MIN = 24 * 60;

export function effectivePrice(p) {
  if (!p || !p.price) return null;
  return p.promoPrice && p.promoPrice < p.price ? p.promoPrice : p.price;
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Precio vigente en el minuto t según una serie [[t, precio], ...] ordenada */
export function priceAt(series, t) {
  let out = null;
  for (const pt of series) {
    if (pt[0] <= t) out = pt[1];
    else break;
  }
  return out;
}

/** Estadísticas del historial previo (sin incluir la lectura actual) */
export function seriesStats(series = [], nowMin) {
  if (!series.length) return { prev: null, min: null, ref: null, days: 0 };
  const prev = series[series.length - 1][1];
  const min = Math.min(...series.map((p) => p[1]));
  const first = series[0][0];
  const days = (nowMin - first) / DAY_MIN;
  // Mediana de muestras diarias de los últimos 30 días (ponderada por tiempo)
  const samples = [];
  for (let d = 0; d < 30; d++) {
    const t = nowMin - d * DAY_MIN;
    if (t < first) break;
    const v = priceAt(series, t);
    if (v) samples.push(v);
  }
  return { prev, min, ref: median(samples) ?? prev, days };
}

/** Mediana de precio por kg/l/unidad por categoría */
export function buildUnitIndex(products) {
  const groups = new Map();
  for (const p of products) {
    const eff = effectivePrice(p);
    const q = parseQuantity(p.name);
    if (!eff || !q || !p.category) continue;
    const key = `${p.category}|${q.unit}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(eff / q.qty);
  }
  const index = new Map();
  for (const [key, list] of groups) index.set(key, { median: median(list), n: list.length });
  return index;
}

const pct = (x) => `${Math.round(x * 100)}%`;
const ars = (n) => `$${Math.round(n).toLocaleString('es-AR')}`;

/**
 * Evalúa un producto. Devuelve null o { type, reasons, metrics }.
 * ctx: { stats, retail, unitIndex, rules, isNew, changed, baseline }
 */
export function evaluateProduct(p, ctx) {
  const { stats, retail, unitIndex, rules, isNew, changed } = ctx;
  const eff = effectivePrice(p);
  if (!eff || eff < rules.minPrice) return null;

  const reasons = [];
  const hits = new Set();
  // "bajó o es nuevo": las reglas de comparación sólo se evalúan ante una baja real
  const wentDown = isNew || (changed && stats.prev && eff < stats.prev);
  const m = { price: eff, prev: stats.prev, ref: stats.ref, min: stats.min };

  if (stats.prev) m.dropPct = 1 - eff / stats.prev;
  if (stats.ref) m.vsRefPct = 1 - eff / stats.ref;
  const retailOk = retail && retail.found && retail.price > 0;
  if (retailOk) m.margin = retail.price / eff - 1;

  // --- 1. Posibles errores de precio ---
  if (stats.prev && eff <= stats.prev * rules.errorRatio) {
    hits.add('error');
    reasons.push(`Bajó ${pct(m.dropPct)} de golpe (antes ${ars(stats.prev)})`);
  } else if (stats.ref && stats.days >= 2 && eff <= stats.ref * rules.errorRatio) {
    hits.add('error');
    reasons.push(`Está ${pct(m.vsRefPct)} por debajo de su precio habitual (${ars(stats.ref)})`);
  }
  if (retailOk && retail.available !== false && eff <= retail.price * rules.errorRetailRatio && (wentDown || ctx.retailFresh)) {
    hits.add('error');
    reasons.push(`Cuesta ${pct(1 - eff / retail.price)} menos que en Carrefour minorista (${ars(retail.price)})`);
  }
  if (unitIndex && wentDown) {
    const q = parseQuantity(p.name);
    const g = q && unitIndex.get(`${p.category}|${q.unit}`);
    if (g && g.n >= rules.unitOutlierMinGroup && g.median > 0) {
      const unitPrice = eff / q.qty;
      m.unitPrice = unitPrice;
      m.unit = q.unit;
      m.unitVsCategory = unitPrice / g.median;
      if (unitPrice <= g.median * rules.unitOutlierRatio) {
        hits.add('error');
        reasons.push(`Precio por ${q.unit} (${ars(unitPrice)}) es ${pct(1 - m.unitVsCategory)} menor que la mediana de "${p.category}"`);
      }
    }
  }

  // --- 2. Baja fuerte ---
  if (stats.prev && changed && m.dropPct >= rules.dropPct && !hits.has('error')) {
    hits.add('baja');
    reasons.push(`Bajó ${pct(m.dropPct)}: ${ars(stats.prev)} → ${ars(eff)}`);
  }

  // --- 3. Mínimo histórico ---
  if (changed && stats.min && stats.days >= rules.minHistoryDays && eff < stats.min && stats.ref && eff <= stats.ref * (1 - rules.minVsMedianPct)) {
    hits.add('minimo');
    reasons.push(`Precio más bajo registrado (mín. anterior ${ars(stats.min)}, habitual ${ars(stats.ref)})`);
  }

  // --- 4. Margen de reventa vs. Carrefour minorista ---
  if (retailOk && retail.available !== false && m.margin >= rules.resaleMargin) {
    const prevMargin = stats.prev ? retail.price / stats.prev - 1 : null;
    const crossed = wentDown && (prevMargin === null || prevMargin < rules.resaleMargin);
    const exceptional = m.margin >= rules.resaleMargin * 1.7 && (wentDown || ctx.retailFresh);
    if (crossed || exceptional) {
      hits.add('reventa');
      reasons.push(`Margen ${pct(m.margin)}: minorista ${ars(retail.price)} vs mayorista ${ars(eff)}`);
    }
  }

  if (!hits.size) return null;
  const type = [...hits].sort((a, b) => TYPE_RANK[b] - TYPE_RANK[a])[0];
  return { type, types: [...hits], reasons, metrics: m };
}

/**
 * Corre todas las reglas.
 * current: Map<ean, product>  (lectura actual, con precio)
 * prevSnapshot: { [ean]: { p } } o null si es la primera corrida
 */
export function detectAll({ current, prevSnapshot, history, retail, rules, nowMin, retailFreshSet = new Set() }) {
  const baseline = !prevSnapshot;
  const list = [...current.values()].filter((p) => p.price);
  const unitIndex = buildUnitIndex(list);
  const found = [];
  let compared = 0;
  let strongDrops = 0;

  for (const p of list) {
    const eff = effectivePrice(p);
    const series = history[p.ean] || [];
    const stats = seriesStats(series, nowMin);
    const isNew = !baseline && !series.length && !(prevSnapshot && prevSnapshot[p.ean]);
    const changed = stats.prev !== null && Math.abs(eff - stats.prev) / stats.prev > 0.001;
    if (stats.prev) {
      compared++;
      if (eff <= stats.prev * (1 - rules.dropPct)) strongDrops++;
    }
    if (baseline) continue;
    const r = evaluateProduct(p, {
      stats,
      retail: retail[p.ean],
      unitIndex,
      rules,
      isNew,
      changed,
      retailFresh: retailFreshSet.has(p.ean),
    });
    if (r) found.push({ product: p, ...r });
  }

  const massDropRatio = compared ? strongDrops / compared : 0;
  return { found, baseline, compared, strongDrops, massDropRatio };
}

/** ¿Hay que notificar? Evita repetir el mismo aviso. */
export function shouldNotify(state, ean, type, price, nowMs, rules) {
  const key = `${ean}:${type}`;
  const last = state.notified?.[key];
  if (!last) return true;
  const hours = (nowMs - Date.parse(last.ts)) / 3600e3;
  if (price <= last.price * (1 - rules.repeatIfLowerPct)) return true; // bajó todavía más
  return hours >= rules.repeatAfterHours;
}

/** Agrega la lectura actual al historial (sólo si cambió el precio). */
export function appendHistory(history, current, nowMin, keepDays) {
  let changes = 0;
  const cutoff = nowMin - keepDays * DAY_MIN;
  for (const p of current.values()) {
    const eff = effectivePrice(p);
    if (!eff) continue;
    const s = history[p.ean] || (history[p.ean] = []);
    const last = s[s.length - 1];
    if (!last || Math.abs(last[1] - eff) > 0.001) {
      const pt = [nowMin, round2(eff)];
      if (p.promoPrice && p.promoPrice < p.price) pt.push(round2(p.price));
      s.push(pt);
      if (last) changes++;
    }
    // recorte de puntos viejos, conservando el último anterior al corte
    while (s.length > 2 && s[1][0] < cutoff) s.shift();
  }
  return changes;
}

export const round2 = (n) => Math.round(n * 100) / 100;
