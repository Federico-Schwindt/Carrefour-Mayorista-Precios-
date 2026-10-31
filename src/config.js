// Configuración central. Todo se puede pisar con variables de entorno
// (en GitHub Actions: Settings → Secrets and variables → Actions).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

  // ---- Cuenta / sucursal (van como SECRETS, nunca en el código) ----
  account: {
    name: str('CF_NAME'),
    numberId: str('CF_CUIT'),
    phone: str('CF_PHONE'),
    email: str('CF_EMAIL'),
    region: str('CF_REGION', 'ENTRE RIOS'),
    seller: str('CF_SELLER', '240'), // 240 = GUALEGUAYCHU - Primera Junta y Ruta 136
    delivery: str('CF_DELIVERY', 'retiro'), // retiro | envio
  },
  // Cookie de sesión pegada a mano (alternativa al login automático).
  // Formato: "PHPSESSID=xxxx" o "PHPSESSID=xxxx; otra=yyy"
  manualCookie: str('CF_COOKIE'),
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
    dropPct: num('ALERT_DROP_PCT', 0.15),
    // Posible error: precio <= X * referencia (mediana 30 días)
    errorRatio: num('ALERT_ERROR_RATIO', 0.5),
    // Posible error: precio <= X * precio minorista de carrefour.com.ar
    errorRetailRatio: num('ALERT_ERROR_RETAIL_RATIO', 0.45),
    // Posible error: precio por kg/l/unidad <= X * mediana de su categoría
    unitOutlierRatio: num('ALERT_UNIT_RATIO', 0.3),
    unitOutlierMinGroup: num('ALERT_UNIT_MIN_GROUP', 6),
    // Mínimo histórico: requiere N días de historial y estar X% bajo la mediana
    minHistoryDays: num('ALERT_MIN_HISTORY_DAYS', 5),
    minVsMedianPct: num('ALERT_MIN_VS_MEDIAN_PCT', 0.08),
    // Reventa: margen bruto vs precio minorista >= X
    resaleMargin: num('ALERT_RESALE_MARGIN', 0.35),
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
    maxPerRun: num('NOTIFY_MAX_PER_RUN', 25),
    // Tipos que generan notificación push (el resto sólo aparece en la web)
    types: str('NOTIFY_TYPES', 'error,reventa,baja,minimo').split(',').map((s) => s.trim()),
  },

  historyKeepDays: num('HISTORY_KEEP_DAYS', 400),
  alertsKeep: num('ALERTS_KEEP', 1500),
  intervalMinutes: num('INTERVAL_MINUTES', 30),
};

export function hasCredentials() {
  const a = config.account;
  return Boolean(a.name && a.numberId && a.phone && a.email && a.region && a.seller);
}
