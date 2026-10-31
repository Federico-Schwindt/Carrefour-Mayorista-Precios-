// Notificaciones push: Telegram (recomendado), ntfy.sh (sin registro) y Discord.
import { config } from './config.js';
import { request } from './http.js';
import { TYPE_LABEL } from './detect.js';
import { log } from './log.js';
import { promoFor, loadPromos } from './promos.js';

const EMOJI = { error: '🚨', oportunidad: '🔥', reventa: '💰', baja: '📉', minimo: '🏆', sistema: '⚙️' };
const ars = (n) => (n || n === 0 ? `$${Math.round(n).toLocaleString('es-AR')}` : '—');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function channelsConfigured() {
  const n = config.notify;
  return {
    telegram: Boolean(n.telegramToken && n.telegramChatId),
    ntfy: Boolean(n.ntfyTopic),
    discord: Boolean(n.discordWebhook),
  };
}

export const productUrl = (ean) => `${config.baseUrl}p/${ean}`;
export const imageUrl = (ean) => `https://tupedido.carrefour.com.ar/imagenesPDA/${ean}.jpg`;
export const SOURCE_TAG = { mayorista: '🏪 MAYORISTA · Carrefour Maxi', minorista: '🛒 MINORISTA · carrefour.com.ar' };
const isMin = (a) => a.source === 'minorista';
const tagOf = (a) => (isMin(a) ? SOURCE_TAG.minorista : a.branch ? `🏪 MAYORISTA · Maxi ${a.branch}` : SOURCE_TAG.mayorista);
const shortTag = (a) => (isMin(a) ? '🛒 MINORISTA' : a.branch ? `🏪 MAYORISTA ${a.branch}` : '🏪 MAYORISTA');
const linkOf = (a) => (isMin(a) ? a.url || 'https://www.carrefour.com.ar/' : productUrl(a.ean));
const imageOf = (a) => a.image || imageUrl(a.ean);

export function formatAlert(a, html = true) {
  const b = (s) => (html ? `<b>${esc(s)}</b>` : s);
  const lines = [];
  lines.push(b(tagOf(a)));
  lines.push(`${EMOJI[a.type] || '🔔'} ${b(String(TYPE_LABEL[a.type] || a.type).toUpperCase())}`);
  lines.push(b(a.name));
  let priceLine = `💲 ${ars(a.price)}`;
  if (a.prev && a.prev !== a.price) priceLine += ` (antes ${ars(a.prev)}, ${a.dropPct > 0 ? '-' : '+'}${Math.abs(Math.round(a.dropPct * 100))}%)`;
  lines.push(priceLine);
  if (a.listPrice && a.listPrice > a.price) lines.push(`🏷️ Precio de lista ${ars(a.listPrice)}`);
  const pr = promoFor({ ...a, price: a.price }, { promos: loadPromos().promos, medios: ['prepaga'] });
  if (pr) lines.push(`💳 Hoy con ${pr.medio === 'prepaga' ? 'Prepaga Carrefour' : 'tarjeta Carrefour'}: ${ars(a.price * (1 - pr.pct / 100))} (−${pr.pct}%)`);
  if (a.seller) lines.push(`🏬 Vendido por ${esc(a.seller)}`);
  if (a.retail) lines.push(`🛒 Minorista ${ars(a.retail)}${a.margin !== undefined && a.margin !== null ? ` → margen ${Math.round(a.margin * 100)}%` : ''}`);
  const extra = [a.promo || '', a.minQty ? `compra mínima ${a.minQty} u.` : ''].filter(Boolean).join(' · ');
  if (extra) lines.push(`🏷️ ${esc(extra)}`);
  for (const r of a.reasons || []) lines.push(`• ${esc(r)}`);
  lines.push(`📂 ${esc(a.category || a.section || '')}`);
  if (html) {
    const links = [`<a href="${esc(linkOf(a))}">${isMin(a) ? 'Ver en carrefour.com.ar' : 'Ver en Carrefour Maxi'}</a>`];
    if (a.retailUrl) links.push(`<a href="${esc(a.retailUrl)}">Minorista</a>`);
    if (config.dashboardUrl) links.push(`<a href="${config.dashboardUrl}#src=${encodeURIComponent(a.sourceId || (isMin(a) ? 'min' : 'may'))}&p=${a.ean}">Historial</a>`);
    lines.push(links.join(' · '));
  }
  return lines.join('\n');
}

async function telegram(method, payload) {
  const url = `https://api.telegram.org/bot${config.notify.telegramToken}/${method}`;
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    expect: 'json',
    retries: 2,
    timeoutMs: 20000,
  });
}

async function sendTelegramAlert(a) {
  const caption = formatAlert(a, true);
  try {
    await telegram('sendPhoto', { chat_id: config.notify.telegramChatId, photo: imageOf(a), caption: caption.slice(0, 1020), parse_mode: 'HTML' });
  } catch {
    await telegram('sendMessage', { chat_id: config.notify.telegramChatId, text: caption, parse_mode: 'HTML', disable_web_page_preview: true });
  }
}

async function sendNtfy({ title, body, click, image, priority = 4, tags = [] }) {
  const n = config.notify;
  const headers = { Title: encodeURIComponent(title), Priority: String(priority), Tags: tags.join(','), 'Content-Type': 'text/plain; charset=utf-8' };
  // ntfy acepta encabezados RFC 2047 para UTF-8
  headers.Title = `=?UTF-8?B?${Buffer.from(title).toString('base64')}?=`;
  if (click) headers.Click = click;
  if (image) headers.Attach = image;
  await request(`${n.ntfyServer.replace(/\/$/, '')}/${encodeURIComponent(n.ntfyTopic)}`, { method: 'POST', headers, body, retries: 2, timeoutMs: 20000 });
}

async function sendDiscord(content, embed) {
  await request(config.notify.discordWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(embed ? { content, embeds: [embed] } : { content }),
    retries: 2,
    timeoutMs: 20000,
  });
}

/** Envía una alerta de producto por todos los canales configurados. */
export async function notifyAlert(a) {
  const ch = channelsConfigured();
  const results = [];
  if (ch.telegram) results.push(sendTelegramAlert(a));
  if (ch.ntfy) {
    const plain = formatAlert(a, false).split('\n').slice(2).join('\n');
    results.push(
      sendNtfy({
        title: `${shortTag(a)} · ${TYPE_LABEL[a.type] || a.type}: ${ars(a.price)}`,
        body: plain,
        click: linkOf(a),
        image: imageOf(a),
        priority: a.type === 'error' || a.type === 'oportunidad' ? 5 : 4,
        tags: [a.type],
      }),
    );
  }
  if (ch.discord) {
    results.push(
      sendDiscord('', {
        title: `${shortTag(a)} · ${TYPE_LABEL[a.type]} — ${a.name}`.slice(0, 250),
        url: linkOf(a),
        description: formatAlert(a, false).split('\n').slice(3).join('\n').slice(0, 3900),
        thumbnail: { url: imageOf(a) },
        color: a.type === 'error' ? 0xe53935 : a.type === 'reventa' ? 0x43a047 : 0x1e88e5,
      }),
    );
  }
  const settled = await Promise.allSettled(results);
  const failed = settled.filter((s) => s.status === 'rejected');
  for (const f of failed) log.warn(`Notificación falló: ${f.reason?.message}`);
  return results.length > 0 && failed.length < results.length;
}

/** Mensaje de sistema (sesión caída, resumen, etc.) */
export async function notifySystem(title, text) {
  const ch = channelsConfigured();
  const tasks = [];
  if (ch.telegram) tasks.push(telegram('sendMessage', { chat_id: config.notify.telegramChatId, text: `⚙️ <b>${esc(title)}</b>\n${esc(text)}`, parse_mode: 'HTML', disable_web_page_preview: true }));
  if (ch.ntfy) tasks.push(sendNtfy({ title: `⚙️ ${title}`, body: text, priority: 3, tags: ['gear'], click: config.dashboardUrl || undefined }));
  if (ch.discord) tasks.push(sendDiscord(`⚙️ **${title}**\n${text}`));
  const settled = await Promise.allSettled(tasks);
  for (const s of settled) if (s.status === 'rejected') log.warn(`Notificación de sistema falló: ${s.reason?.message}`);
}
