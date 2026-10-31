// Lista provincias y sucursales con su número (para CF_REGION / CF_SELLER).
// Uso: node src/sucursales.js            → provincias
//      node src/sucursales.js "ENTRE RIOS" → sucursales de esa provincia
import { config } from './config.js';
import { request, CookieJar } from './http.js';

const jar = new CookieJar();
const post = (method, body = '') =>
  request(`${config.baseUrl}seller?method=${method}`, {
    method: 'POST',
    jar,
    body,
    headers: { 'Content-type': 'application/x-www-form-urlencoded' },
  });
const options = (html) => [...html.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);

const region = process.argv[2];
await request(config.baseUrl, { jar });
if (!region) {
  console.log('Provincias:');
  for (const [v] of options(await post('zone'))) console.log(`  ${v}`);
  console.log('\nEjemplo: node src/sucursales.js "ENTRE RIOS"');
} else {
  for (const [type, label] of [[0, 'Retiro en sucursal'], [1, 'Envío']]) {
    console.log(`${label} — ${region}:`);
    for (const [id, name] of options(await post('sellersLists', `zoneId=${encodeURIComponent(region)}&deliveryType=${type}`))) console.log(`  CF_SELLER=${id}  →  ${name}`);
  }
}
