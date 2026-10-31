// Parser del HTML que devuelve /products?method=productsList
// Tarjetas públicas (sin sesión): data-price="private".
// Tarjetas logueadas (estructura real):
//   data-price="4,630.00"  precio actual (formato EE.UU.)
//   <div class="discounted_number_price"><s>$ 5,249.00</s></div>  precio anterior
//   data-um="4"  → "Llevando 4 o más" = compra mínima (no es un precio aparte)
//   data-saleName="Ofertón - Solo por hoy"  mecánica de promo
//   data-limit / data-package  tope de unidades y unidades por bulto
import { parse } from 'node-html-parser';

/**
 * Números de precio en cualquiera de los dos formatos:
 *   "$ 1.234,56" (AR) · "$ 4,162.00" (EE.UU., el que usa el sitio) · "1234.5" · "4,162"
 */
export function parseArs(text) {
  if (text === null || text === undefined) return null;
  let s = String(text).replace(/[^\d.,-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Hay de los dos: el que aparece último es el decimal
    const dec = lastComma > lastDot ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.';
    const parts = s.split(sep);
    // "1.234" / "4,162" / "1.234.567" => miles ; "12,5" / "12.50" => decimal
    if (parts.length > 2 || parts[parts.length - 1].length === 3) s = parts.join('');
    else s = parts.join('.');
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
export function parseQuantity(description, { multipack = true } = {}) {
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
    // En Maxi el precio es POR UNIDAD aunque la descripción diga "12 x 90 grs" (bulto)
    if (base && !multipack) return base;
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
 *            minQty, promo, limit, pack, private }]
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
    const amounts = [...text.matchAll(/\$\s?(\d[\d.,]*)/g)]
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

    // Compra mínima: data-um o "Llevando 3 o más"
    let minQty = Number(btn.getAttribute('data-um')) || null;
    const mq = text.match(/llevando\s+(\d+)\s*(?:o\s+m[aá]s|unidades|u\b)/i);
    if (!minQty && mq) minQty = Number(mq[1]);

    // Precio promocional = el menor monto visible si es menor al precio base
    let promoPrice = null;
    if (amounts.length) {
      const min = Math.min(...amounts);
      if (price && min < price * 0.999 && min > price * 0.2) promoPrice = min;
      if (!price && !isPrivate) promoPrice = null;
    }

    const promo = cleanText(btn.getAttribute('data-salename') || btn.getAttribute('data-saleName') || card.querySelector('.sale_name')?.text || '');
    const limit = Number(btn.getAttribute('data-limit')) || null;
    const pack = Number(btn.getAttribute('data-package')) || null;

    out.push({
      ean,
      name,
      sector: cleanText(btn.getAttribute('data-sector')),
      section: cleanText(btn.getAttribute('data-section')),
      category: cleanText(btn.getAttribute('data-category')),
      price: price ?? (amounts.length && !isPrivate ? Math.max(...amounts) : null),
      listPrice: listPrice && price && listPrice > price ? listPrice : null,
      promoPrice,
      minQty: minQty && minQty > 1 ? minQty : null,
      promo: promo || null,
      limit,
      pack,
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
