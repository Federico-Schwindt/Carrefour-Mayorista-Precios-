// Modo servidor (VPS, Raspberry, PC prendida): corre cada INTERVAL_MINUTES,
// mantiene viva la sesión cada KEEPALIVE_MINUTES y sirve la web en
// http://localhost:PORT. Alternativa a GitHub Actions (horario exacto).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';
import { loadSavedSession, saveSession, validateSession } from './session.js';
import { CookieJar } from './http.js';
import { log } from './log.js';
import './serve.js';

const every = config.intervalMinutes * 60e3;
const keepaliveEvery = Number(process.env.KEEPALIVE_MINUTES || 10) * 60e3;
let running = false;

function runOnce() {
  if (running) return log.warn('La corrida anterior sigue en curso, salteo esta.');
  running = true;
  const child = spawn(process.execPath, [path.join(config.root, 'src/run.js')], { stdio: 'inherit' });
  const killer = setTimeout(() => child.kill('SIGKILL'), Math.max(every - 60e3, 10 * 60e3));
  child.on('exit', (code) => {
    clearTimeout(killer);
    running = false;
    log.info(`Corrida terminada (código ${code}). Próxima en ${config.intervalMinutes} min.`);
  });
}

async function keepalive() {
  if (running) return;
  const saved = await loadSavedSession();
  const jar = saved?.jar || (config.manualCookie ? CookieJar.fromHeader(config.manualCookie) : null);
  if (!jar) return;
  const v = await validateSession(jar);
  if (v.ok) await saveSession(jar);
  else log.warn('Keepalive: la sesión ya no muestra precios. Renová CF_COOKIE o corré "npm run login".');
}

runOnce();
setInterval(runOnce, every);
setInterval(() => keepalive().catch((e) => log.warn(`Keepalive: ${e.message}`)), keepaliveEvery);
