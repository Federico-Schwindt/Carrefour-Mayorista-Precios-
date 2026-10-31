// Productos que no se siguen: más caros que el tope por unidad o que contienen
// alguna palabra excluida (cochecitos, butacas, cunas…). Se aplica a todo:
// catálogo, historial, alertas y oportunidades.
import { config } from './config.js';
import { effectivePrice } from './detect.js';

export const normText = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildExcluder({ maxUnitPrice, excludeWords } = config.filters) {
  const words = (excludeWords || []).map((w) => normText(w)).filter(Boolean);
  // palabra completa (admite plural): "butaca" excluye "butacas" pero no "embutacado"
  const re = words.length ? new RegExp(`(^|[^a-z])(${words.map(escapeRe).join('|')})(s|es)?(?=[^a-z]|$)`, 'i') : null;
  /** p: producto del lector ({name, category, section, price}) o compacto ({n, c, sc, e}) */
  return (p) => {
    const price = p.e ?? effectivePrice(p) ?? p.price;
    if (maxUnitPrice && price > maxUnitPrice) return 'precio';
    if (re && re.test(normText(`${p.name ?? p.n ?? ''} ${p.category ?? p.c ?? ''} ${p.section ?? p.sc ?? ''}`))) return 'palabra';
    return null;
  };
}
