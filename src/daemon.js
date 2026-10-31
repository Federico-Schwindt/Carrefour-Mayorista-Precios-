// Modo servidor (VPS, Raspberry, PC prendida): corre cada INTERVAL_MINUTES
// y sirve la web en http://localhost:PORT. Alternativa a GitHub Actions.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';
import './serve.js';

const every = config.intervalMinutes * 60e3;
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

runOnce();
setInterval(runOnce, every);
