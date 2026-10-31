# 📉 Radar Maxi — alertas de precios de Carrefour

Monitor automático con **fuentes separadas**, cada una con sus propias alertas, datos y color en la web:

| | Fuente | Login | Productos |
|---|---|---|---|
| 🏪 **MAYORISTA** | comerciante.carrefour.com.ar — **una por sucursal Maxi** (Gualeguaychú, Zárate, Escobar…) | sí (una cookie por sucursal) | ~5.000 por sucursal |
| 🛒 **MINORISTA** | www.carrefour.com.ar con precios de la tienda **Hiper Gualeguaychú** (retiro en tienda) | **no** | ~10.500 con stock (supermercado) |

Cada **30 minutos** lee todo, guarda el historial de precios y te avisa al celular. Cada aviso arranca con
**🏪 MAYORISTA · Maxi ZARATE** o **🛒 MINORISTA** para que nunca se mezclen.

### 🔥 Oportunidades (funcionan desde la primera lectura, sin historial)

| Señal | Qué significa | Aviso push |
|---|---|---|
| 🏷️ **Gran descuento** | Precio 30 %+ debajo del precio tachado (Maxi) o de lista (minorista) | desde 50 % (Maxi) / 60 % (minorista) |
| 🏪 **Entre sucursales** | Más barato que en las otras sucursales Maxi | desde 35 % |
| 💰 **Reventa** | En carrefour.com.ar cuesta 35 %+ más que en Maxi | desde 150 % |
| 🛒 **Más barato que Maxi** | En carrefour.com.ar sale menos que en Maxi | desde 40 % |
| ⚖️ **Precio por kg** | Precio por kg/l muy bajo para su categoría (sólo en categorías parejas) | sólo en la web |

Si de golpe aparecen muchas (primera vez, sucursal nueva) llega **un solo resumen**, no una lluvia de avisos.

### 🚨 Alertas con historial (a partir de la segunda lectura)

| Alerta | Cuándo salta |
|---|---|
| 🚨 **Posible error de precio** | Bajó **50 %+** de golpe · menos de la mitad de su precio habitual · **65 %+ debajo del precio de lista** · precio por kg/l **70 %** menor que su categoría · (Maxi) menos del 45 % del precio minorista |
| 💰 **Buen margen para reventa** (Maxi) | Al bajar, pasa a costar 35 %+ menos que en carrefour.com.ar |
| 📉 **Baja fuerte** | Maxi: **15 %+**. Minorista: **30 %+** (hay muchas promos) |
| 🏆 **Mínimo histórico** | El precio más bajo registrado y 8 % debajo del habitual |

### 🌐 Web
Selector **🏪 Mayorista / 🛒 Minorista** (azul / verde) y, en mayorista, una pestaña por **sucursal**. Pestañas:
🔥 Oportunidades · Alertas · Reventa · Bajas · Buscar · Estado. En cada producto: gráfico del historial y
**comparación entre sucursales y con el minorista**.

**⬇️ Descargas (CSV, se abren en Excel):** historial de un producto (botón en el detalle), lista de precios y
historial completo de la sucursal (pestaña Buscar) y las oportunidades.

## Cómo funciona

```
GitHub Actions (cada 30 min)
  ├─ 🛒 minorista: catálogo público de carrefour.com.ar (~260 pedidos de 50, ~2 min)
  ├─ 🏪 mayorista: usa tu sesión de Carrefour Maxi (cookie como secret, cifrada entre corridas)
  │     catálogo completo en ~11 pedidos; el margen de reventa usa los precios minoristas
  ├─ reglas de detección + guardas anti falsos positivos
  ├─ avisos: Telegram / ntfy / Discord (sin repetir el mismo aviso)
  ├─ oportunidades sin historial (descuento, entre sucursales, vs minorista, por kg)
  ├─ datos → rama "data": por sucursal (may-<sucursal>-*.json) y minorista (min-*.json), separados
  └─ web → GitHub Pages
GitHub Actions (cada 10 min) → "keepalive": toca el sitio para que la sesión no venza
```

**Robustez**
- Las dos fuentes son independientes: si falta la sesión mayorista, el minorista sigue funcionando.
- Reintentos con espera exponencial ante cortes, 429 y errores 5xx; cada sección se lee por separado.
- Si una corrida lee muchos menos productos que la anterior, la marca como **parcial**.
- Si “baja” más del 25 % del catálogo a la vez, se asume un **error de lectura** y **no** se notifica.
- La primera corrida sólo guarda la base de precios (no dispara alertas).
- No repite avisos: el mismo producto/tipo vuelve a avisar sólo si baja un 3 % más o pasan 24 h.
- Si se vence la sesión te avisa enseguida por Telegram/ntfy (y luego cada 6 h); a la 3ª falla seguida GitHub te manda un mail.
- La sesión se guarda **cifrada** (AES-256-GCM) entre corridas; nunca se publica nada personal.
- Tests automáticos (parser, reglas y un ciclo completo contra un sitio simulado) antes de cada corrida.

---

## Puesta en marcha

### 1. Activar la web
**Settings → Pages → Build and deployment → Source: `GitHub Actions`.**
La web queda en `https://<usuario>.github.io/<repo>/`.

### 2. Conseguir tu cookie de sesión (necesitás una compu)
El sitio sólo muestra precios después de ingresar y elegir sucursal, y ese ingreso tiene **reCAPTCHA**:
lo tenés que hacer vos (una persona), el monitor después reutiliza esa sesión.

**Opción A — Chrome / Edge en la compu**
1. Entrá a <https://comerciante.carrefour.com.ar> → **Ingresar** → Comerciante → Retiro en sucursal →
   **ENTRE RIOS** → **GUALEGUAYCHU – Primera Junta y Ruta 136** → tus datos → Ingresar.
2. Apretá **F12** → pestaña **Application / Aplicación** → **Cookies** → `https://comerciante.carrefour.com.ar`.
3. Copiá el valor de **`PHPSESSID`**.

**Opción B — con Node instalado:** `npm install && npx playwright install chromium && npm run login`
abre un navegador, ingresás normalmente y al terminar te muestra la línea para copiar.

> Desde el iPhone solo no se puede leer la cookie (Safari no tiene herramientas de desarrollador).
> En Mac: Safari → Ajustes → Avanzado → “Mostrar menú Desarrollo” → Desarrollo → Mostrar inspector web → Almacenamiento → Cookies.

### 3. Cargar los secrets
**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Qué poner |
|---|---|
| `CF_COOKIE` | `PHPSESSID=` + el valor que copiaste (ej. `PHPSESSID=abc123…`; también vale sólo el valor) |
| `CF_COOKIE_2`, `CF_COOKIE_3`… | Cookies de otras sucursales (ver “Sumar más sucursales”) |
| `SESSION_SECRET` | Cualquier texto largo y aleatorio (cifra la sesión guardada) |
| `TELEGRAM_BOT_TOKEN` | Token del bot (ver abajo) |
| `TELEGRAM_CHAT_ID` | Tu chat id (ver abajo) |

Opcionales: `NTFY_TOPIC` (avisos push con la app **ntfy**, sin registrarse: elegí un nombre difícil de adivinar),
`DISCORD_WEBHOOK_URL`.

**Variables** (pestaña *Variables*, no son secretas; todas opcionales):

| Variable | Default | |
|---|---|---|
| `CF_REGION` / `CF_SELLER` | `ENTRE RIOS` / `240` | Sólo para mostrar en la web (la sucursal real es la de tu sesión) |
| `ALERT_DROP_PCT` | `0.15` | Baja mínima para “baja fuerte” |
| `ALERT_ERROR_RATIO` | `0.5` | “Posible error” si el precio queda ≤ 50 % del anterior/habitual |
| `ALERT_RESALE_MARGIN` | `0.35` | Margen mínimo de reventa |
| `ALERT_MIN_PRICE` | `300` | Ignora productos más baratos que esto |
| `NOTIFY_TYPES` | `error,reventa,baja,minimo` | Qué tipos mandan push (el resto sólo en la web) |
| `NOTIFY_MAX_PER_RUN` | `25` | Tope de avisos por corrida |
| `MIN_ENABLED` | `true` | Activar el monitor minorista |
| `minorista_tienda` (en `ajustes.json`) | `carrefourar0240` · Hiper Gualeguaychú | Tienda cuyos precios se leen SIEMPRE (nunca el precio online general de carrefour.com.ar). Si no se puede leer, se conservan los últimos precios de esa tienda |
| `MIN_CATEGORIES` | `161,222,255,292,336,347,359,402,451,471` | Rubros de carrefour.com.ar: supermercado (ver `src/config.js`; sumá `3` para Tecnología, `71` Hogar…) |
| `MIN_ALERT_DROP_PCT` | `0.3` | Baja mínima para “baja fuerte” en minorista |
| `MIN_NOTIFY_TYPES` | `error,baja,minimo` | Qué alertas minoristas mandan push |
| `MIN_NOTIFY_MAX_PER_RUN` | `15` | Tope de avisos minoristas por corrida |

Sucursales de Entre Ríos: `266` Paraná (Don Bosco) · `244` Paraná (Yrigoyen) · `233` Concordia · `240` Gualeguaychú
(`npm run sucursales -- "ENTRE RIOS"` para otras provincias).

### 4. Telegram (recomendado)
1. En Telegram hablale a **@BotFather** → `/newbot` → copiá el token → secret `TELEGRAM_BOT_TOKEN`.
2. Mandale cualquier mensaje a tu bot nuevo.
3. Abrí `https://api.telegram.org/bot<TOKEN>/getUpdates` y copiá el número de `"chat":{"id": …}` → secret `TELEGRAM_CHAT_ID`
   (o corré `TELEGRAM_BOT_TOKEN=… node src/telegram-id.js`).

### Sumar más sucursales (Zárate, Escobar…)
Cada sucursal necesita **su propia cookie**. En el iPhone:
1. **Ajustes → Safari → Avanzado → Datos de sitios web** → buscá `carrefour` → **eliminá** `comerciante.carrefour.com.ar`
   (así el siguiente ingreso crea una sesión nueva y no pisa la de Gualeguaychú).
2. Entrá al sitio → Ingresar → Comerciante → Retiro → **BS AS (NORTE)** → **ZARATE - Av. Lavalle 1879**
   (o **CARREFOUR MAXI ESCOBAR - Mateo Gelves 530**) → tus datos.
3. Copiá la cookie `PHPSESSID` y cargala como secret **`CF_COOKIE_2`** (Escobar en **`CF_COOKIE_3`**, etc.).

El monitor detecta solo de qué sucursal es cada cookie. Si una vence, las demás siguen funcionando.

### 5. Arrancar
**Actions → Monitor de precios → Run workflow.** Desde ahí corre solo cada 30 minutos.
La primera corrida guarda la base; las alertas empiezan desde la segunda.

### Que la sesión no se corte (recomendado)
La sesión de Carrefour Maxi **vence si pasa ~25 minutos sin uso**, esté donde esté guardada la cookie.
El repo trae un workflow que la toca cada 5 minutos, pero los horarios de GitHub son “de mejor esfuerzo”
y a veces tardan horas en arrancar. Lo confiable es un servicio externo gratuito: **[cron-job.org](https://cron-job.org)**
(gratis, cada 1 minuto si querés). Vercel gratis no sirve (sus tareas corren una vez por día).

**Opción simple (sin tokens):** un trabajo que toca Carrefour con tu cookie. La cookie queda privada en tu cuenta de cron-job.org.

1. Creá una cuenta en cron-job.org → **Create cronjob**.
2. **URL:** `https://comerciante.carrefour.com.ar/products?currentUrl=sec%2Fbebidas&filters=&orderBy=default&currentPage=1&itemsPerPage=3&method=productsList`
3. **Execution schedule:** *Every 5 minutes*.
4. **Advanced → Headers → Add:** clave `Cookie`, valor `PHPSESSID=` + tu cookie.
5. **Save.** Cuando renueves la cookie, actualizala acá y en el secret `CF_COOKIE`.

**Opción completa (lecturas a horario exacto):** además, un token de GitHub para disparar los workflows.

1. GitHub → foto → *Settings* → *Developer settings* → *Personal access tokens* → *Fine-grained tokens* →
   *Generate new token*. *Repository access*: **Only select repositories** → este repo. *Permissions* →
   *Actions*: **Read and write**. Copiá el token.
2. En cron-job.org, un trabajo cada **30 minutos**: URL
   `https://api.github.com/repos/kiwiplusapp/Carrefour-Mayorista-Precios-/actions/workflows/monitor.yml/dispatches`,
   *Advanced* → método `POST`, headers `Authorization: Bearer TU_TOKEN` y `Accept: application/vnd.github+json`,
   body `{"ref":"main"}`.

### Cuando se vence la sesión
Te llega un aviso **“Se venció la sesión de Carrefour Maxi”** y la web lo muestra arriba.
Repetí el paso 2 y actualizá el secret `CF_COOKIE`. El monitor sigue solo en la próxima corrida.

---

## Correr en tu PC o en un servidor (opcional)

```bash
npm install
cp .env.example .env    # completar los datos
set -a; . ./.env; set +a
npm run login           # ingresás en un navegador visible y queda la sesión guardada
npm run check           # corrida de prueba: no guarda ni notifica
npm start               # una corrida
npm run daemon          # cada 30 min + keepalive cada 10 min + web en http://localhost:8080
npm test
```

## Límites a tener en cuenta
- Los cron de GitHub pueden atrasarse unos minutos en horas pico. Para horario exacto podés usar `npm run daemon`
  en un VPS/PC, o disparar el workflow desde cron-job.org con la API de GitHub (`workflow_dispatch`).
- En repos públicos GitHub pausa los cron tras **60 días sin actividad** en el repo: si pasa, entrá a Actions y reactivalo.
- El margen de reventa compara contra el precio online minorista de carrefour.com.ar; no incluye costos ni impuestos propios.
- Los datos de precios son públicos en la web del repo; tus datos personales y la sesión **no** se publican nunca.

## Estructura
```
src/
  run.js        una corrida completa
  session.js    sesión cifrada, validación e ingreso asistido
  catalog.js    descarga del catálogo por sección
  parse.js      parser de las tarjetas de producto y cantidades (kg/l/u)
  retail.js     precio minorista por EAN (para el margen de reventa)
  retail-catalog.js  catálogo minorista completo de carrefour.com.ar
  detect.js     reglas de alerta (funciones puras, testeadas)
  notify.js     Telegram / ntfy / Discord
  daemon.js     modo servidor (cada 30 min + web local)
web/            dashboard estático (sin dependencias)
test/           tests unitarios + ciclo completo contra sitio simulado
```
