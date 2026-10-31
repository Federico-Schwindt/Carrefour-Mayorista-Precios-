// Manejo de sesión: el sitio sólo muestra precios con una sucursal elegida
// (sesión PHP creada por el formulario de ingreso, que tiene reCAPTCHA).
//
// El ingreso lo hace SIEMPRE una persona (pasa el reCAPTCHA como cualquier
// usuario). El monitor sólo reutiliza esa sesión:
//   1) sesión guardada (cifrada) de la corrida anterior, si sigue válida
//   2) cookie pegada a mano en CF_COOKIE ("PHPSESSID=...")
// Para obtenerla: `npm run login` (abre un navegador visible en tu PC) o
// copiar la cookie PHPSESSID desde el navegador después de ingresar.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { CookieJar, request } from './http.js';
import { parseProductList } from './parse.js';
import { log } from './log.js';

const SESSION_DIR = path.join(config.root, '.session');
const SESSION_FILE = path.join(SESSION_DIR, 'session.enc');

function keyFromSecret() {
  return crypto.createHash('sha256').update(`cf-session:${config.sessionSecret}`).digest();
}

export async function saveSession(jar) {
  if (!config.sessionSecret) return false;
  await fs.mkdir(SESSION_DIR, { recursive: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(), iv);
  const payload = JSON.stringify({ savedAt: new Date().toISOString(), cookies: jar.toJSON(), source: config.manualCookie ? hashCookie(config.manualCookie) : null });
  const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  await fs.writeFile(SESSION_FILE, Buffer.concat([iv, cipher.getAuthTag(), enc]));
  return true;
}

const hashCookie = (c) => crypto.createHash('sha256').update(c).digest('hex').slice(0, 16);

export async function loadSavedSession() {
  if (!config.sessionSecret) return null;
  try {
    const buf = await fs.readFile(SESSION_FILE);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromSecret(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const json = JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
    // Si cargaste una cookie nueva en CF_COOKIE, tiene prioridad sobre la guardada
    if (config.manualCookie && json.source && json.source !== hashCookie(config.manualCookie)) return null;
    return { jar: new CookieJar(json.cookies), savedAt: json.savedAt };
  } catch {
    return null;
  }
}

export function listUrl(currentUrl, page = 1, perPage = 12, method = 'productsList') {
  const q = new URLSearchParams({
    currentUrl,
    filters: '',
    orderBy: 'default',
    currentPage: String(page),
    itemsPerPage: String(perPage),
    method,
  });
  return `${config.baseUrl}products?${q.toString()}`;
}

/** ¿La sesión ve precios? */
export async function validateSession(jar) {
  try {
    const html = await request(listUrl('sec/bebidas', 1, 24), { jar, retries: 2 });
    const items = parseProductList(html);
    const priced = items.filter((p) => p.price);
    return { ok: items.length > 0 && priced.length >= Math.max(1, Math.floor(items.length * 0.3)), total: items.length, priced: priced.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Devuelve un CookieJar con sesión válida o tira error explicando qué hacer. */
export async function getSession() {
  const tried = [];
  const saved = await loadSavedSession();
  if (saved) {
    const v = await validateSession(saved.jar);
    tried.push(`sesión guardada: ${v.ok ? 'ok' : 'vencida'}`);
    if (v.ok) return { jar: saved.jar, source: 'sesión guardada', since: saved.savedAt };
  }
  if (config.manualCookie) {
    const jar = CookieJar.fromHeader(config.manualCookie);
    const v = await validateSession(jar);
    tried.push(`CF_COOKIE: ${v.ok ? 'ok' : 'vencida o sin sucursal'}`);
    if (v.ok) {
      await saveSession(jar);
      return { jar, source: 'CF_COOKIE' };
    }
  } else {
    tried.push('CF_COOKIE vacío');
  }
  const err = new Error(`No hay sesión con precios (${tried.join(' · ')}). Ingresá al sitio, elegí la sucursal y actualizá el secret CF_COOKIE con la cookie PHPSESSID (o corré "npm run login" en tu PC).`);
  err.code = 'NO_SESSION';
  throw err;
}

/**
 * Ingreso asistido: abre un navegador VISIBLE en tu PC para que entres vos
 * (formulario + reCAPTCHA como siempre). Cuando la sesión ya ve precios,
 * guarda la cookie y la muestra para pegarla en el secret CF_COOKIE.
 */
export async function interactiveLogin({ timeoutMin = 10 } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Falta Playwright: ejecutá "npm install" y "npx playwright install chromium".');
  }
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ locale: 'es-AR', viewport: null });
    const page = await context.newPage();
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log.info('Se abrió el navegador: tocá "Ingresar", elegí Comerciante → Retiro → provincia y sucursal, completá tus datos y confirmá.');
    log.info(`Te espero hasta ${timeoutMin} minutos…`);
    const deadline = Date.now() + timeoutMin * 60e3;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const cookies = await context.cookies(config.baseUrl).catch(() => []);
      const jar = new CookieJar();
      for (const c of cookies) if (/^PHPSESSID$/i.test(c.name)) jar.cookies[c.name] = c.value;
      if (!jar.header()) continue;
      const v = await validateSession(jar);
      if (v.ok) {
        await saveSession(jar);
        return jar;
      }
    }
    throw new Error('No se completó el ingreso a tiempo.');
  } finally {
    await browser.close().catch(() => {});
  }
}
