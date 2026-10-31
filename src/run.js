// Una corrida completa con DOS fuentes independientes:
//   🏪 MAYORISTA  comerciante.carrefour.com.ar (Carrefour Maxi, necesita tu sesión)
//   🛒 MINORISTA  www.carrefour.com.ar (API pública, sin login)
// Si una falla, la otra sigue. Cada una guarda sus propios archivos y alertas.
//
// Uso:  node src/run.js                 (corrida normal, ambas fuentes)
//       node src/run.js --only=minorista (o --only=mayorista)
//       node src/run.js --dry-run       (no notifica ni guarda)
//       node src/run.js --check         (sólo verifica la sesión mayorista)
//       node src/run.js --login         (ingreso asistido en un navegador visible)
import { config } from './config.js';
import { getSession, interactiveLogin, saveSession } from './session.js';
import { fetchCatalog } from './catalog.js';
import { fetchRetailCatalog } from './retail-catalog.js';
import { refreshRetail } from './retail.js';
import { detectAll, appendHistory, shouldNotify, effectivePrice, round2 } from './detect.js';
import { notifyAlert, notifySystem, channelsConfigured } from './notify.js';
import { readJson, writeJson, toMin } from './store.js';
import { log } from './log.js';

const argv = process.argv.slice(2);
const args = new Set(argv);
const DRY = args.has('--dry-run');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

export const SOURCES = {
  mayorista: {
    key: 'mayorista',
    label: 'Mayorista · Carrefour Maxi',
    files: { products: 'products.json', history: 'history.json', alerts: 'alerts.json' },
    statePrefix: '',
    rules: config.rules,
    notifyTypes: config.notify.types,
    maxPerRun: config.notify.maxPerRun,
    enabled: true,
  },
  minorista: {
    key: 'minorista',
    label: 'Minorista · carrefour.com.ar',
    files: { products: 'min-products.json', history: 'min-history.json', alerts: 'min-alerts.json' },
    statePrefix: 'min:',
    rules: { ...config.rules, dropPct: config.minorista.dropPct },
    notifyTypes: config.minorista.types,
    maxPerRun: config.minorista.maxPerRun,
    enabled: config.minorista.enabled,
  },
};

// URLs abreviadas para que el archivo pese menos (la web las reconstruye)
const slimUrl = (u) => (u ? u.replace(/^https:\/\/www\.carrefour\.com\.ar\//, '').replace(/\/p$/, '') : u);
const slimImg = (u) => (u ? u.replace(/^https:\/\/carrefourar\.vteximg\.com\.br\/arquivos\/ids\//, '') : u);

function compactProduct(p, prevItem, nowIso) {
  return {
    ean: p.ean,
    n: p.name,
    s: p.sector,
    sc: p.section,
    c: p.category,
    p: round2(p.price),
    e: round2(effectivePrice(p)),
    ...(p.promoPrice ? { pp: round2(p.promoPrice) } : {}),
    ...(p.minQty ? { q: p.minQty } : {}),
    ...(p.pack ? { pk: p.pack } : {}),
    ...(p.listPrice ? { lp: round2(p.listPrice) } : {}),
    ...(p.promo ? { pr: p.promo } : {}),
    ...(p.onSale ? { o: 1 } : {}),
    ...(p.brand ? { b: p.brand } : {}),
    ...(p.url ? { u: slimUrl(p.url) } : {}),
    ...(p.image ? { im: slimImg(p.image) } : {}),
    ...(p.seller ? { sl: p.seller } : {}),
    f: prevItem?.f || nowIso, // primera vez visto
    l: nowIso, // última vez visto
  };
}

const RANK = { error: 5, reventa: 4, baja: 3, minimo: 2 };
const rank = (a) => (RANK[a.type] || 0) * 10 + (a.dropPct || 0) + (a.margin || 0) / 10;

/** Detección + avisos + guardado para una fuente que ya leyó su catálogo. */
async function processSource(src, current, ctx) {
  const { db, nowIso, nowMin, now } = ctx;
  const [prevProducts, history, prevAlerts] = await Promise.all([
    readJson(src.files.products, null),
    readJson(src.files.history, {}),
    readJson(src.files.alerts, { alerts: [] }),
  ]);
  const prevItems = prevProducts?.items ? Object.fromEntries(prevProducts.items.map((i) => [i.ean, i])) : null;
  const prevCount = prevProducts?.items?.length || 0;
  const warnings = [...(ctx.warnings || [])];
  if (prevCount > 0 && current.size < prevCount * config.guards.minCatalogRatio) warnings.push(`Lectura parcial: ${current.size} de ~${prevCount} productos.`);

  const isMay = src.key === 'mayorista';
  let retailFresh = new Set();
  if (isMay) {
    // Margen de reventa: completamos precios minoristas de los productos que faltan
    const priority = [];
    for (const p of current.values()) {
      const s = history[p.ean];
      const prev = s?.length ? s[s.length - 1][1] : null;
      if (!prev || effectivePrice(p) < prev * 0.97) priority.push(p.ean);
    }
    const before = new Set(Object.keys(db.retail).filter((e) => db.retail[e]?.price));
    const info = await refreshRetail(db.retail, current, prevItems ? priority.slice(0, 300) : []);
    retailFresh = new Set(Object.keys(db.retail).filter((e) => db.retail[e]?.price && !before.has(e)));
    log.info(`[mayorista] precios minoristas consultados: ${info.checked ?? 0}${info.errors ? `, ${info.errors} errores` : ''}.`);
  }

  const det = detectAll({ current, prevSnapshot: prevItems, history, retail: isMay ? db.retail : {}, rules: src.rules, nowMin, retailFreshSet: retailFresh });
  const suspicious = det.compared > 50 && det.massDropRatio > config.guards.maxMassDropRatio;
  if (det.baseline) warnings.push('Primera corrida: se guarda la base de precios, las alertas empiezan en la próxima.');
  if (suspicious) warnings.push(`${Math.round(det.massDropRatio * 100)}% de los productos "bajó" a la vez: se sospecha error de lectura, no se notifica.`);

  const newAlerts = det.found
    .map(({ product: p, type, types, reasons, metrics: m }) => {
      const r = isMay ? db.retail[p.ean] : null;
      return {
        id: `${src.statePrefix}${p.ean}-${nowMin}`,
        source: src.key,
        ts: nowIso,
        ean: p.ean,
        type,
        types,
        name: p.name,
        brand: p.brand || null,
        sector: p.sector,
        section: p.section,
        category: p.category,
        price: round2(m.price),
        basePrice: round2(p.price),
        listPrice: p.listPrice ? round2(p.listPrice) : null,
        prev: m.prev ?? null,
        ref: m.ref ? round2(m.ref) : null,
        min: m.min ?? null,
        dropPct: m.dropPct !== undefined ? round2(m.dropPct) : null,
        retail: r?.price ?? null,
        retailUrl: r?.url ?? null,
        margin: m.margin !== undefined ? round2(m.margin) : null,
        promo: p.promo || null,
        minQty: p.minQty || null,
        url: p.url || null,
        image: p.image || null,
        seller: p.seller || null,
        reasons,
        suppressed: suspicious || undefined,
      };
    })
    .sort((a, b) => rank(b) - rank(a));

  const ch = channelsConfigured();
  let sent = 0;
  let skipped = 0;
  if (!DRY && (ch.telegram || ch.ntfy || ch.discord) && !suspicious) {
    for (const a of newAlerts) {
      if (!src.notifyTypes.includes(a.type)) continue;
      const key = `${src.statePrefix}${a.ean}`;
      if (!shouldNotify(db.state, key, a.type, a.price, now.getTime(), src.rules)) continue;
      if (sent >= src.maxPerRun) {
        skipped++;
        continue;
      }
      if (await notifyAlert(a)) {
        a.notified = true;
        sent++;
        db.state.notified[`${key}:${a.type}`] = { ts: nowIso, price: a.price };
      }
    }
    if (skipped) await notifySystem(`Más alertas ${src.key.toUpperCase()}`, `Hay ${skipped} alertas más de ${src.label}. Miralas en la web${config.dashboardUrl ? `: ${config.dashboardUrl}` : ''}.`);
  }
  log.info(`[${src.key}] alertas: ${newAlerts.length} detectadas, ${sent} notificadas${skipped ? `, ${skipped} sin enviar (límite)` : ''}.`);
  for (const a of newAlerts.slice(0, 10)) log.info(`  [${a.type}] ${a.name} → $${a.price} · ${a.reasons.join(' / ')}`);

  if (DRY) return { products: current.size, changes: 0, alerts: newAlerts.length, sent, warnings };

  const changes = appendHistory(history, current, nowMin, config.historyKeepDays);
  const items = [];
  for (const p of current.values()) items.push(compactProduct(p, prevItems?.[p.ean], nowIso));
  if (prevItems) {
    for (const [ean, it] of Object.entries(prevItems)) {
      if (!current.has(ean) && Date.now() - Date.parse(it.l) < 7 * 864e5) items.push(it);
    }
  }
  items.sort((a, b) => a.n.localeCompare(b.n, 'es'));
  const meta = isMay ? { seller: config.account.seller, region: config.account.region } : { categories: config.minorista.categories };
  await writeJson(src.files.history, history);
  await writeJson(src.files.products, { updatedAt: nowIso, source: src.key, ...meta, count: items.length, items });
  await writeJson(src.files.alerts, { updatedAt: nowIso, source: src.key, alerts: [...newAlerts, ...(prevAlerts.alerts || [])].slice(0, config.alertsKeep) });
  return { products: current.size, changes, alerts: newAlerts.length, sent, warnings };
}

/** Lee el catálogo mayorista (necesita sesión). */
async function readMayorista() {
  const session = await getSession();
  log.info(`[mayorista] sesión: ${session.source}${session.since ? ` (desde ${session.since})` : ''}`);
  const catalog = await fetchCatalog(session.jar);
  const current = new Map([...catalog.products].filter(([, p]) => p.price));
  log.info(`[mayorista] ${catalog.products.size} productos, ${current.size} con precio.`);
  if (current.size < Math.max(50, catalog.products.size * 0.3)) {
    const err = new Error(`Sólo ${current.size}/${catalog.products.size} productos con precio: la sesión no tiene sucursal o el sitio cambió.`);
    err.code = 'NO_SESSION';
    throw err;
  }
  const warnings = catalog.failed.length ? [`Secciones con error: ${catalog.failed.join(', ')}`] : [];
  return { current, warnings, session };
}

/** Lee el catálogo minorista (público). */
async function readMinorista(db, nowIso) {
  const catalog = await fetchRetailCatalog();
  const current = catalog.products;
  log.info(`[minorista] ${current.size} productos con stock.`);
  if (current.size < 200) throw new Error(`Sólo ${current.size} productos minoristas: la API pública cambió o falló.`);
  // Reaprovechamos estos precios para el margen de reventa del mayorista
  for (const p of current.values()) {
    if (!p.realEan || p.seller) continue; // sólo vendidos por Carrefour
    db.retail[p.realEan] = { found: true, available: true, price: p.price, listPrice: p.listPrice, name: p.name, url: p.url, ts: nowIso };
  }
  const warnings = catalog.failed.length ? [`Subcategorías con error: ${catalog.failed.slice(0, 8).join(', ')}${catalog.failed.length > 8 ? '…' : ''}`] : [];
  return { current, warnings };
}

async function noteFailure(db, key, err) {
  const st = db.status.sources[key] || (db.status.sources[key] = {});
  st.ok = false;
  st.lastRun = new Date().toISOString();
  st.lastError = err.message;
  st.consecutiveFailures = (st.consecutiveFailures || 0) + 1;
  const notices = (db.state.failNotice ||= {});
  const last = notices[key] ? Date.parse(notices[key]) : 0;
  const threshold = err.code === 'NO_SESSION' ? 1 : 2;
  if (!DRY && st.consecutiveFailures >= threshold && Date.now() - last > 6 * 3600e3) {
    const title = err.code === 'NO_SESSION' ? '🏪 MAYORISTA: falta la sesión de Carrefour Maxi' : `${key === 'minorista' ? '🛒 MINORISTA' : '🏪 MAYORISTA'}: no se pudieron leer precios`;
    await notifySystem(title, err.message.slice(0, 700));
    notices[key] = new Date().toISOString();
  }
}

async function noteSuccess(db, key, result, extra = {}) {
  const st = db.status.sources[key] || (db.status.sources[key] = {});
  const notices = (db.state.failNotice ||= {});
  if (!DRY && notices[key] && (st.consecutiveFailures || 0) >= 1) {
    await notifySystem(`${key === 'minorista' ? '🛒 MINORISTA' : '🏪 MAYORISTA'}: recuperado`, `Volvió a leer precios: ${result.products} productos.`);
  }
  delete notices[key];
  Object.assign(st, {
    ok: true,
    label: SOURCES[key].label,
    lastRun: new Date().toISOString(),
    lastSuccess: new Date().toISOString(),
    lastError: null,
    consecutiveFailures: 0,
    products: result.products,
    priceChanges: result.changes,
    warnings: result.warnings,
    ...extra,
  });
}

async function main() {
  const startedAt = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();
  const nowMin = toMin(now);

  if (args.has('--login')) {
    const jar = await interactiveLogin();
    log.info('¡Listo! Sesión con precios. Pegá esta línea en el secret CF_COOKIE de GitHub:');
    console.log(`\n${jar.header()}\n`);
    return;
  }
  if (args.has('--check')) {
    const s = await getSession();
    log.info(`Sesión mayorista OK (${s.source}).`);
    return;
  }

  const db = {
    retail: await readJson('retail.json', {}),
    state: await readJson('state.json', { notified: {} }),
    status: await readJson('status.json', {}),
  };
  db.state.notified ||= {};
  db.status.sources ||= {};
  const wants = (k) => SOURCES[k].enabled && (!ONLY || ONLY === k);
  log.info(`Inicio corrida${DRY ? ' · DRY-RUN' : ''} · fuentes: ${Object.keys(SOURCES).filter(wants).join(', ')}`);

  const run = { at: nowIso };
  const ctxBase = { db, nowIso, nowMin, now };

  // 1) Minorista primero: sus precios alimentan el margen de reventa del mayorista
  let minData = null;
  if (wants('minorista')) {
    try {
      minData = await readMinorista(db, nowIso);
    } catch (err) {
      log.error(`[minorista] ${err.message}`);
      await noteFailure(db, 'minorista', err);
      run.minorista = { ok: false, error: err.message.slice(0, 200) };
    }
  }

  // 2) Mayorista
  if (wants('mayorista')) {
    try {
      const may = await readMayorista();
      const r = await processSource(SOURCES.mayorista, may.current, { ...ctxBase, warnings: may.warnings });
      if (!DRY) await saveSession(may.session.jar);
      await noteSuccess(db, 'mayorista', r, { sessionSource: may.session.source, seller: config.account.seller, region: config.account.region });
      run.mayorista = { ok: true, products: r.products, changes: r.changes, alerts: r.alerts, sent: r.sent };
    } catch (err) {
      log.error(`[mayorista] ${err.message}`);
      await noteFailure(db, 'mayorista', err);
      run.mayorista = { ok: false, error: err.message.slice(0, 200) };
    }
  }

  // 3) Procesar minorista
  if (minData) {
    try {
      const r = await processSource(SOURCES.minorista, minData.current, { ...ctxBase, warnings: minData.warnings });
      await noteSuccess(db, 'minorista', r, { categories: config.minorista.categories });
      run.minorista = { ok: true, products: r.products, changes: r.changes, alerts: r.alerts, sent: r.sent };
    } catch (err) {
      log.error(`[minorista] ${err.stack || err.message}`);
      await noteFailure(db, 'minorista', err);
      run.minorista = { ok: false, error: err.message.slice(0, 200) };
    }
  }

  const attempted = Object.keys(SOURCES).filter(wants);
  const anyOk = attempted.some((k) => run[k]?.ok);
  run.ok = anyOk;
  run.ms = Date.now() - startedAt;

  // Estado general
  for (const [k, v] of Object.entries(db.state.notified)) if (Date.now() - Date.parse(v.ts) > 30 * 864e5) delete db.state.notified[k];
  const st = db.status;
  for (const k of ['products', 'priceChanges', 'sessionSource', 'warnings', 'seller', 'region', 'lastError', 'lastSuccess', 'ok']) delete st[k]; // formato viejo
  Object.assign(st, {
    updatedAt: nowIso,
    ok: anyOk,
    lastRun: nowIso,
    consecutiveFailures: anyOk ? 0 : (st.consecutiveFailures || 0) + 1,
    channels: channelsConfigured(),
    intervalMinutes: config.intervalMinutes,
  });
  st.runs = [run, ...(st.runs || []).filter((r) => r.mayorista || r.minorista)].slice(0, 96);

  if (!DRY) {
    await writeJson('retail.json', db.retail);
    await writeJson('state.json', db.state);
    await writeJson('status.json', st, { pretty: true });
  }
  log.info(`Fin en ${(run.ms / 1000).toFixed(1)} s · mayorista: ${run.mayorista?.ok ? 'ok' : run.mayorista ? 'falló' : '—'} · minorista: ${run.minorista?.ok ? 'ok' : run.minorista ? 'falló' : '—'}`);
  if (!anyOk) process.exitCode = 1;
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exitCode = 1;
});
