// Una corrida completa con fuentes INDEPENDIENTES:
//   🏪 MAYORISTA  comerciante.carrefour.com.ar — una por sucursal (una cookie por sucursal)
//   🛒 MINORISTA  www.carrefour.com.ar (API pública, sin login)
// Si una falla, las otras siguen. Cada una guarda sus propios archivos y alertas.
// Además calcula OPORTUNIDADES que no necesitan historial (descuento vs tachado,
// diferencia entre sucursales, vs minorista, precio por kg).
//
// Uso:  node src/run.js                 (corrida normal)
//       node src/run.js --only=minorista (o --only=mayorista)
//       node src/run.js --dry-run       (no notifica ni guarda)
//       node src/run.js --check         (sólo verifica las sesiones)
//       node src/run.js --login         (ingreso asistido en un navegador visible)
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { getSessions, interactiveLogin, saveSession } from './session.js';
import { fetchCatalog } from './catalog.js';
import { fetchRetailCatalog } from './retail-catalog.js';
import { refreshRetail } from './retail.js';
import { detectAll, appendHistory, shouldNotify, effectivePrice, round2, findOpportunities, OPP_LABEL } from './detect.js';
import { notifyAlert, notifySystem, channelsConfigured } from './notify.js';
import { readJson, writeJson, toMin } from './store.js';
import { log } from './log.js';

const argv = process.argv.slice(2);
const args = new Set(argv);
const DRY = args.has('--dry-run');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

const MINORISTA = {
  id: 'min',
  kind: 'minorista',
  name: 'carrefour.com.ar',
  label: '🛒 MINORISTA · carrefour.com.ar',
  files: { products: 'min-products.json', history: 'min-history.json', alerts: 'min-alerts.json' },
  statePrefix: 'min:',
  rules: { ...config.rules, dropPct: config.minorista.dropPct, unitMultipack: true },
  notifyTypes: config.minorista.types,
  maxPerRun: config.minorista.maxPerRun,
};

function branchSource(branch) {
  const slug = branch.slug;
  return {
    id: `may-${slug}`,
    kind: 'mayorista',
    name: branch.name,
    slug,
    label: `🏪 MAYORISTA · Maxi ${branch.name}`,
    files: { products: `may-${slug}-products.json`, history: `may-${slug}-history.json`, alerts: `may-${slug}-alerts.json` },
    statePrefix: `${slug}:`,
    // En Maxi el precio es por unidad aunque diga "12 x 90 grs"
    rules: { ...config.rules, unitMultipack: false },
    notifyTypes: config.notify.types,
    maxPerRun: config.notify.maxPerRun,
  };
}

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

const RANK = { error: 5, oportunidad: 4.5, reventa: 4, baja: 3, minimo: 2 };
const rank = (a) => (RANK[a.type] || 0) * 10 + (a.dropPct || 0) + (a.margin || 0) / 10;

const exists = (f) => fs.access(path.join(config.dataDir, f)).then(() => true, () => false);

/** Los datos viejos (products.json, history.json, alerts.json) eran de la cookie principal. */
async function migrateLegacy(src) {
  if (!(await exists('products.json')) || (await exists(src.files.products))) return false;
  for (const [oldName, newName] of [['products.json', src.files.products], ['history.json', src.files.history], ['alerts.json', src.files.alerts]]) {
    if (await exists(oldName)) await fs.rename(path.join(config.dataDir, oldName), path.join(config.dataDir, newName));
  }
  log.info(`Datos anteriores migrados a la sucursal ${src.name}.`);
  return true;
}

function toAlert(src, p, { type, types, reasons, metrics: m }, retail, ts, nowMin) {
  return {
    id: `${src.statePrefix}${p.ean}-${nowMin}-${type}`,
    source: src.kind,
    sourceId: src.id,
    branch: src.kind === 'mayorista' ? src.name : null,
    ts,
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
    retail: retail?.price ?? null,
    retailUrl: retail?.url ?? null,
    margin: m.margin !== undefined ? round2(m.margin) : null,
    promo: p.promo || null,
    minQty: p.minQty || null,
    url: p.url || null,
    image: p.image || null,
    seller: p.seller || null,
    reasons,
  };
}

/** Detección con historial + avisos + guardado para una fuente que ya leyó su catálogo. */
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

  const isMay = src.kind === 'mayorista';
  let retailFresh = new Set();
  if (isMay && !ctx.retailRefreshed) {
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
    ctx.retailRefreshed = true;
    log.info(`[${src.id}] precios minoristas consultados: ${info.checked ?? 0}${info.errors ? `, ${info.errors} errores` : ''}.`);
  }

  const det = detectAll({ current, prevSnapshot: prevItems, history, retail: isMay ? db.retail : {}, rules: src.rules, nowMin, retailFreshSet: retailFresh });
  const suspicious = det.compared > 50 && det.massDropRatio > config.guards.maxMassDropRatio;
  if (det.baseline) warnings.push('Primera lectura: se guarda la base de precios. Mientras tanto mirá la pestaña Oportunidades.');
  if (suspicious) warnings.push(`${Math.round(det.massDropRatio * 100)}% de los productos "bajó" a la vez: se sospecha error de lectura, no se notifica.`);

  const newAlerts = det.found
    .map((f) => ({ ...toAlert(src, f.product, f, isMay ? db.retail[f.product.ean] : null, nowIso, nowMin), suppressed: suspicious || undefined }))
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
    if (skipped) await notifySystem(`Más alertas · ${src.label}`, `Hay ${skipped} alertas más. Miralas en la web${config.dashboardUrl ? `: ${config.dashboardUrl}` : ''}.`);
  }
  log.info(`[${src.id}] alertas: ${newAlerts.length} detectadas, ${sent} notificadas${skipped ? `, ${skipped} sin enviar (límite)` : ''}.`);
  for (const a of newAlerts.slice(0, 8)) log.info(`  [${a.type}] ${a.name} → $${a.price} · ${a.reasons.join(' / ')}`);

  if (DRY) return { products: current.size, changes: 0, alerts: newAlerts.length, sent, warnings };

  const changes = appendHistory(history, current, nowMin, config.historyKeepDays);
  const items = [];
  for (const p of current.values()) items.push(compactProduct(p, prevItems?.[p.ean], nowIso));
  if (prevItems) {
    // Productos que hoy no aparecieron (sin stock): se muestran 7 días como "no visto",
    // salvo que sean de una sección que ya no se lee (ej. se sacó Tecnología)
    const sectors = new Set([...current.values()].map((p) => p.sector));
    for (const [ean, it] of Object.entries(prevItems)) {
      if (!current.has(ean) && sectors.has(it.s) && Date.now() - Date.parse(it.l) < 7 * 864e5) items.push(it);
    }
  }
  items.sort((a, b) => a.n.localeCompare(b.n, 'es'));
  const meta = isMay ? { branch: src.name } : { categories: config.minorista.categories };
  await writeJson(src.files.history, history);
  await writeJson(src.files.products, { updatedAt: nowIso, source: src.kind, sourceId: src.id, ...meta, count: items.length, items });
  await writeJson(src.files.alerts, { updatedAt: nowIso, source: src.kind, sourceId: src.id, alerts: [...newAlerts, ...(prevAlerts.alerts || [])].slice(0, config.alertsKeep) });
  return { products: current.size, changes, alerts: newAlerts.length, sent, warnings };
}

/** Lee el catálogo de una sucursal mayorista. */
async function readBranch(session) {
  const catalog = await fetchCatalog(session.jar);
  const current = new Map([...catalog.products].filter(([, p]) => p.price));
  log.info(`[may-${session.branch.slug}] ${catalog.products.size} productos, ${current.size} con precio.`);
  if (current.size < Math.max(50, catalog.products.size * 0.3)) {
    const err = new Error(`${session.var} (${session.branch.name}): sólo ${current.size}/${catalog.products.size} productos con precio. La sesión perdió la sucursal o el sitio cambió.`);
    err.code = 'NO_SESSION';
    throw err;
  }
  const warnings = catalog.failed.length ? [`Secciones con error: ${catalog.failed.join(', ')}`] : [];
  return { current, warnings };
}

/** Lee el catálogo minorista (público). */
async function readMinorista(db, nowIso) {
  const catalog = await fetchRetailCatalog();
  const current = catalog.products;
  log.info(`[min] ${current.size} productos con stock.`);
  if (current.size < 200) throw new Error(`Sólo ${current.size} productos minoristas: la API pública cambió o falló.`);
  // Reaprovechamos estos precios para el margen de reventa del mayorista
  for (const p of current.values()) {
    if (!p.realEan || p.seller) continue; // sólo vendidos por Carrefour
    db.retail[p.realEan] = { found: true, available: true, price: p.price, listPrice: p.listPrice, name: p.name, url: p.url, ts: nowIso };
  }
  const warnings = catalog.failed.length ? [`Subcategorías con error: ${catalog.failed.slice(0, 8).join(', ')}${catalog.failed.length > 8 ? '…' : ''}`] : [];
  return { current, warnings };
}

async function noteFailure(db, id, label, err) {
  const st = db.status.sources[id] || (db.status.sources[id] = {});
  st.ok = false;
  st.lastRun = new Date().toISOString();
  st.lastError = err.message;
  st.consecutiveFailures = (st.consecutiveFailures || 0) + 1;
  const notices = (db.state.failNotice ||= {});
  const last = notices[id] ? Date.parse(notices[id]) : 0;
  const threshold = err.code === 'NO_SESSION' ? 1 : 2;
  if (!DRY && st.consecutiveFailures >= threshold && Date.now() - last > 6 * 3600e3) {
    const title = err.code === 'NO_SESSION' ? `${label}: se venció la sesión` : `${label}: no se pudieron leer precios`;
    await notifySystem(title, err.message.slice(0, 700));
    notices[id] = new Date().toISOString();
  }
}

async function noteSuccess(db, src, result, extra = {}) {
  const st = db.status.sources[src.id] || (db.status.sources[src.id] = {});
  const notices = (db.state.failNotice ||= {});
  if (!DRY && notices[src.id] && (st.consecutiveFailures || 0) >= 1) {
    await notifySystem(`${src.label}: recuperado`, `Volvió a leer precios: ${result.products} productos.`);
  }
  delete notices[src.id];
  Object.assign(st, {
    kind: src.kind,
    name: src.name,
    label: src.label,
    ok: true,
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

/** Oportunidades sin historial: ranking + avisos fuertes (una vez por producto). */
async function processOpportunities(datasets, ctx) {
  const { db, nowIso, now } = ctx;
  const items = findOpportunities({ datasets, retail: db.retail, opp: config.opp, rules: config.rules });
  const bySource = {};
  for (const it of items) bySource[it.sourceId] = (bySource[it.sourceId] || 0) + 1;
  log.info(`Oportunidades: ${items.length} (${Object.entries(bySource).map(([k, v]) => `${k}: ${v}`).join(', ')}).`);

  const ch = channelsConfigured();
  const toNotify = items.filter((it) => it.strong.length);
  let sent = 0;
  let pending = 0;
  let summarized = 0;
  const notifiedAlerts = {};
  const arsTxt = (n) => `$${Math.round(n).toLocaleString('es-AR')}`;
  const toOppAlert = (it) => ({
    id: `opp-${it.sourceId}-${it.ean}-${toMin(now)}`,
    source: it.kind,
    sourceId: it.sourceId,
    branch: it.branch,
    ts: nowIso,
    ean: it.ean,
    type: 'oportunidad',
    types: ['oportunidad'],
    signals: it.signals,
    name: it.name,
    sector: it.sector,
    category: it.category,
    price: it.price,
    listPrice: it.listPrice,
    retail: it.refs.retail ?? null,
    retailUrl: it.refs.retailUrl ?? null,
    margin: it.signals.reventa ?? null,
    minQty: it.minQty,
    promo: it.promo,
    url: it.url,
    image: it.image,
    reasons: it.reasons,
  });
  if (!DRY && config.opp.enabled && (ch.telegram || ch.ntfy || ch.discord)) {
    const isFresh = (it) => {
      const last = db.state.notified[`opp:${it.sourceId}:${it.ean}`];
      return !last || it.price <= last.price * (1 - config.rules.repeatIfLowerPct) || Date.now() - Date.parse(last.ts) > config.opp.repeatDays * 864e5;
    };
    const mark = (it) => (db.state.notified[`opp:${it.sourceId}:${it.ean}`] = { ts: nowIso, price: it.price });
    const freshBySource = new Map();
    for (const it of toNotify.filter(isFresh)) {
      if (!freshBySource.has(it.sourceId)) freshBySource.set(it.sourceId, []);
      freshBySource.get(it.sourceId).push(it);
    }
    for (const [sid, list] of freshBySource) {
      const src = ctx.sourcesById[sid];
      if (list.length > config.opp.surge) {
        // Muchas juntas (primera lectura, sucursal nueva…): un solo resumen en vez de una lluvia de avisos
        const top = list.slice(0, 6);
        await notifySystem(
          `🔥 ${src.label}: ${list.length} oportunidades`,
          `Encontré ${list.length} productos muy baratos. Los mejores:\n${top.map((it) => `• ${it.name} — ${arsTxt(it.price)} (${it.reasons[0]})`).join('\n')}\n\nEstán todos en la pestaña 🔥 Oportunidades${config.dashboardUrl ? `: ${config.dashboardUrl}` : ''}. Desde ahora te aviso sólo las nuevas.`,
        );
        for (const it of list) mark(it);
        notifiedAlerts[sid] = [...(notifiedAlerts[sid] || []), ...top.map((it) => ({ ...toOppAlert(it), notified: true, summary: true }))];
        summarized += list.length;
        continue;
      }
      for (const it of list) {
        if (sent >= config.opp.maxPerRun) {
          pending++;
          continue;
        }
        const alert = toOppAlert(it);
        if (await notifyAlert(alert)) {
          alert.notified = true;
          sent++;
          mark(it);
          (notifiedAlerts[sid] ||= []).push(alert);
        }
      }
    }
    if (pending) await notifySystem('Más oportunidades', `Hay ${pending} oportunidades fuertes más; te las mando en la próxima lectura. También están en la pestaña 🔥 Oportunidades${config.dashboardUrl ? `: ${config.dashboardUrl}` : ''}.`);
  }
  log.info(`Oportunidades fuertes: ${toNotify.length}, avisadas ahora: ${sent}${summarized ? `, en resumen: ${summarized}` : ''}${pending ? `, pendientes: ${pending}` : ''}.`);

  if (DRY) return { total: items.length, strong: toNotify.length, sent };
  // Las avisadas también quedan en el historial de alertas de su fuente
  for (const [sid, list] of Object.entries(notifiedAlerts)) {
    const src = ctx.sourcesById[sid];
    const prev = await readJson(src.files.alerts, { alerts: [] });
    await writeJson(src.files.alerts, { ...prev, alerts: [...list, ...(prev.alerts || [])].slice(0, config.alertsKeep) });
  }
  const slim = items.slice(0, config.opp.keep).map((it) => ({ ...it, url: it.url ? slimUrl(it.url) : null, image: it.image ? slimImg(it.image) : null }));
  await writeJson('oportunidades.json', { updatedAt: nowIso, labels: OPP_LABEL, count: items.length, items: slim });
  return { total: items.length, strong: toNotify.length, sent };
}

async function main() {
  const startedAt = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();
  const nowMin = toMin(now);

  if (args.has('--login')) {
    const jar = await interactiveLogin();
    log.info('¡Listo! Sesión con precios. Pegá esta línea en el secret (CF_COOKIE, CF_COOKIE_2, …) de GitHub:');
    console.log(`\n${jar.header()}\n`);
    return;
  }
  if (args.has('--check')) {
    for (const s of await getSessions()) log.info(`${s.var}: ${s.ok ? `OK · ${s.branch.name}` : s.error.message}`);
    return;
  }

  const db = {
    retail: await readJson('retail.json', {}),
    state: await readJson('state.json', { notified: {} }),
    status: await readJson('status.json', {}),
  };
  db.state.notified ||= {};
  db.status.sources ||= {};
  // formato viejo: sources.mayorista / sources.minorista
  if (db.status.sources.mayorista) delete db.status.sources.mayorista;
  if (db.status.sources.minorista) {
    db.status.sources.min = db.status.sources.minorista;
    delete db.status.sources.minorista;
  }
  db.state.cookieBranch ||= {};
  const wantMay = !ONLY || ONLY === 'mayorista';
  const wantMin = config.minorista.enabled && (!ONLY || ONLY === 'minorista');
  log.info(`Inicio corrida${DRY ? ' · DRY-RUN' : ''} · cookies mayoristas: ${config.cookies.length} · minorista: ${wantMin ? 'sí' : 'no'}`);

  const run = { at: nowIso, results: {} };
  const ctx = { db, nowIso, nowMin, now, sourcesById: { min: MINORISTA } };
  const datasets = [];

  // 1) Minorista primero: sus precios alimentan el margen de reventa del mayorista
  let minData = null;
  if (wantMin) {
    try {
      minData = await readMinorista(db, nowIso);
    } catch (err) {
      log.error(`[min] ${err.message}`);
      await noteFailure(db, 'min', MINORISTA.label, err);
      run.results.min = { ok: false, error: err.message.slice(0, 200) };
    }
  }

  // 2) Mayorista: una sesión por sucursal
  const cookieStatus = [];
  if (wantMay) {
    if (!config.cookies.length) {
      const err = new Error('No hay ninguna cookie mayorista cargada (secret CF_COOKIE).');
      err.code = 'NO_SESSION';
      await noteFailure(db, 'may', '🏪 MAYORISTA', err);
      run.results.may = { ok: false, error: err.message };
      cookieStatus.push({ var: 'CF_COOKIE', ok: false, error: err.message });
    }
    else delete db.status.sources.may;
    const sessions = await getSessions();
    for (const s of sessions) {
      const known = db.state.cookieBranch[s.var];
      if (!s.ok) {
        const name = known?.name || s.var;
        const id = known ? `may-${known.slug}` : `cookie-${s.index}`;
        log.error(`[${id}] ${s.error.message}`);
        await noteFailure(db, id, `🏪 MAYORISTA · ${name}`, s.error);
        run.results[id] = { ok: false, error: s.error.message.slice(0, 200) };
        cookieStatus.push({ var: s.var, ok: false, branch: known?.name || null, error: s.error.message });
        continue;
      }
      const src = branchSource(s.branch);
      ctx.sourcesById[src.id] = src;
      db.state.cookieBranch[s.var] = { name: s.branch.name, slug: s.branch.slug };
      delete db.status.sources[`cookie-${s.index}`];
      cookieStatus.push({ var: s.var, ok: true, branch: s.branch.name, source: s.source });
      try {
        if (s.index === 1 && !DRY) await migrateLegacy(src);
        const may = await readBranch(s);
        datasets.push({ src, current: may.current, warnings: may.warnings, session: s });
      } catch (err) {
        log.error(`[${src.id}] ${err.message}`);
        await noteFailure(db, src.id, src.label, err);
        run.results[src.id] = { ok: false, error: err.message.slice(0, 200) };
      }
    }
  }
  if (minData) datasets.push({ src: MINORISTA, current: minData.current, warnings: minData.warnings });

  // 3) Procesar cada fuente (historial, alertas, guardado)
  for (const d of datasets) {
    try {
      const r = await processSource(d.src, d.current, { ...ctx, warnings: d.warnings, retailRefreshed: ctx.retailRefreshed });
      if (d.src.kind === 'mayorista') ctx.retailRefreshed = true;
      if (d.session && !DRY) await saveSession(d.session.jar, d.session.index, config.cookies.find((c) => c.var === d.session.var)?.value);
      await noteSuccess(db, d.src, r, d.session ? { cookieVar: d.session.var, sessionSource: d.session.source } : { categories: config.minorista.categories });
      run.results[d.src.id] = { ok: true, products: r.products, changes: r.changes, alerts: r.alerts, sent: r.sent };
    } catch (err) {
      log.error(`[${d.src.id}] ${err.stack || err.message}`);
      await noteFailure(db, d.src.id, d.src.label, err);
      run.results[d.src.id] = { ok: false, error: err.message.slice(0, 200) };
      d.failed = true;
    }
  }

  // 4) Oportunidades sin historial (con todo lo que se leyó bien)
  const good = datasets.filter((d) => !d.failed);
  if (good.length) {
    try {
      run.opp = await processOpportunities(good, ctx);
    } catch (err) {
      log.error(`Oportunidades: ${err.stack || err.message}`);
    }
  }

  // 5) Índice de fuentes para la web (incluye sucursales con datos viejos)
  const prevManifest = await readJson('sources.json', { sources: [] });
  const manifest = new Map((prevManifest.sources || []).map((s) => [s.id, s]));
  for (const d of good) {
    manifest.set(d.src.id, { id: d.src.id, kind: d.src.kind, name: d.src.name, files: d.src.files, updatedAt: nowIso, products: d.current.size });
  }
  for (const [id, s] of manifest) if (!(await exists(s.files.products))) manifest.delete(id);
  const sources = [...manifest.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'es') : a.kind === 'mayorista' ? -1 : 1));

  const attempted = Object.keys(run.results).length;
  const anyOk = Object.values(run.results).some((r) => r.ok);
  run.ok = anyOk;
  run.ms = Date.now() - startedAt;

  for (const [k, v] of Object.entries(db.state.notified)) if (Date.now() - Date.parse(v.ts) > 30 * 864e5) delete db.state.notified[k];
  const st = db.status;
  for (const k of ['products', 'priceChanges', 'sessionSource', 'warnings', 'seller', 'region', 'lastError', 'lastSuccess']) delete st[k];
  Object.assign(st, {
    updatedAt: nowIso,
    ok: anyOk,
    lastRun: nowIso,
    consecutiveFailures: anyOk ? 0 : (st.consecutiveFailures || 0) + 1,
    channels: channelsConfigured(),
    intervalMinutes: config.intervalMinutes,
    cookies: cookieStatus,
    opportunities: run.opp || null,
  });
  st.runs = [run, ...(st.runs || []).filter((r) => r.results)].slice(0, 96);

  if (!DRY) {
    await writeJson('retail.json', db.retail);
    await writeJson('state.json', db.state);
    await writeJson('sources.json', { updatedAt: nowIso, sources });
    await writeJson('status.json', st, { pretty: true });
  }
  const summary = Object.entries(run.results).map(([k, r]) => `${k}: ${r.ok ? 'ok' : 'falló'}`).join(' · ');
  log.info(`Fin en ${(run.ms / 1000).toFixed(1)} s · ${summary || 'nada para hacer'}`);
  if (attempted && !anyOk) process.exitCode = 1;
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exitCode = 1;
});
