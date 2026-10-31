// Persistencia en archivos JSON dentro de data/ (se publican en la web).
// IMPORTANTE: acá NO se guarda nada personal (ni cookies ni datos de login).
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const file = (name) => path.join(config.dataDir, name);

export async function readJson(name, fallback) {
  try {
    return JSON.parse(await fs.readFile(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(name, value, { pretty = false } = {}) {
  await fs.mkdir(config.dataDir, { recursive: true });
  const target = file(name);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
  await fs.rename(tmp, target);
}

export async function loadAll() {
  const [products, history, alerts, retail, state, status] = await Promise.all([
    readJson('products.json', null),
    readJson('history.json', {}),
    readJson('alerts.json', { alerts: [] }),
    readJson('retail.json', {}),
    readJson('state.json', { notified: {} }),
    readJson('status.json', { runs: [] }),
  ]);
  return { products, history, alerts, retail, state, status };
}

// Tiempo compacto para el historial: minutos desde epoch
export const toMin = (date = new Date()) => Math.round(new Date(date).getTime() / 60000);
export const fromMin = (m) => new Date(m * 60000);
