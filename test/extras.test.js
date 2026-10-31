import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExcluder } from '../src/filters.js';
import { promoFor, todayAR } from '../src/promos.js';
import { normalizeRetailProduct } from '../src/retail-catalog.js';
import { unitQty } from '../src/detect.js';

test('exclusiones: precio máximo por unidad y palabras completas', () => {
  const ex = buildExcluder({ maxUnitPrice: 40000, excludeWords: ['cochecito', 'butaca', 'banera'] });
  assert.equal(ex({ name: 'Heladera no frost', price: 900000 }), 'precio');
  assert.equal(ex({ name: 'Cochecito paseo Bebesit', price: 30000 }), 'palabra');
  assert.equal(ex({ name: 'Butacas para auto', price: 20000 }), 'palabra', 'plural');
  assert.equal(ex({ name: 'Bañera plegable', price: 20000 }), 'palabra', 'sin acentos');
  assert.equal(ex({ name: 'Embutido de cerdo', price: 3000 }), null, 'no corta palabras');
  assert.equal(ex({ n: 'yerba 1 kg', e: 5000 }), null, 'formato compacto');
  assert.equal(ex({ n: 'whisky importado', e: 45000 }), 'precio', 'formato compacto caro');
});

test('promos por día: prepaga, medios, rubros excluidos y acumulables', () => {
  const promos = [
    { id: 'finde', medio: 'prepaga', pct: 10, dias: [6, 0], fuentes: ['mayorista', 'minorista'], desde: '2026-10-01', hasta: '2026-11-30', acumulable: true, excluye_rubros: 'carnicer|electro', excluye_promos: 'bulto' },
    { id: 'vie', medio: 'prepaga', pct: 15, dias: [5], fuentes: ['minorista'], desde: '2026-10-01', hasta: '2026-11-30', acumulable: true, excluye_marketplace: true },
    { id: 'lunmar', medio: 'credito', pct: 15, dias: [1, 2], fuentes: ['mayorista'], desde: '2026-10-01', hasta: '2026-11-30', acumulable: false },
  ];
  const sat = new Date('2026-10-31T15:00:00Z');
  const fri = new Date('2026-11-06T15:00:00Z');
  const mon = new Date('2026-11-02T15:00:00Z');
  const dec = new Date('2026-12-05T15:00:00Z');
  assert.equal(todayAR(sat).dow, 6);
  const may = { source: 'mayorista', sector: 'Almacén', category: 'Yerba', price: 1000 };
  const min = { source: 'minorista', sector: 'Almacén', category: 'Yerba', price: 1000 };
  assert.equal(promoFor(may, { promos, date: sat })?.id, 'finde');
  assert.equal(promoFor(min, { promos, date: fri })?.id, 'vie');
  assert.equal(promoFor(may, { promos, date: fri }), null, 'el viernes no es para Maxi');
  assert.equal(promoFor({ ...min, seller: 'Otro' }, { promos, date: fri }), null, 'marketplace excluido');
  assert.equal(promoFor({ ...may, sector: 'Carnicería' }, { promos, date: sat }), null, 'rubro excluido');
  assert.equal(promoFor({ ...may, promo: 'Oferta por Bulto' }, { promos, date: sat }), null, 'promo excluida');
  assert.equal(promoFor(may, { promos, date: mon }), null, 'sin tarjeta de crédito no aplica');
  assert.equal(promoFor(may, { promos, date: mon, medios: ['credito'] })?.id, 'lunmar');
  assert.equal(promoFor({ ...may, promo: 'Folleto Maxi' }, { promos, date: mon, medios: ['credito'] }), null, 'no acumulable con ofertas');
  assert.equal(promoFor(may, { promos, date: dec }), null, 'vencida');
});

test('minorista: límite de unidades y precio oficial por kg', () => {
  const [p] = normalizeRetailProduct({
    productName: 'Yerba Unión 1 kg',
    brand: 'Unión',
    link: 'https://www.carrefour.com.ar/yerba/p',
    categories: ['/Desayuno/Yerba/Yerba/'],
    'Cantidad Maxima Permitida': ['8'],
    'Precio x unidad': ['($5,700.00 x 1 K.)'],
    pricePerUnit: ['5700.00'],
    items: [{ itemId: '1', ean: '7790387014617', images: [], sellers: [{ sellerId: '1', sellerName: 'CARREFOUR', commertialOffer: { Price: 5700, ListPrice: 5700, AvailableQuantity: 99 } }] }],
  });
  assert.equal(p.limit, 8);
  assert.equal(p.unitPrice, 5700);
  assert.equal(p.unit, 'kg');
  assert.deepEqual(unitQty(p), { qty: 1, unit: 'kg' });
});
