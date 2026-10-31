// Una corrida completa: sesión → catálogo → minorista → detección → avisos → guardar.
// Uso:  node src/run.js            (corrida normal)
//       node src/run.js --dry-run  (no notifica ni guarda)
//       node src/run.js --login-only
import { config } from './config.js';
import { getSession } from './session.js';
import { fetchCatalog } from './catalog.js';
import { refreshRetail } from './retail.js';
import { detectAll, appendHistory, shouldNotify, effectivePrice, round2 } from './detect.js';
import { notifyAlert, notifySystem, channelsConfigured } from './notify.js';
import { loadAll, writeJson, toMin } from './store.js';
import { log } from './log.js';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');

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
    ...(p.promoMinQty ? { q: p.promoMinQty } : {}),
    ...(p.listPrice ? { lp: round2(p.listPrice) } : {}),
    ...(p.promo ? { pr: p.promo } : {}),
    ...(p.onSale ? { o: 1 } : {}),
    f: prevItem?.f || nowIso, // primera vez visto
    l: nowIso, // última vez visto
  };
}

async function recordFailure(db, err, startedAt) {
  const status = db.status || { runs: [] };
  status.consecutiveFailures = (status.consecutiveFailures || 0) + 1;
  status.lastRun = new Date().toISOString();
  status.ok = false;
  status.lastError = err.message;
  status.runs = [{ at: status.lastRun, ok: false, error: err.message.slice(0, 300), ms: Date.now() - startedAt }, ...(status.runs || [])].slice(0, 96);
  if (!DRY) await writeJson('status.json', status, { pretty: true });

  // Aviso de falla: a la 2ª falla seguida y luego cada ~6 h
  const state = db.state;
  const lastWarn = state.lastFailureNoticeAt ? Date.parse(state.lastFailureNoticeAt) : 0;
  if (!DRY && status.consecutiveFailures >= 2 && Date.now() - lastWarn > 6 * 3600e3) {
    const hint = err.code === 'NO_SESSION' ? '\nRevisá los secrets CF_* o pegá una cookie nueva en CF_COOKIE.' : '';
    await notifySystem('El monitor no pudo leer precios', `${err.message.slice(0, 600)}${hint}`);
    state.lastFailureNoticeAt = new Date().toISOString();
    await writeJson('state.json', state);
  }
}

async function main() {
  const startedAt = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();
  const nowMin = toMin(now);
  const db = await loadAll();
  const { rules, guards } = config;

  log.info(`Inicio corrida · sucursal ${config.account.seller} (${config.account.region})${DRY ? ' · DRY-RUN' : ''}`);

  // 1) Sesión
  let session;
  try {
    session = await getSession({ forceLogin: args.has('--force-login') });
    log.info(`Sesión: ${session.source}`);
  } catch (err) {
    log.error(err.message);
    await recordFailure(db, err, startedAt);
    process.exitCode = 1;
    return;
  }
  if (args.has('--login-only')) return;

  // 2) Catálogo
  let catalog;
  try {
    catalog = await fetchCatalog(session.jar);
  } catch (err) {
    log.error(`Catálogo: ${err.message}`);
    await recordFailure(db, err, startedAt);
    process.exitCode = 1;
    return;
  }
  const current = new Map([...catalog.products].filter(([, p]) => p.price));
  log.info(`Catálogo: ${catalog.products.size} productos, ${current.size} con precio, ${catalog.failed.length} secciones fallidas.`);

  if (current.size < Math.max(50, catalog.products.size * 0.3)) {
    const err = new Error(`Sólo ${current.size}/${catalog.products.size} productos con precio: la sesión no tiene sucursal o el sitio cambió.`);
    err.code = 'NO_SESSION';
    await recordFailure(db, err, startedAt);
    process.exitCode = 1;
    return;
  }

  const prevItems = db.products?.items ? Object.fromEntries(db.products.items.map((i) => [i.ean, i])) : null;
  const prevCount = db.products?.items?.length || 0;
  const partial = prevCount > 0 && current.size < prevCount * guards.minCatalogRatio;
  const warnings = [];
  if (partial) warnings.push(`Lectura parcial: ${current.size} de ~${prevCount} productos.`);
  if (catalog.failed.length) warnings.push(`Secciones con error: ${catalog.failed.join(', ')}`);

  // 3) Candidatos rápidos (bajas vs. último precio) → se priorizan en la consulta minorista
  const priority = [];
  for (const p of current.values()) {
    const s = db.history[p.ean];
    const prev = s?.length ? s[s.length - 1][1] : null;
    const eff = effectivePrice(p);
    if (!prev || eff < prev * 0.97) priority.push(p.ean);
  }
  const beforeRetail = new Set(Object.keys(db.retail).filter((e) => db.retail[e]?.price));
  const retailInfo = await refreshRetail(db.retail, current, prevItems ? priority.slice(0, 300) : []);
  const retailFresh = new Set(Object.keys(db.retail).filter((e) => db.retail[e]?.price && !beforeRetail.has(e)));
  log.info(`Minorista: ${retailInfo.checked ?? 0} consultados${retailInfo.errors ? `, ${retailInfo.errors} errores` : ''}.`);

  // 4) Detección
  const det = detectAll({ current, prevSnapshot: prevItems, history: db.history, retail: db.retail, rules, nowMin, retailFreshSet: retailFresh });
  const suspicious = det.compared > 50 && det.massDropRatio > guards.maxMassDropRatio;
  if (det.baseline) warnings.push('Primera corrida: se guarda la base de precios, las alertas empiezan en la próxima.');
  if (suspicious) warnings.push(`${Math.round(det.massDropRatio * 100)}% de los productos "bajó" a la vez: se sospecha error de lectura, no se notifica.`);

  // 5) Armar alertas + notificar
  const newAlerts = det.found
    .map(({ product: p, type, types, reasons, metrics: m }) => {
      const r = db.retail[p.ean];
      return {
        id: `${p.ean}-${nowMin}`,
        ts: nowIso,
        ean: p.ean,
        type,
        types,
        name: p.name,
        sector: p.sector,
        section: p.section,
        category: p.category,
        price: round2(m.price),
        basePrice: round2(p.price),
        prev: m.prev ?? null,
        ref: m.ref ? round2(m.ref) : null,
        min: m.min ?? null,
        dropPct: m.dropPct !== undefined ? round2(m.dropPct) : null,
        retail: r?.price ?? null,
        retailUrl: r?.url ?? null,
        margin: m.margin !== undefined ? round2(m.margin) : null,
        promo: p.promo || null,
        minQty: p.promoMinQty || null,
        reasons,
        suppressed: suspicious || undefined,
      };
    })
    .sort((a, b) => rank(b) - rank(a));

  const ch = channelsConfigured();
  const anyChannel = ch.telegram || ch.ntfy || ch.discord;
  let sent = 0;
  let skipped = 0;
  if (!DRY && anyChannel && !suspicious) {
    for (const a of newAlerts) {
      if (!config.notify.types.includes(a.type)) continue;
      if (!shouldNotify(db.state, a.ean, a.type, a.price, now.getTime(), rules)) continue;
      if (sent >= config.notify.maxPerRun) {
        skipped++;
        continue;
      }
      if (await notifyAlert(a)) {
        a.notified = true;
        sent++;
        db.state.notified[`${a.ean}:${a.type}`] = { ts: nowIso, price: a.price };
      }
    }
    if (skipped) await notifySystem('Más alertas', `Hay ${skipped} alertas más en esta corrida. Miralas en la web${config.dashboardUrl ? `: ${config.dashboardUrl}` : ''}.`);
  }
  log.info(`Alertas: ${newAlerts.length} detectadas, ${sent} notificadas${skipped ? `, ${skipped} sin enviar (límite)` : ''}.`);
  for (const a of newAlerts.slice(0, 15)) log.info(`  [${a.type}] ${a.name} → $${a.price} · ${a.reasons.join(' / ')}`);

  if (DRY) {
    log.info('DRY-RUN: no se guarda nada.');
    return;
  }

  // 6) Guardar
  const changes = appendHistory(db.history, current, nowMin, config.historyKeepDays);
  const items = [];
  for (const p of current.values()) items.push(compactProduct(p, prevItems?.[p.ean], nowIso));
  // Mantener (marcados como no vistos) los productos que hoy no aparecieron, por 7 días
  if (prevItems) {
    for (const [ean, it] of Object.entries(prevItems)) {
      if (!current.has(ean) && Date.now() - Date.parse(it.l) < 7 * 864e5) items.push(it);
    }
  }
  items.sort((a, b) => a.n.localeCompare(b.n, 'es'));

  const alerts = [...newAlerts, ...(db.alerts.alerts || [])].slice(0, config.alertsKeep);

  // podar notificaciones viejas del estado
  for (const [k, v] of Object.entries(db.state.notified || {})) if (Date.now() - Date.parse(v.ts) > 30 * 864e5) delete db.state.notified[k];
  db.state.consecutiveFailures = 0;
  if (db.state.lastFailureNoticeAt && (db.status?.consecutiveFailures || 0) >= 2) {
    await notifySystem('Monitor recuperado', `Volvió a leer precios: ${current.size} productos.`);
  }
  db.state.lastFailureNoticeAt = null;

  const status = db.status || { runs: [] };
  const ms = Date.now() - startedAt;
  Object.assign(status, {
    ok: true,
    lastRun: nowIso,
    lastSuccess: nowIso,
    lastError: null,
    consecutiveFailures: 0,
    products: current.size,
    priceChanges: changes,
    sessionSource: session.source,
    warnings,
    seller: config.account.seller,
    region: config.account.region,
    channels: ch,
    intervalMinutes: config.intervalMinutes,
  });
  status.runs = [{ at: nowIso, ok: true, products: current.size, changes, alerts: newAlerts.length, sent, ms, warnings: warnings.length ? warnings : undefined }, ...(status.runs || [])].slice(0, 96);

  await writeJson('history.json', db.history);
  await writeJson('products.json', { updatedAt: nowIso, seller: config.account.seller, region: config.account.region, count: items.length, items });
  await writeJson('alerts.json', { updatedAt: nowIso, alerts });
  await writeJson('retail.json', db.retail);
  await writeJson('state.json', db.state);
  await writeJson('status.json', status, { pretty: true });
  log.info(`Listo en ${(ms / 1000).toFixed(1)} s · ${changes} cambios de precio · ${warnings.length ? 'avisos: ' + warnings.join(' | ') : 'sin avisos'}`);
}

const RANK = { error: 5, reventa: 4, baja: 3, minimo: 2 };
const rank = (a) => (RANK[a.type] || 0) * 10 + (a.dropPct || 0) + (a.margin || 0) / 10;

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exitCode = 1;
});
