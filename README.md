# 📉 Radar Maxi — alertas de precios de Carrefour

Monitor automático con **dos fuentes separadas**, cada una con sus propias alertas, datos y color en la web:

| | Fuente | Login | Productos |
|---|---|---|---|
| 🏪 **MAYORISTA** | comerciante.carrefour.com.ar (Carrefour Maxi, sucursal **Gualeguaychú**) | sí (cookie de tu sesión) | ~4.000 |
| 🛒 **MINORISTA** | www.carrefour.com.ar (API pública) | **no** | ~18.000 con stock (súper + electro) |

Cada **30 minutos** lee los dos catálogos, guarda el historial de precios y te avisa al celular. Cada aviso arranca con
**🏪 MAYORISTA** o **🛒 MINORISTA** para que nunca se mezclen:

| Alerta | Cuándo salta |
|---|---|
| 🚨 **Posible error de precio** | Bajó **50 % o más** de golpe · menos de la mitad de su precio habitual · **65 %+ por debajo del precio de lista** · precio por kg/l **70 % menor** que el resto de su categoría · (mayorista) menos del 45 % del precio minorista |
| 💰 **Buen margen para reventa** (sólo mayorista) | En **carrefour.com.ar** cuesta **35 % o más** que en Maxi |
| 📉 **Baja fuerte** | Mayorista: bajó **15 %+**. Minorista: bajó **30 %+** (hay muchas promos, por eso el umbral es más alto) |
| 🏆 **Mínimo histórico** | Es el precio más bajo registrado y está 8 % por debajo del habitual |

La **web** (GitHub Pages, gratis) tiene un selector **🏪 Mayorista / 🛒 Minorista** arriba (la barra cambia de color:
azul mayorista, verde minorista) y cada producto lleva su insignia. Pestañas: alertas, reventa (mayorista), mayores bajas,
buscador con precio por kg/l y gráfico del historial.

---

## Cómo funciona

```
GitHub Actions (cada 30 min)
  ├─ 🛒 minorista: catálogo público de carrefour.com.ar (~360 pedidos de 50, ~3 min)
  ├─ 🏪 mayorista: usa tu sesión de Carrefour Maxi (cookie como secret, cifrada entre corridas)
  │     catálogo completo en ~11 pedidos; el margen de reventa usa los precios minoristas
  ├─ reglas de detección + guardas anti falsos positivos
  ├─ avisos: Telegram / ntfy / Discord (sin repetir el mismo aviso)
  ├─ datos → rama "data": mayorista (products/history/alerts.json) y minorista (min-*.json), separados
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
| `CF_COOKIE` | `PHPSESSID=` + el valor que copiaste (ej. `PHPSESSID=abc123…`) |
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
| `MIN_CATEGORIES` | `161,222,255,292,336,347,359,402,451,471,3` | Rubros de carrefour.com.ar (ver `src/config.js`; `71` Hogar, `605` Juguetería, `665` Aire libre…) |
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

### 5. Arrancar
**Actions → Monitor de precios → Run workflow.** Desde ahí corre solo cada 30 minutos.
La primera corrida guarda la base; las alertas empiezan desde la segunda.

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
