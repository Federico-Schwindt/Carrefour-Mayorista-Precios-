// Configuración central. Todo se puede pisar con variables de entorno
// (en GitHub Actions: Settings → Secrets and variables → Actions).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ajustes.json (en la raíz del repo): ajustes en español que se pueden editar
// desde GitHub. Las variables de entorno, si están, tienen prioridad.
let AJ = {};
try {
  AJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'ajustes.json'), 'utf8'));
} catch {
  AJ = {};
}
const AV = AJ.avisos || {};
const pctOf = (v, def) => (Number.isFinite(Number(v)) ? Number(v) / 100 : def);

const num = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const str = (name, def = '') => (process.env[name] ?? '').trim() || def;
const bool = (name, def) => {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  if (!v) return def;
  return ['1', 'true', 'si', 'sí', 'yes', 'on'].includes(v);
};

export const config = {
  root: ROOT,
  dataDir: path.resolve(ROOT, str('DATA_DIR', 'data')),
  baseUrl: str('BASE_URL', 'https://comerciante.carrefour.com.ar/'),
  retailApi: str('RETAIL_API', 'https://www.carrefour.com.ar/api/catalog_system/pub/products/search'),
  dashboardUrl: str('DASHBOARD_URL'),

  // ---- Sucursal (sólo informativo; la sucursal real la define la sesión) ----
  account: {
    region: str('CF_REGION', 'ENTRE RIOS'),
    seller: str('CF_SELLER', '240'), // 240 = GUALEGUAYCHU - Primera Junta y Ruta 136
    delivery: str('CF_DELIVERY', 'retiro'), // retiro | envio
  },
  // Cookies de sesiones abiertas a mano en el sitio: UNA POR SUCURSAL.
  // Secrets CF_COOKIE, CF_COOKIE_2 … CF_COOKIE_6. Formato "PHPSESSID=xxxx" o sólo "xxxx".
  // La sucursal de cada una se detecta sola.
  cookies: ['CF_COOKIE', 'CF_COOKIE_2', 'CF_COOKIE_3', 'CF_COOKIE_4', 'CF_COOKIE_5', 'CF_COOKIE_6']
    .map((v, i) => ({ var: v, index: i + 1, value: str(v) }))
    .filter((c) => c.value),
  get manualCookie() {
    return this.cookies[0]?.value || '';
  },
  // Clave para cifrar la sesión que se guarda entre ejecuciones.
  sessionSecret: str('SESSION_SECRET'),

  // Secciones del catálogo (se descubren solas del menú; esto es el respaldo).
  fallbackSections: [
    'almacén', 'bazar_y_textil', 'bebidas', 'desayuno_y_merienda', 'limpieza',
    'lácteos_y_productos_frescos', 'mascotas', 'mundo_bebé', 'panadería', 'perfumería',
  ],
  itemsPerPage: num('ITEMS_PER_PAGE', 1000),

  http: {
    timeoutMs: num('HTTP_TIMEOUT_MS', 60000),
    retries: num('HTTP_RETRIES', 4),
    delayBetweenRequestsMs: num('HTTP_DELAY_MS', 1500),
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  },

  // ---- Reglas de alerta (porcentajes en 0..1) ----
  rules: {
    // Baja fuerte respecto del precio anterior
    dropPct: num('ALERT_DROP_PCT', pctOf(AV.baja_fuerte_mayorista_pct, 0.15)),
    // Posible error: precio <= X * referencia (mediana 30 días)
    errorRatio: num('ALERT_ERROR_RATIO', 1 - pctOf(AV.posible_error_pct, 0.5)),
    // Posible error: precio <= X * precio minorista de carrefour.com.ar
    errorRetailRatio: num('ALERT_ERROR_RETAIL_RATIO', 0.45),
    // Posible error: precio <= X * precio de lista (tachado)
    listRatio: num('ALERT_LIST_RATIO', 0.35),
    // Posible error: precio por kg/l/unidad <= X * mediana de su categoría
    unitOutlierRatio: num('ALERT_UNIT_RATIO', 0.3),
    unitOutlierMinGroup: num('ALERT_UNIT_MIN_GROUP', 8),
    // Sólo se compara por kg/l en categorías parejas (percentil 75 / percentil 25 <= X)
    unitMaxSpread: num('ALERT_UNIT_MAX_SPREAD', 3),
    // Mínimo histórico: requiere N días de historial y estar X% bajo la mediana
    minHistoryDays: num('ALERT_MIN_HISTORY_DAYS', 5),
    minVsMedianPct: num('ALERT_MIN_VS_MEDIAN_PCT', 0.08),
    // Reventa: margen bruto vs precio minorista >= X
    resaleMargin: num('ALERT_RESALE_MARGIN', pctOf(AV.margen_reventa_pct, 0.35)),
    // No alertar productos más baratos que esto (ruido)
    minPrice: num('ALERT_MIN_PRICE', 300),
    // Repetir alerta del mismo producto/tipo sólo pasado este tiempo o si baja X% más
    repeatAfterHours: num('ALERT_REPEAT_HOURS', 24),
    repeatIfLowerPct: num('ALERT_REPEAT_LOWER_PCT', 0.03),
  },

  // Guardas anti-falsos-positivos
  guards: {
    // Si se leen menos de X * productos que la vez anterior, la corrida es "parcial"
    minCatalogRatio: num('GUARD_MIN_CATALOG_RATIO', 0.6),
    // Si más de X de los productos bajan fuerte a la vez, se sospecha error de lectura
    maxMassDropRatio: num('GUARD_MAX_MASS_DROP_RATIO', 0.25),
  },

  // ---- MINORISTA: catálogo completo de carrefour.com.ar (público, sin login) ----
  minorista: {
    enabled: bool('MIN_ENABLED', true),
    // Tienda cuyos precios se leen (cada tienda de carrefour.com.ar tiene los suyos).
    // Vacío = precio online general.
    store: process.env.MIN_STORE !== undefined ? str('MIN_STORE') : AJ.minorista_tienda?.id ?? 'carrefourar0240',
    storeName: str('MIN_STORE_NAME', AJ.minorista_tienda?.nombre || 'Hiper Gualeguaychú'),
    // Rubros (id de categoría VTEX). Por defecto: supermercado (sin tecnología).
    // 161 Almacén · 222 Desayuno · 255 Bebidas · 292 Lácteos · 336 Panadería · 347 Congelados
    // 359 Limpieza · 402 Perfumería · 451 Mundo Bebé · 471 Mascotas
    // Otros: 3 Electro y tecnología · 71 Hogar · 605 Juguetería · 635 Automotor · 665 Aire libre
    categories: str('MIN_CATEGORIES', (AJ.minorista_rubros || [161, 222, 255, 292, 336, 347, 359, 402, 451, 471]).join(',')).split(',').map((s) => s.trim()).filter(Boolean),
    concurrency: num('MIN_CONCURRENCY', 3),
    delayMs: num('MIN_DELAY_MS', 250),
    // En minorista hay muchas promos: umbral de "baja fuerte" más alto
    dropPct: num('MIN_ALERT_DROP_PCT', pctOf(AV.baja_fuerte_minorista_pct, 0.3)),
    maxPerRun: num('MIN_NOTIFY_MAX_PER_RUN', 15),
    types: str('MIN_NOTIFY_TYPES', 'error,baja,minimo').split(',').map((s) => s.trim()),
  },

  retail: {
    enabled: bool('RETAIL_ENABLED', true),
    batchPerRun: num('RETAIL_BATCH', 160), // consultas rotativas por corrida
    maxAgeHours: num('RETAIL_MAX_AGE_HOURS', 24),
    concurrency: num('RETAIL_CONCURRENCY', 4),
  },

  notify: {
    telegramToken: str('TELEGRAM_BOT_TOKEN'),
    telegramChatId: str('TELEGRAM_CHAT_ID'),
    ntfyTopic: str('NTFY_TOPIC'),
    ntfyServer: str('NTFY_SERVER', 'https://ntfy.sh'),
    discordWebhook: str('DISCORD_WEBHOOK_URL'),
    maxPerRun: num('NOTIFY_MAX_PER_RUN', Number(AV.maximo_avisos_por_lectura) || 25),
    // Tipos que generan notificación push (el resto sólo aparece en la web)
    types: str('NOTIFY_TYPES', 'error,reventa,baja,minimo').split(',').map((s) => s.trim()),
  },

  // ---- OPORTUNIDADES: señales que NO necesitan historial ----
  opp: {
    // Para aparecer en la pestaña "Oportunidades"
    show: {
      descuento: num('OPP_SHOW_DESCUENTO', 0.3), // vs precio tachado / de lista
      sucursal: num('OPP_SHOW_SUCURSAL', 0.15), // más barato que la mediana de otras sucursales
      reventa: num('OPP_SHOW_REVENTA', 0.35), // margen vs carrefour.com.ar
      bajoMayorista: num('OPP_SHOW_BAJO_MAYORISTA', 0.1), // minorista más barato que Maxi
      kilo: num('OPP_SHOW_KILO', 0.45), // precio por kg/l <= X * mediana de la categoría
      maxDescuento: num('OPP_MAX_DESCUENTO', 0.85), // más que esto = precio de lista dudoso
    },
    // Para mandar aviso push (una sola vez por producto, salvo que baje más)
    notify: {
      descuento: num('OPP_NOTIFY_DESCUENTO', pctOf(AV.oportunidad_descuento_pct, 0.5)), // mayorista vs tachado
      descuentoMinorista: num('OPP_NOTIFY_DESCUENTO_MIN', 0.6), // minorista vs lista (suelen inflarla)
      sucursal: num('OPP_NOTIFY_SUCURSAL', pctOf(AV.oportunidad_entre_sucursales_pct, 0.35)),
      reventa: num('OPP_NOTIFY_REVENTA', 1.5),
      bajoMayorista: num('OPP_NOTIFY_BAJO_MAYORISTA', pctOf(AV.oportunidad_minorista_mas_barato_pct, 0.4)),
      // Comparar por kg entre marcas distintas da falsas alarmas: sólo en la web (0 = sin aviso)
      kilo: num('OPP_NOTIFY_KILO', 0),
    },
    // Si aparecen más de X oportunidades fuertes nuevas juntas en una fuente
    // (primera vez, sucursal nueva, cambio general), se manda UN resumen.
    surge: num('OPP_SURGE', 12),
    enabled: bool('OPP_NOTIFY', true),
    maxPerRun: num('OPP_NOTIFY_MAX_PER_RUN', 10),
    repeatDays: num('OPP_REPEAT_DAYS', 7),
    keep: num('OPP_KEEP', 1500),
  },

  // ---- Productos que no se siguen (caros o que no interesan) ----
  filters: {
    maxUnitPrice: num('MAX_UNIT_PRICE', Number(AJ.precio_maximo_por_unidad) || 40000),
    excludeWords: (process.env.EXCLUDE_WORDS ? process.env.EXCLUDE_WORDS.split(',') : AJ.excluir_si_contiene || []).map((w) => w.trim()).filter(Boolean),
  },
  ajustesFile: path.join(ROOT, 'ajustes.json'),
  promosFile: path.join(ROOT, 'promos.json'),

  historyKeepDays: num('HISTORY_KEEP_DAYS', 400),
  alertsKeep: num('ALERTS_KEEP', 1500),
  intervalMinutes: num('INTERVAL_MINUTES', 30),
};
