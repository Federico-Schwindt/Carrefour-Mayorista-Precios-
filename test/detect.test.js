import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAll, seriesStats, appendHistory, shouldNotify, evaluateProduct } from '../src/detect.js';
import { config } from '../src/config.js';

const rules = config.rules;
const DAY = 1440;
const NOW = 30_000_000;
const prod = (ean, price, extra = {}) => ({ ean, name: `producto ${ean} x 1 kg`, category: 'Cat', price, ...extra });

test('seriesStats: previo, mínimo y mediana ponderada por tiempo', () => {
  const s = [[NOW - 20 * DAY, 1000], [NOW - 2 * DAY, 1100], [NOW - DAY, 1000]];
  const st = seriesStats(s, NOW);
  assert.equal(st.prev, 1000);
  assert.equal(st.min, 1000);
  assert.equal(st.ref, 1000);
  assert.ok(st.days > 19);
});

test('primera corrida = base, sin alertas', () => {
  const current = new Map([['1', prod('1', 1000)]]);
  const r = detectAll({ current, prevSnapshot: null, history: {}, retail: {}, rules, nowMin: NOW });
  assert.equal(r.baseline, true);
  assert.equal(r.found.length, 0);
});

test('baja fuerte y posible error', () => {
  const history = {
    a: [[NOW - 10 * DAY, 1000]],
    b: [[NOW - 10 * DAY, 1000]],
    c: [[NOW - 10 * DAY, 1000]],
  };
  const current = new Map([
    ['a', prod('a', 800)], // -20% → baja
    ['b', prod('b', 400)], // -60% → error
    ['c', prod('c', 990)], // -1% → nada
  ]);
  const r = detectAll({ current, prevSnapshot: { a: {}, b: {}, c: {} }, history, retail: {}, rules, nowMin: NOW });
  const by = Object.fromEntries(r.found.map((f) => [f.product.ean, f.type]));
  assert.equal(by.a, 'baja');
  assert.equal(by.b, 'error');
  assert.equal(by.c, undefined);
});

test('margen de reventa vs minorista al bajar el precio', () => {
  const history = { a: [[NOW - 10 * DAY, 1000]] };
  const current = new Map([['a', prod('a', 900)]]);
  const retail = { a: { found: true, available: true, price: 1300 } }; // antes 30% de margen, ahora 44%
  const r = detectAll({ current, prevSnapshot: { a: {} }, history, retail, rules, nowMin: NOW });
  assert.equal(r.found.length, 1);
  assert.ok(r.found[0].types.includes('reventa'));
  assert.ok(r.found[0].metrics.margin > 0.4);
});

test('mínimo histórico', () => {
  const history = { a: [[NOW - 20 * DAY, 1000], [NOW - 10 * DAY, 1050], [NOW - 3 * DAY, 980]] };
  const current = new Map([['a', prod('a', 880)]]);
  const r = detectAll({ current, prevSnapshot: { a: {} }, history, retail: {}, rules, nowMin: NOW });
  assert.ok(r.found[0].types.includes('minimo'));
});

test('precio por kg anómalo dentro de la categoría (producto nuevo)', () => {
  const items = [];
  for (let i = 0; i < 8; i++) items.push(prod(`n${i}`, 10000 + i * 100));
  items.push(prod('x', 2500)); // 75% más barato por kg
  const current = new Map(items.map((p) => [p.ean, p]));
  const history = Object.fromEntries(items.filter((p) => p.ean !== 'x').map((p) => [p.ean, [[NOW - 5 * DAY, p.price]]]));
  const r = detectAll({ current, prevSnapshot: Object.fromEntries(items.filter((p) => p.ean !== 'x').map((p) => [p.ean, {}])), history, retail: {}, rules, nowMin: NOW });
  const x = r.found.find((f) => f.product.ean === 'x');
  assert.ok(x, 'debería detectar el outlier');
  assert.equal(x.type, 'error');
});

test('ignora productos baratos (ruido)', () => {
  const r = evaluateProduct(prod('a', 100), { stats: { prev: 300, ref: 300, min: 300, days: 10 }, rules, changed: true });
  assert.equal(r, null);
});

test('guarda de baja masiva', () => {
  const history = {};
  const current = new Map();
  for (let i = 0; i < 100; i++) {
    history[i] = [[NOW - DAY, 1000]];
    current.set(String(i), prod(String(i), i < 40 ? 700 : 1000));
  }
  const r = detectAll({ current, prevSnapshot: {}, history, retail: {}, rules, nowMin: NOW });
  assert.ok(r.massDropRatio > config.guards.maxMassDropRatio);
});

test('historial sólo guarda cambios', () => {
  const h = {};
  const c1 = new Map([['a', prod('a', 1000)]]);
  appendHistory(h, c1, NOW, 400);
  appendHistory(h, c1, NOW + 30, 400);
  assert.equal(h.a.length, 1);
  const changes = appendHistory(h, new Map([['a', prod('a', 900)]]), NOW + 60, 400);
  assert.equal(changes, 1);
  assert.equal(h.a.length, 2);
});

test('no repite avisos salvo que baje más o pase el tiempo', () => {
  const state = { notified: { 'a:baja': { ts: new Date(0).toISOString(), price: 1000 } } };
  const t0 = 0;
  assert.equal(shouldNotify(state, 'a', 'baja', 1000, t0 + 3600e3, rules), false);
  assert.equal(shouldNotify(state, 'a', 'baja', 950, t0 + 3600e3, rules), true);
  assert.equal(shouldNotify(state, 'a', 'baja', 1000, t0 + (rules.repeatAfterHours + 1) * 3600e3, rules), true);
  assert.equal(shouldNotify(state, 'b', 'baja', 1000, t0, rules), true);
});
