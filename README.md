# 📉 Radar Maxi — alertas de precios de Carrefour Maxi

Monitor automático de **comerciante.carrefour.com.ar** (Carrefour Maxi mayorista) para la sucursal que elijas
(por defecto **Gualeguaychú – Primera Junta y Ruta 136**, Entre Ríos).

Cada **30 minutos** lee el catálogo completo (~4.000 productos), guarda el historial de precios y te avisa al celular cuando:

| Alerta | Cuándo salta |
|---|---|
| 🚨 **Posible error de precio** | Bajó **50 % o más** de golpe · está a menos de la mitad de su precio habitual · cuesta **menos del 45 %** que en Carrefour minorista · su precio por kg/l es **70 % menor** que el resto de su categoría |
| 💰 **Buen margen para reventa** | El precio en **carrefour.com.ar** (minorista) es **35 % o más** caro que el mayorista |
| 📉 **Baja fuerte** | Bajó **15 % o más** respecto de la lectura anterior |
| 🏆 **Mínimo histórico** | Es el precio más bajo registrado y está 8 % por debajo del habitual |

Además hay una **web** (GitHub Pages, gratis) para ver todo desde el celular: alertas, ranking de margen de reventa,
mayores bajas, buscador con precio por kg/l y gráfico del historial de cada producto.

---

## Cómo funciona

```
GitHub Actions (cada 30 min)
  ├─ sesión con tu sucursal (guardada cifrada; si vence, login automático)
  ├─ catálogo completo: ~11 pedidos al sitio (1.000 productos por pedido)
  ├─ precio minorista en carrefour.com.ar (API pública) por EAN, de a tandas
  ├─ reglas de detección + guardas anti falsos positivos
  ├─ avisos: Telegram / ntfy / Discord (sin repetir el mismo aviso)
  ├─ datos → rama "data" (products, history, alerts, retail, status)
  └─ web → GitHub Pages
```

**Robustez**
- Reintentos con espera exponencial ante cortes, 429 y errores 5xx; cada sección se lee por separado.
- Si una corrida lee muchos menos productos que la anterior, la marca como **parcial**.
- Si “baja” más del 25 % del catálogo a la vez, se asume un **error de lectura** y **no** se notifica.
- La primera corrida sólo guarda la base de precios (no dispara alertas).
- No repite avisos: el mismo producto/tipo vuelve a avisar sólo si baja un 3 % más o pasan 24 h.
- Si falla 2 veces seguidas te avisa por Telegram/ntfy (y luego cada 6 h); a la 3ª, GitHub te manda un mail.
- La sesión se guarda **cifrada** (AES-256-GCM) entre corridas; nunca se publica nada personal.
- Tests automáticos (parser, reglas y un ciclo completo contra un sitio simulado) antes de cada corrida.

---

## Puesta en marcha (10 minutos)

### 1. Activar la web
**Settings → Pages → Build and deployment → Source: `GitHub Actions`.**
La web va a quedar en `https://<usuario>.github.io/<repo>/`.

### 2. Cargar los secrets
**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Qué poner |
|---|---|
| `CF_NAME` | Nombre y apellido (como en el formulario del sitio) |
| `CF_CUIT` | CUIT / DNI |
| `CF_PHONE` | Teléfono con código de área (ej. `03446…`) |
| `CF_EMAIL` | Email |
| `SESSION_SECRET` | Cualquier texto largo y aleatorio (cifra la sesión guardada) |
| `TELEGRAM_BOT_TOKEN` | Token del bot (ver abajo) |
| `TELEGRAM_CHAT_ID` | Tu chat id (ver abajo) |

Opcionales: `NTFY_TOPIC` (avisos push con la app **ntfy**, sin registrarse: elegí un nombre difícil de adivinar),
`DISCORD_WEBHOOK_URL`, `CF_COOKIE` (plan B, ver más abajo).

**Variables** (pestaña *Variables*, no son secretas):

| Variable | Default | |
|---|---|---|
| `CF_REGION` | `ENTRE RIOS` | Provincia tal cual aparece en el sitio |
| `CF_SELLER` | `240` | Número de sucursal (`npm run sucursales -- "ENTRE RIOS"`) |
| `ALERT_DROP_PCT` | `0.15` | Baja mínima para “baja fuerte” |
| `ALERT_ERROR_RATIO` | `0.5` | “Posible error” si el precio queda ≤ 50 % del anterior/habitual |
| `ALERT_RESALE_MARGIN` | `0.35` | Margen mínimo de reventa |
| `ALERT_MIN_PRICE` | `300` | Ignora productos más baratos que esto |
| `NOTIFY_TYPES` | `error,reventa,baja,minimo` | Qué tipos mandan push (el resto sólo en la web) |
| `NOTIFY_MAX_PER_RUN` | `25` | Tope de avisos por corrida |

Sucursales de Entre Ríos: `266` Paraná (Don Bosco) · `244` Paraná (Yrigoyen) · `233` Concordia · `240` Gualeguaychú.

### 3. Telegram (recomendado)
1. En Telegram hablale a **@BotFather** → `/newbot` → copiá el token → secret `TELEGRAM_BOT_TOKEN`.
2. Mandale cualquier mensaje a tu bot nuevo.
3. Abrí `https://api.telegram.org/bot<TOKEN>/getUpdates` y copiá el número de `"chat":{"id": …}` → secret `TELEGRAM_CHAT_ID`
   (o corré `TELEGRAM_BOT_TOKEN=… node src/telegram-id.js`).

### 4. Arrancar
**Actions → Monitor de precios → Run workflow.** Desde ahí corre solo cada 30 minutos.
La primera corrida guarda la base; las alertas empiezan desde la segunda.

---

## Sesión / login

El sitio sólo muestra precios después de elegir sucursal en el formulario de ingreso (nombre, CUIT, teléfono, email),
que está protegido con **reCAPTCHA Enterprise invisible**. El monitor lo resuelve así:

1. Reutiliza la **sesión guardada** de la corrida anterior mientras siga válida.
2. Si venció, abre un **navegador real (Chromium/Playwright)**, completa el mismo formulario y deja que la página
   ejecute su propio reCAPTCHA, como cuando entrás desde el celular.
3. **Plan B** si el login automático no pasa: entrá al sitio desde tu navegador, elegí la sucursal, copiá la cookie
   `PHPSESSID` (herramientas de desarrollador → Aplicación → Cookies) y guardala en el secret `CF_COOKIE`
   como `PHPSESSID=valor`. Cuando venza, el monitor te avisa.

Para probar el login: **Actions → Run workflow → “Forzar login nuevo”**.

---

## Correr en tu PC o en un servidor (opcional)

```bash
npm install
cp .env.example .env    # completar los datos
set -a; . ./.env; set +a
npm run check           # corrida de prueba: no guarda ni notifica
npm start               # una corrida
npm run daemon          # corre cada 30 min y sirve la web en http://localhost:8080
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
  session.js    sesión cifrada, validación y login con navegador
  catalog.js    descarga del catálogo por sección
  parse.js      parser de las tarjetas de producto y cantidades (kg/l/u)
  retail.js     precios de carrefour.com.ar (minorista) por EAN
  detect.js     reglas de alerta (funciones puras, testeadas)
  notify.js     Telegram / ntfy / Discord
  daemon.js     modo servidor (cada 30 min + web local)
web/            dashboard estático (sin dependencias)
test/           tests unitarios + ciclo completo contra sitio simulado
```
