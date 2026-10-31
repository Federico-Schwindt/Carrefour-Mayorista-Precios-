// Muestra el chat_id para TELEGRAM_CHAT_ID.
// 1) Creá un bot con @BotFather y copiá el token.
// 2) Mandale cualquier mensaje a tu bot (o agregalo a un grupo y escribí algo).
// 3) TELEGRAM_BOT_TOKEN=123:abc node src/telegram-id.js
const token = process.env.TELEGRAM_BOT_TOKEN || process.argv[2];
if (!token) {
  console.log('Uso: TELEGRAM_BOT_TOKEN=123:abc node src/telegram-id.js');
  process.exit(1);
}
const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const j = await r.json();
if (!j.ok) {
  console.log('Telegram respondió:', j.description);
  process.exit(1);
}
const chats = new Map();
for (const u of j.result) {
  const c = (u.message || u.channel_post || u.my_chat_member)?.chat;
  if (c) chats.set(c.id, c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username);
}
if (!chats.size) console.log('No hay mensajes. Escribile algo a tu bot y volvé a correr esto.');
for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}   (${name})`);
