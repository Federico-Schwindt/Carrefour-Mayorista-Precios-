// Parser del HTML que devuelve /products?method=productsList
// Funciona con las tarjetas públicas (sin sesión, precio "private") y con las
// tarjetas logueadas (data-price numérico + bloques title_price/number_price).
import { parse } from 'node-html-parser';

/** "$ 1.234,56" -> 1234.56 ; "1234.56" -> 1234.56 */
export function parseArs(text) {
  if (text === null || text === undefined) return null;
  let s = String(text).replace(/[^\d.,-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    const parts = s.split('.');
    // "1.234" o "1.234.567" => separador de miles
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) s = parts.join('');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseDataPrice(v) {
  if (v === undefined || v === null) return { price: null, private: false };
  const raw = String(v).trim();
  if (!raw || raw.toLowerCase() === 'private') return { price: null, private: raw.toLowerCase() === 'private' };
  const n = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : parseArs(raw);
  return { price: Number.isFinite(n) && n > 0 ? n : null, private: false };
}

const UNIT_RE = '(kgs?|kilos?|k|grs?|grm|gramos?|g|ml|cc|cm3|lts?|litros?|l)';

/** Cantidad neta a partir de la descripción: { qty, unit: 'kg'|'l'|'u' } */
export function parseQuantity(description) {
  const d = ` ${String(description || '').toLowerCase().replace(/,/g, '.')} `;
  const norm = (n, u) => {
    u = u.replace(/\.$/, '');
    if (/^(kgs?|kilos?|k)$/.test(u)) return { qty: n, unit: 'kg' };
    if (/^(grs?|grm|gramos?|g)$/.test(u)) return { qty: n / 1000, unit: 'kg' };
    if (/^(ml|cc|cm3)$/.test(u)) return { qty: n / 1000, unit: 'l' };
    if (/^(lts?|litros?|l)$/.test(u)) return { qty: n, unit: 'l' };
    return null;
  };
  // "6 x 1.5 lt", "pack 12 u x 354 ml"
  let m = d.match(new RegExp(`(?<![\\w.])(\\d+)\\s*(?:u\\.?|un\\.?|unid\\.?|unidades)?\\s*x\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT_RE}\\b`));
  if (m) {
    const base = norm(Number(m[2]), m[3]);
    if (base && Number(m[1]) > 1 && Number(m[1]) <= 200) return { qty: base.qty * Number(m[1]), unit: base.unit };
  }
  // la última medida que aparezca: "x 1.5 lt", "500grs", "1kg"
  const all = [...d.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${UNIT_RE}(?![a-z])`, 'g'))];
  if (all.length) {
    const last = all[all.length - 1];
    const r = norm(Number(last[1]), last[2]);
    if (r && r.qty > 0) return r;
  }
  // "x 30 u", "x 100 unidades", "pack x 4"
  m = d.match(/(?:x\s*)?(?<![\w.])(\d+)\s*(?:u|un|uni|unid|unidades|rollos|saquitos|sobres)\b/);
  if (m && Number(m[1]) > 0) return { qty: Number(m[1]), unit: 'u' };
  return null;
}

const cleanText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function findCard(node) {
  let cur = node;
  for (let i = 0; i < 6 && cur; i++) {
    const cls = cur.getAttribute?.('class') || '';
    if (/\bitem_card(_public)?\b/.test(cls) || /\bitem_card\w*/.test(cls)) return cur;
    cur = cur.parentNode;
  }
  return node.parentNode || node;
}

/**
 * Devuelve [{ ean, name, sector, section, category, price, listPrice, promoPrice,
 *            promoMinQty, promo, private }]
 */
export function parseProductList(html) {
  const root = parse(html, { comment: false });
  const out = [];
  const seen = new Set();
  for (const btn of root.querySelectorAll('[data-ean]')) {
    const ean = (btn.getAttribute('data-ean') || '').trim();
    if (!/^\d{6,14}$/.test(ean) || seen.has(ean)) continue;
    seen.add(ean);
    const card = findCard(btn);
    const { price, private: isPrivate } = parseDataPrice(btn.getAttribute('data-price'));
    const name = cleanText(btn.getAttribute('data-description') || card.querySelector('.item_card__description')?.text);

    // Todos los montos "$ ..." visibles en la tarjeta
    const text = cleanText(card.text);
    const amounts = [...text.matchAll(/\$\s?([\d.]+(?:,\d{1,2})?)/g)]
      .map((m) => parseArs(m[1]))
      .filter((n) => n && n > 0);

    // Precio tachado / anterior
    let listPrice = null;
    for (const el of card.querySelectorAll('*')) {
      const cls = (el.getAttribute('class') || '').toLowerCase();
      const style = (el.getAttribute('style') || '').toLowerCase();
      if (/line-through/.test(style) || /(old|before|regular|tachado|antes|strike|lista)/.test(cls) || el.tagName === 'S' || el.tagName === 'DEL') {
        const v = parseArs(el.text);
        if (v && v > 0) listPrice = Math.max(listPrice || 0, v);
      }
    }

    // "Llevando 3 o más"
    let promoMinQty = null;
    const mq = text.match(/llevando\s+(\d+)\s*(?:o\s+m[aá]s|unidades|u\b)/i);
    if (mq) promoMinQty = Number(mq[1]);

    // Precio promocional = el menor monto visible si es menor al precio base
    let promoPrice = null;
    if (amounts.length) {
      const min = Math.min(...amounts);
      if (price && min < price * 0.999 && min > price * 0.2) promoPrice = min;
      if (!price && !isPrivate) promoPrice = null;
    }

    const promo = cleanText(card.querySelector('.sale_name')?.text || card.querySelector('[class*="mecanica"]')?.text || '');
    const limitInfo = cleanText(card.querySelector('#limit_info')?.text || '');

    out.push({
      ean,
      name,
      sector: cleanText(btn.getAttribute('data-sector')),
      section: cleanText(btn.getAttribute('data-section')),
      category: cleanText(btn.getAttribute('data-category')),
      price: price ?? (amounts.length && !isPrivate ? Math.max(...amounts) : null),
      listPrice: listPrice && price && listPrice > price ? listPrice : null,
      promoPrice,
      promoMinQty,
      promo: promo || null,
      limit: limitInfo || null,
      private: isPrivate,
    });
  }
  return out;
}

/** Secciones y categorías a partir del HTML de products?method=menu */
export function parseMenu(html) {
  const sections = new Set();
  const categories = [];
  for (const m of String(html).matchAll(/gotoPage\('sec',\s*'([^']+)'\)/g)) sections.add(m[1]);
  for (const m of String(html).matchAll(/gotoPage\('category',\s*'([^']+)',\s*'([^']+)'\)/g)) {
    categories.push({ category: m[1], section: m[2] });
  }
  return { sections: [...sections], categories };
}
