// Servidor estático mínimo para ver la web localmente: npm run serve
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

const PORT = Number(process.env.PORT || 8080);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

http
  .createServer(async (req, res) => {
    try {
      const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const base = url.startsWith('/data/') ? config.dataDir : path.join(config.root, 'web');
      const rel = url.startsWith('/data/') ? url.slice(6) : url === '/' ? 'index.html' : url.slice(1);
      const file = path.resolve(base, rel);
      if (!file.startsWith(path.resolve(base))) throw new Error('fuera de raíz');
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404).end('No encontrado');
    }
  })
  .listen(PORT, () => log.info(`Web en http://localhost:${PORT}`));
