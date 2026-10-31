// Manejo de sesiones mayoristas: el sitio sólo muestra precios con una sucursal
// elegida (sesión PHP creada por el formulario de ingreso, que tiene reCAPTCHA).
//
// El ingreso lo hace SIEMPRE una persona. El monitor sólo reutiliza esas
// sesiones: una cookie por sucursal (CF_COOKIE, CF_COOKIE_2, …). La sucursal de
// cada cookie se detecta sola ("Pedido entregado por GUALEGUAYCHU").
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { CookieJar, request } from './http.js';
import { parseProductList } from './parse.js';
import { log } from './log.js';

const SESSION_DIR = path.join(config.root, '.session');
const sessionFile = (index) => path.join(SESSION_DIR, index === 1 ? 'session.enc' : `session-${index}.enc`);
const hashCookie = (c) => crypto.createHash('sha256').update(String(c)).digest('hex').slice(0, 16);
const keyFromSecret = () => crypto.createHash('sha256').update(`cf-session:${config.sessionSecret}`).digest();

/** Acepta "PHPSESSID=abc", "abc" o "Cookie: PHPSESSID=abc; otra=1". */
export function normalizeCookie(value) {
  let v = String(value || '').trim().replace(/^cookie:\s*/i, '').replace(/^["']|["']$/g, '');
  if (!v) return '';
  if (!v.includes('=')) v = `PHPSESSID=${v}`;
  return v;
}

export const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'sucursal';

export async function saveSession(jar, index = 1, cookieValue = '') {
  if (!config.sessionSecret) return false;
  await fs.mkdir(SESSION_DIR, { recursive: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(), iv);
  const payload = JSON.stringify({ savedAt: new Date().toISOString(), cookies: jar.toJSON(), source: cookieValue ? hashCookie(cookieValue) : null });
  const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  await fs.writeFile(sessionFile(index), Buffer.concat([iv, cipher.getAuthTag(), enc]));
  return true;
}

export async function loadSavedSession(index = 1, cookieValue = '') {
  if (!config.sessionSecret) return null;
  try {
    const buf = await fs.readFile(sessionFile(index));
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromSecret(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const json = JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
    // Si cargaste una cookie nueva en el secret, tiene prioridad sobre la guardada
    if (cookieValue && json.source && json.source !== hashCookie(cookieValue)) return null;
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

/** Nombre de la sucursal de la sesión: "Pedido entregado por <strong>ZARATE</strong>" */
export function parseBranchName(html) {
  const m = String(html).match(/class="title-suc[^"]*"[\s\S]{0,400}?<strong[^>]*>\s*([^<]+?)\s*<\/strong>/i);
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, ' ').trim();
  const name = raw.replace(/^carrefour\s+maxi\s+/i, '').trim();
  return name ? { name, slug: slugify(name) } : null;
}

export async function detectBranch(jar) {
  try {
    return parseBranchName(await request(config.baseUrl, { jar, retries: 2 }));
  } catch {
    return null;
  }
}

/**
 * Valida TODAS las cookies configuradas. Devuelve una entrada por cookie:
 *   { var, index, ok, jar, source, branch: {name, slug}, error }
 * Una cookie vencida no frena a las demás.
 */
export async function getSessions() {
  const out = [];
  const seen = new Map();
  for (const c of config.cookies) {
    const entry = { var: c.var, index: c.index, ok: false };
    try {
      let jar = null;
      const saved = await loadSavedSession(c.index, c.value);
      if (saved && (await validateSession(saved.jar)).ok) {
        jar = saved.jar;
        entry.source = 'sesión guardada';
      }
      if (!jar) {
        const j = CookieJar.fromHeader(normalizeCookie(c.value));
        if ((await validateSession(j)).ok) {
          jar = j;
          entry.source = c.var;
          await saveSession(j, c.index, c.value);
        }
      }
      if (!jar) {
        const err = new Error(`${c.var}: la sesión venció o no tiene sucursal elegida. Ingresá de nuevo al sitio y actualizá el secret ${c.var}.`);
        err.code = 'NO_SESSION';
        throw err;
      }
      const branch = (await detectBranch(jar)) || { name: `Sucursal ${c.index}`, slug: `sucursal-${c.index}` };
      if (seen.has(branch.slug)) {
        throw new Error(`${c.var} es de la misma sucursal (${branch.name}) que ${seen.get(branch.slug)}. Para otra sucursal, borrá los datos del sitio en el navegador antes de ingresar.`);
      }
      seen.set(branch.slug, c.var);
      Object.assign(entry, { ok: true, jar, branch });
    } catch (err) {
      entry.error = err;
    }
    out.push(entry);
  }
  return out;
}

/** Compatibilidad: primera sesión válida (o error). */
export async function getSession() {
  if (!config.cookies.length) {
    const err = new Error('No hay ninguna cookie cargada (secret CF_COOKIE). Ingresá al sitio, elegí la sucursal y copiá la cookie PHPSESSID.');
    err.code = 'NO_SESSION';
    throw err;
  }
  const all = await getSessions();
  const ok = all.find((s) => s.ok);
  if (ok) return ok;
  throw all[0].error;
}

/**
 * Ingreso asistido: abre un navegador VISIBLE en tu PC para que entres vos
 * (formulario + reCAPTCHA como siempre). Cuando la sesión ya ve precios,
 * muestra la cookie para pegarla en el secret.
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
      if ((await validateSession(jar)).ok) return jar;
    }
    throw new Error('No se completó el ingreso a tiempo.');
  } finally {
    await browser.close().catch(() => {});
  }
}
