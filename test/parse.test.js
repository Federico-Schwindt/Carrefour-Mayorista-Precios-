import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseProductList, parseArs, parseQuantity, parseMenu } from '../src/parse.js';

const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('parseArs entiende formato argentino', () => {
  assert.equal(parseArs('$ 1.234,56'), 1234.56);
  assert.equal(parseArs('$1.234'), 1234);
  assert.equal(parseArs('12.5'), 12.5);
  assert.equal(parseArs('$ 2.450.000'), 2450000);
  assert.equal(parseArs('abc'), null);
});

test('parseQuantity normaliza a kg / l / u', () => {
  assert.deepEqual(parseQuantity('aceite girasol cocinero pet x 1.5 lt'), { qty: 1.5, unit: 'l' });
  assert.deepEqual(parseQuantity('yerba mate suave union 4flex x 1kg'), { qty: 1, unit: 'kg' });
  assert.deepEqual(parseQuantity('yerba mate mananita 4flex x 500 grs'), { qty: 0.5, unit: 'kg' });
  assert.deepEqual(parseQuantity('agua benedictino bidon x6lt'), { qty: 6, unit: 'l' });
  assert.deepEqual(parseQuantity('gaseosa pack 6 x 2.25 l'), { qty: 13.5, unit: 'l' });
  assert.deepEqual(parseQuantity('cerveza lata 354 cc'), { qty: 0.354, unit: 'l' });
  assert.deepEqual(parseQuantity('papel higienico x 4 rollos'), { qty: 4, unit: 'u' });
  assert.equal(parseQuantity('escoba plastica'), null);
});

test('tarjetas públicas: precio privado', () => {
  const items = parseProductList(fx('list-public.html'));
  assert.equal(items.length, 48);
  const a = items[0];
  assert.equal(a.ean, '7790060023684');
  assert.equal(a.name, 'aceite girasol cocinero pet x 1.5 lt');
  assert.equal(a.category, 'Aceites comunes');
  assert.equal(a.price, null);
  assert.equal(a.private, true);
});

test('tarjetas logueadas: precio, promo por cantidad y precio tachado', () => {
  const [a, b] = parseProductList(fx('list-logged-synthetic.html'));
  assert.equal(a.price, 2780.9);
  assert.equal(a.promoPrice, 2450.5);
  assert.equal(a.promoMinQty, 3);
  assert.equal(a.promo, 'Folleto Maxi');
  assert.equal(a.private, false);
  assert.equal(b.price, 2999);
  assert.equal(b.listPrice, 3100);
  assert.equal(b.promoPrice, null);
});

test('parseMenu encuentra secciones', () => {
  const html = `<div onclick="gotoPage('sec', 'almacén')"></div><div onclick="gotoPage('category', 'aguas', 'bebidas')"></div>`;
  const m = parseMenu(html);
  assert.deepEqual(m.sections, ['almacén']);
  assert.deepEqual(m.categories, [{ category: 'aguas', section: 'bebidas' }]);
});
