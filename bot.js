// Telegram-бот: /start с кнопкой мини-приложения, кнопка меню, уведомления.
// На хостинге работает через вебхук (Telegram сам будит сервер), локально — через long polling.

const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
// Адрес приложения. На Render он подставляется автоматически (RENDER_EXTERNAL_URL).
const WEBAPP_URL = (process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const enabled = Boolean(BOT_TOKEN);
// Секретный адрес для вебхука выводится из токена — отдельная настройка не нужна
const tokenHash = crypto.createHash('sha256').update('webhook:' + BOT_TOKEN).digest('hex');
const WEBHOOK_PATH = `/tg/${tokenHash.slice(0, 24)}`;
const WEBHOOK_SECRET = tokenHash.slice(24, 64);
const useWebhook = WEBAPP_URL.startsWith('https://') && process.env.BOT_MODE !== 'polling';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const isAdminId = (id) => ADMIN_IDS.includes(String(id));

async function tg(method, payload = {}) {
  if (!enabled) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 10000),
    });
    const j = await r.json();
    if (!j.ok) console.error(`Telegram ${method}:`, j.description);
    return j.ok ? j.result : null;
  } catch (e) {
    console.error(`Telegram ${method}:`, e.message);
    return null;
  }
}

// ---------- проверка подписи данных мини-приложения ----------
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData, maxAgeSec = 24 * 3600) {
  if (!enabled || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

// ---------- сообщения ----------
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
function prettyDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${d} ${MONTHS[m - 1]} (${WD[dt.getDay()]})`;
}
function who(b) {
  const parts = [`<b>${esc(b.name)}</b>`];
  if (b.phone) parts.push(esc(b.phone));
  if (b.tg?.username) parts.push(`@${esc(b.tg.username)}`);
  else if (b.tg?.id) parts.push(`<a href="tg://user?id=${b.tg.id}">написать в Telegram</a>`);
  return parts.join(', ');
}

async function notifyNewBooking(b) {
  const text = `🧪 <b>Новая запись</b>\n\n📅 ${prettyDate(b.date)}, <b>${b.time}</b>\n👤 ${who(b)}${b.comment ? `\n💬 ${esc(b.comment)}` : ''}`;
  for (const id of ADMIN_IDS) await tg('sendMessage', { chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true });
  if (b.tg?.id) {
    await tg('sendMessage', {
      chat_id: b.tg.id,
      parse_mode: 'HTML',
      text: `✅ Вы записаны на <b>${prettyDate(b.date)}, ${b.time}</b>.\n\nРепетитор свяжется с вами для подтверждения. Посмотреть или отменить запись можно в приложении.`,
      reply_markup: appKeyboard(),
    });
  }
}

async function notifyCancel(b, byStudent) {
  const line = `📅 ${prettyDate(b.date)}, <b>${b.time}</b>`;
  if (byStudent) {
    for (const id of ADMIN_IDS) await tg('sendMessage', { chat_id: id, parse_mode: 'HTML', text: `❌ <b>Ученик отменил запись</b>\n\n${line}\n👤 ${who(b)}\n\nСлот снова свободен.` });
  } else if (b.tg?.id) {
    await tg('sendMessage', { chat_id: b.tg.id, parse_mode: 'HTML', text: `❌ Занятие ${line} отменено репетитором.\n\nВыберите другое время в приложении 👇`, reply_markup: appKeyboard() });
  }
}

function appKeyboard(admin = false) {
  if (!WEBAPP_URL) return undefined;
  const rows = [[{ text: '📅 Записаться на занятие', web_app: { url: `${WEBAPP_URL}/app.html` } }]];
  if (admin) rows.push([{ text: '⚙️ Кабинет репетитора', web_app: { url: `${WEBAPP_URL}/admin.html` } }]);
  return { inline_keyboard: rows };
}

// ---------- обработка входящих сообщений ----------
async function handleUpdate(u) {
  const msg = u.message;
  if (!msg?.text) return;
  const chat = msg.chat.id;
  const from = msg.from || {};
  const cmd = msg.text.split(/[\s@]/)[0];

  if (cmd === '/start') {
    const admin = isAdminId(from.id);
    await tg('sendMessage', {
      chat_id: chat,
      parse_mode: 'HTML',
      text: admin
        ? `Здравствуйте! Вы вошли как <b>репетитор</b>.\n\nВ кабинете задайте свободные окна на каждый день. О каждой новой записи я сразу пришлю сообщение сюда.`
        : `Здравствуйте, ${esc(from.first_name || '')}! 👋\n\nЯ помогу записаться на занятия по <b>химии для подготовки к ОГЭ</b> (9 класс).\n\nНажмите кнопку ниже, выберите удобный день и время — это займёт меньше минуты.`,
      reply_markup: appKeyboard(admin),
    });
    if (!WEBAPP_URL) await tg('sendMessage', { chat_id: chat, text: '⚠️ Не задан WEBAPP_URL — кнопки приложения появятся после настройки сервера.' });
    return;
  }
  if (cmd === '/myid') {
    await tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', text: `Ваш Telegram ID: <code>${from.id}</code>\n\nЧтобы стать репетитором в этом боте, укажите его в настройке ADMIN_IDS на сервере.` });
    return;
  }
  if (cmd === '/admin') {
    if (!isAdminId(from.id)) return tg('sendMessage', { chat_id: chat, text: 'Эта команда только для репетитора.' });
    return tg('sendMessage', { chat_id: chat, text: 'Кабинет репетитора:', reply_markup: appKeyboard(true) });
  }
  await tg('sendMessage', { chat_id: chat, text: 'Чтобы записаться, нажмите кнопку ниже 👇', reply_markup: appKeyboard(isAdminId(from.id)) });
}

async function setup() {
  const me = await tg('getMe');
  if (!me) { console.error('Не удалось подключиться к боту — проверьте BOT_TOKEN.'); return false; }
  console.log(`Бот: @${me.username}`);
  await tg('setMyCommands', { commands: [
    { command: 'start', description: 'Записаться на занятие' },
    { command: 'myid', description: 'Узнать свой Telegram ID' },
  ] });
  if (WEBAPP_URL) {
    await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Записаться', web_app: { url: `${WEBAPP_URL}/app.html` } } });
  } else console.log('Адрес приложения не задан (WEBAPP_URL) — кнопки записи не появятся.');
  if (!ADMIN_IDS.length) console.log('ADMIN_IDS пуст — напишите боту /myid и укажите свой ID в настройках.');
  return true;
}

async function start() {
  if (!enabled) { console.log('BOT_TOKEN не задан — бот выключен, работает только сайт.'); return; }
  if (!(await setup())) return;
  if (useWebhook) {
    const ok = await tg('setWebhook', { url: WEBAPP_URL + WEBHOOK_PATH, secret_token: WEBHOOK_SECRET, allowed_updates: ['message'] });
    console.log(ok ? 'Бот работает через вебхук.' : 'Не удалось включить вебхук.');
    return;
  }
  await tg('deleteWebhook', {});
  console.log('Бот работает через long polling.');
  let offset = 0;
  for (;;) {
    const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
    if (!updates) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    for (const u of updates) {
      offset = u.update_id + 1;
      handleUpdate(u).catch((e) => console.error('update:', e));
    }
  }
}

module.exports = { enabled, verifyInitData, isAdminId, notifyNewBooking, notifyCancel, handleUpdate, start, WEBHOOK_PATH, WEBHOOK_SECRET };
