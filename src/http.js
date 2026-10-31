// Cliente HTTP mínimo con cookies, timeout y reintentos con backoff exponencial.
import { config } from './config.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CookieJar {
  constructor(initial = {}) {
    this.cookies = { ...initial };
  }
  static fromHeader(header) {
    const jar = new CookieJar();
    for (const part of String(header || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) jar.cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return jar;
  }
  absorb(response) {
    const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const sc of list) {
      const first = sc.split(';')[0];
      const i = first.indexOf('=');
      if (i <= 0) continue;
      const name = first.slice(0, i).trim();
      const value = first.slice(i + 1).trim();
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(sc) || value === 'deleted') delete this.cookies[name];
      else this.cookies[name] = value;
    }
  }
  header() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  toJSON() {
    return { ...this.cookies };
  }
}

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * fetch con reintentos. Reintenta en errores de red, 429 y 5xx.
 */
export async function request(url, { method = 'GET', headers = {}, body, jar, retries = config.http.retries, timeoutMs = config.http.timeoutMs, expect = 'text' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const h = {
        'User-Agent': config.http.userAgent,
        'Accept-Language': 'es-AR,es;q=0.9',
        Accept: expect === 'json' ? 'application/json' : 'text/html,*/*;q=0.8',
        ...headers,
      };
      if (jar) {
        const c = jar.header();
        if (c) h.Cookie = c;
      }
      const res = await fetch(url, { method, headers: h, body, signal: ctrl.signal, redirect: 'manual' });
      if (jar) jar.absorb(res);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        // seguimos redirecciones a mano para no perder cookies
        clearTimeout(t);
        const next = new URL(res.headers.get('location'), url).toString();
        return request(next, { method: 'GET', headers, jar, retries, timeoutMs, expect });
      }
      if (res.status === 429 || res.status >= 500) throw new HttpError(`HTTP ${res.status} en ${url}`, res.status);
      if (!res.ok) {
        const err = new HttpError(`HTTP ${res.status} en ${url}`, res.status);
        err.noRetry = true;
        throw err;
      }
      const out = expect === 'json' ? await res.json() : await res.text();
      clearTimeout(t);
      return out;
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (err.noRetry || attempt === retries) break;
      const wait = Math.min(30000, 1500 * 2 ** attempt) + Math.floor(Math.random() * 1000);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** Ejecuta tareas con concurrencia limitada. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (err) {
        out[idx] = { error: err };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
