// Репетитор по химии: Telegram-бот + мини-приложение записи + сайт.
// Запуск: node server.js   (настройки — через переменные окружения, см. README.md)
// Без внешних зависимостей.

process.env.TZ = process.env.TZ || 'Europe/Moscow'; // время репетитора (на хостинге часы обычно в UTC)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const bot = require('./bot');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'himiya2026';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DAYS_AHEAD = 28;

// ---------- время ----------
const pad = (n) => String(n).padStart(2, '0');
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toTime = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const isTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const localDate = (dt = new Date()) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
const nowKey = () => { const n = new Date(); return `${localDate(n)} ${toTime(n.getHours() * 60 + n.getMinutes())}`; };
function dateRange(days) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < days; i++) { out.push(localDate(d)); d.setDate(d.getDate() + 1); }
  return out;
}

function slotsForDate(data, date) {
  const len = data.settings.lessonMinutes;
  const booked = new Set(data.bookings.filter((b) => b.date === date).map((b) => b.time));
  const now = new Date();
  const isToday = date === localDate(now);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const slots = [];
  for (const iv of data.availability[date] || []) {
    for (let m = toMin(iv.start); m + len <= toMin(iv.end); m += len) {
      if (isToday && m <= nowMin) continue;
      const t = toTime(m);
      if (!booked.has(t) && !slots.includes(t)) slots.push(t);
    }
  }
  return slots.sort();
}

// Убираем прошедшие дни из расписания, чтобы база не разрасталась
function prune(d) {
  const today = localDate();
  for (const k of Object.keys(d.availability)) if (k < today) delete d.availability[k];
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 60);
  d.bookings = d.bookings.filter((b) => b.date >= localDate(cutoff));
}

// ---------- http-утилиты ----------
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const clean = (s, max) => String(s || '').trim().slice(0, max);
const tgUser = (req) => bot.verifyInitData(req.headers['x-tg-init-data']);
function isAdmin(req) {
  const u = tgUser(req);
  if (u && bot.isAdminId(u.id)) return true;
  return req.headers['x-admin-password'] === ADMIN_PASSWORD;
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- маршруты ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/health') return send(res, 200, { ok: true, storage: store.backend, bot: bot.enabled });

    // Входящие обновления от Telegram (режим вебхука)
    if (p === bot.WEBHOOK_PATH && req.method === 'POST') {
      if (req.headers['x-telegram-bot-api-secret-token'] !== bot.WEBHOOK_SECRET) return send(res, 403, { ok: false });
      const update = await readBody(req);
      send(res, 200, { ok: true });
      bot.handleUpdate(update).catch((e) => console.error('update:', e));
      return;
    }

    if (p === '/api/slots' && req.method === 'GET') {
      const data = await store.get();
      return send(res, 200, { lessonMinutes: data.settings.lessonMinutes, days: dateRange(DAYS_AHEAD).map((date) => ({ date, slots: slotsForDate(data, date) })) });
    }

    if (p === '/api/me' && req.method === 'GET') {
      const u = tgUser(req);
      return send(res, 200, { telegram: Boolean(u), name: u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : '', admin: Boolean(u && bot.isAdminId(u.id)) });
    }

    if (p === '/api/book' && req.method === 'POST') {
      const b = await readBody(req);
      const u = tgUser(req);
      const name = clean(b.name, 80), phone = clean(b.phone, 40), comment = clean(b.comment, 500);
      if (!isDate(b.date) || !isTime(b.time)) return send(res, 400, { error: 'Не выбрано время' });
      if (!name) return send(res, 400, { error: 'Укажите имя' });
      if (!u && phone.replace(/\D/g, '').length < 10) return send(res, 400, { error: 'Укажите телефон' });
      const booking = await store.update((data) => {
        if (!slotsForDate(data, b.date).includes(b.time)) throw new HttpError(409, 'Это время уже заняли, выберите другое');
        const nb = {
          id: crypto.randomUUID(), date: b.date, time: b.time, name, phone, comment, created: new Date().toISOString(),
          ...(u ? { tg: { id: u.id, username: u.username || '' } } : {}),
        };
        prune(data);
        data.bookings.push(nb);
        return nb;
      });
      console.log(`Новая запись: ${booking.date} ${booking.time} — ${name}`);
      await bot.notifyNewBooking(booking); // ждём отправки: на бесплатном хостинге процесс может уснуть сразу после ответа
      return send(res, 201, { ok: true, date: booking.date, time: booking.time });
    }

    if (p === '/api/my' && req.method === 'GET') {
      const u = tgUser(req);
      if (!u) return send(res, 200, { bookings: [] });
      const now = nowKey();
      const mine = (await store.get()).bookings
        .filter((b) => b.tg?.id === u.id && `${b.date} ${b.time}` >= now)
        .sort((a, z) => (a.date + a.time).localeCompare(z.date + z.time))
        .map(({ id, date, time }) => ({ id, date, time }));
      return send(res, 200, { bookings: mine });
    }
    const my = p.match(/^\/api\/my\/([\w-]+)$/);
    if (my && req.method === 'DELETE') {
      const u = tgUser(req);
      if (!u) return send(res, 401, { error: 'Откройте приложение через Telegram' });
      const b = await store.update((data) => {
        const found = data.bookings.find((x) => x.id === my[1] && x.tg?.id === u.id);
        if (!found) throw new HttpError(404, 'Запись не найдена');
        data.bookings = data.bookings.filter((x) => x !== found);
        return found;
      });
      await bot.notifyCancel(b, true);
      return send(res, 200, { ok: true });
    }

    // Кабинет репетитора
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Нет доступа' });

      if (p === '/api/admin/data' && req.method === 'GET') {
        const data = await store.get();
        const today = localDate();
        return send(res, 200, {
          settings: data.settings,
          dates: dateRange(DAYS_AHEAD),
          availability: data.availability,
          bookings: data.bookings.filter((b) => b.date >= today).sort((a, z) => (a.date + a.time).localeCompare(z.date + z.time)),
        });
      }

      if (p === '/api/admin/day' && req.method === 'PUT') {
        const b = await readBody(req);
        if (!isDate(b.date) || !Array.isArray(b.intervals)) return send(res, 400, { error: 'Неверные данные' });
        const ivs = [];
        for (const iv of b.intervals) {
          if (!isTime(iv.start) || !isTime(iv.end) || toMin(iv.start) >= toMin(iv.end)) return send(res, 400, { error: `Проверьте интервал ${iv.start}–${iv.end}` });
          ivs.push({ start: iv.start, end: iv.end });
        }
        ivs.sort((a, z) => toMin(a.start) - toMin(z.start));
        await store.update((data) => {
          prune(data);
          if (ivs.length) data.availability[b.date] = ivs; else delete data.availability[b.date];
        });
        return send(res, 200, { ok: true });
      }

      if (p === '/api/admin/settings' && req.method === 'PUT') {
        const b = await readBody(req);
        const len = Number(b.lessonMinutes);
        if (![45, 60, 90, 120].includes(len)) return send(res, 400, { error: 'Длительность: 45, 60, 90 или 120 минут' });
        await store.update((data) => { data.settings.lessonMinutes = len; });
        return send(res, 200, { ok: true });
      }

      const m = p.match(/^\/api\/admin\/booking\/([\w-]+)$/);
      if (m && req.method === 'DELETE') {
        const b = await store.update((data) => {
          const found = data.bookings.find((x) => x.id === m[1]);
          if (!found) throw new HttpError(404, 'Запись не найдена');
          data.bookings = data.bookings.filter((x) => x !== found);
          return found;
        });
        await bot.notifyCancel(b, false);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Нет такого метода' });
    }

    if (req.method === 'GET') return serveStatic(req, res, decodeURIComponent(p));
    send(res, 404, { error: 'Не найдено' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Ошибка сервера, попробуйте ещё раз' });
  }
});

server.listen(PORT, () => {
  console.log(`Сервер: http://localhost:${PORT}  (мини-приложение: /app.html, кабинет: /admin.html)`);
  console.log(`Хранилище: ${store.backend}`);
  store.get().catch((e) => console.error('Не удалось прочитать данные:', e.message));
  bot.start();
});
