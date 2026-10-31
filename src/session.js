// Manejo de sesión: el sitio sólo muestra precios con una sucursal elegida
// (sesión PHP). Orden de prioridad:
//   1) sesión guardada (cifrada) de la corrida anterior, si sigue válida
//   2) cookie pegada a mano (CF_COOKIE)
//   3) login automático con un navegador real (Playwright) usando los datos
//      del formulario de la web (nombre, CUIT, teléfono, email, sucursal).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { config, hasCredentials } from './config.js';
import { CookieJar, request } from './http.js';
import { parseProductList } from './parse.js';
import { log } from './log.js';

const SESSION_DIR = path.join(config.root, '.session');
const SESSION_FILE = path.join(SESSION_DIR, 'session.enc');
const RECAPTCHA_FALLBACK_KEY = '6LdiZHIqAAAAAJO8Gn9RbfC6bMckPmMXgoBrqfmJ';

function keyFromSecret() {
  return crypto.createHash('sha256').update(`cf-session:${config.sessionSecret}`).digest();
}

export async function saveSession(jar) {
  if (!config.sessionSecret) return false;
  await fs.mkdir(SESSION_DIR, { recursive: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(), iv);
  const payload = JSON.stringify({ savedAt: new Date().toISOString(), cookies: jar.toJSON(), seller: config.account.seller });
  const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  await fs.writeFile(SESSION_FILE, Buffer.concat([iv, cipher.getAuthTag(), enc]));
  return true;
}

export async function loadSavedSession() {
  if (!config.sessionSecret) return null;
  try {
    const buf = await fs.readFile(SESSION_FILE);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromSecret(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const json = JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
    if (json.seller && json.seller !== config.account.seller) return null; // cambió la sucursal
    return new CookieJar(json.cookies);
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

/** ¿La sesión ve precios? Devuelve { ok, sample } */
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

async function importPlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error('Playwright no está instalado. Ejecutá: npm install');
  }
}

async function launchBrowser(chromium) {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    if (!/Executable doesn't exist|browserType.launch/i.test(err.message)) throw err;
    log.info('Instalando Chromium para Playwright (una sola vez)…');
    execSync(`npx playwright install ${process.env.CI ? '--with-deps ' : ''}chromium`, { stdio: 'inherit', cwd: config.root });
    return chromium.launch({ headless: true });
  }
}

/**
 * Login con navegador real. Completa el mismo formulario que usa la web
 * (incluido el reCAPTCHA invisible que ejecuta la propia página).
 */
export async function loginWithBrowser() {
  if (!hasCredentials()) {
    throw new Error('Faltan datos de login: configurá CF_NAME, CF_CUIT, CF_PHONE, CF_EMAIL (y opcional CF_REGION, CF_SELLER).');
  }
  const acc = config.account;
  const { chromium } = await importPlaywright();
  const browser = await launchBrowser(chromium);
  try {
    const context = await browser.newContext({ locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires', viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#userForm', { timeout: 30000 });

    // Validamos que la sucursal exista en la provincia elegida
    const sellersHtml = await page.evaluate(async ({ region, delivery }) => {
      const r = await fetch('/seller?method=sellersLists', {
        method: 'POST',
        headers: { 'Content-type': 'application/x-www-form-urlencoded' },
        body: `zoneId=${encodeURIComponent(region)}&deliveryType=${delivery === 'envio' ? 1 : 0}`,
      });
      return r.text();
    }, acc);
    const sellers = [...sellersHtml.matchAll(/<option value="(\d+)">([^<]+)<\/option>/g)].map((m) => ({ id: m[1], name: m[2] }));
    if (!sellers.some((s) => s.id === acc.seller)) {
      throw new Error(`La sucursal ${acc.seller} no existe en ${acc.region}. Disponibles: ${sellers.map((s) => `${s.id}=${s.name}`).join(' | ')}`);
    }

    await page.waitForFunction(() => window.grecaptcha?.enterprise?.execute, null, { timeout: 45000 });

    const navigation = page.waitForNavigation({ timeout: 60000, waitUntil: 'domcontentloaded' });
    await page.evaluate(
      async ({ acc, fallbackKey }) => {
        const form = document.getElementById('userForm');
        const setRadio = (name, value) => {
          const el = form.querySelector(`input[name="${name}"][value="${value}"]`);
          if (el) el.checked = true;
        };
        const setOption = (id, value) => {
          const sel = form.querySelector(`#${id}`);
          sel.innerHTML = `<option value="${value}" selected>${value}</option>`;
          sel.value = value;
        };
        setRadio('customerType', 'business');
        setRadio('delivery', acc.delivery);
        form.querySelector('#selected_delivery').value = acc.delivery;
        form.querySelector('#url_c').value = location.href;
        setOption('region', acc.region);
        setOption('seller', acc.seller);
        form.querySelector('#user-name').value = acc.name;
        form.querySelector('#user-cuit').value = acc.numberId;
        form.querySelector('#user-phone').value = acc.phone;
        form.querySelector('#user-email').value = acc.email;

        const src = document.querySelector('script[src*="recaptcha/enterprise.js"]')?.src || '';
        const key = new URL(src || 'https://x/?render=' + fallbackKey).searchParams.get('render') || fallbackKey;
        const token = await new Promise((resolve, reject) => {
          window.grecaptcha.enterprise.ready(() => window.grecaptcha.enterprise.execute(key, { action: 'signup' }).then(resolve, reject));
        });
        const add = (name, value) => {
          const i = document.createElement('input');
          i.type = 'hidden';
          i.name = name;
          i.value = value;
          form.prepend(i);
        };
        add('token', token);
        add('action', 'signup');
        setTimeout(() => HTMLFormElement.prototype.submit.call(form), 50);
      },
      { acc, fallbackKey: RECAPTCHA_FALLBACK_KEY },
    );
    await navigation;
    await page.waitForLoadState('domcontentloaded');

    // Verificamos dentro del navegador que ya se vean precios
    const check = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const t = await r.text();
      const prices = [...t.matchAll(/data-price="([^"]*)"/g)].map((m) => m[1]);
      return { total: prices.length, numeric: prices.filter((p) => /^\d/.test(p)).length };
    }, listUrl('sec/bebidas', 1, 24));

    const cookies = await context.cookies(config.baseUrl);
    const jar = new CookieJar();
    for (const c of cookies) jar.cookies[c.name] = c.value;

    if (!check.numeric) {
      const msg = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.error-message, .error-message-button, .alert, .error')].map((e) => e.textContent.trim()).filter(Boolean);
        return el.join(' | ').slice(0, 300);
      });
      throw new Error(`El login no habilitó los precios (${check.numeric}/${check.total}). ${msg ? 'Mensaje: ' + msg : 'Puede que el reCAPTCHA haya rechazado el navegador automático.'}`);
    }
    log.info(`Login OK: ${check.numeric}/${check.total} productos con precio.`);
    return jar;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Devuelve un CookieJar con sesión válida o tira error explicando qué falta. */
export async function getSession({ forceLogin = false } = {}) {
  const tried = [];
  if (!forceLogin) {
    const saved = await loadSavedSession();
    if (saved) {
      const v = await validateSession(saved);
      tried.push(`guardada: ${v.ok ? 'ok' : 'vencida'}`);
      if (v.ok) return { jar: saved, source: 'guardada' };
    }
    if (config.manualCookie) {
      const jar = CookieJar.fromHeader(config.manualCookie);
      const v = await validateSession(jar);
      tried.push(`CF_COOKIE: ${v.ok ? 'ok' : 'inválida'}`);
      if (v.ok) {
        await saveSession(jar);
        return { jar, source: 'cookie manual' };
      }
    }
  }
  if (hasCredentials()) {
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const jar = await loginWithBrowser();
        const v = await validateSession(jar);
        if (!v.ok) throw new Error('La sesión del navegador no funciona fuera de él.');
        await saveSession(jar);
        return { jar, source: 'login automático' };
      } catch (err) {
        lastErr = err;
        log.warn(`Login intento ${attempt} falló: ${err.message}`);
      }
    }
    tried.push(`login: ${lastErr?.message}`);
  } else {
    tried.push('login: faltan CF_NAME/CF_CUIT/CF_PHONE/CF_EMAIL');
  }
  const err = new Error(`No hay sesión con precios. Intentos → ${tried.join(' · ')}`);
  err.code = 'NO_SESSION';
  throw err;
}
