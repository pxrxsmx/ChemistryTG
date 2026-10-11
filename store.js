// Хранилище данных: Upstash Redis (бесплатная внешняя база) или файл data.json.
// Upstash нужен на бесплатном Render: там файлы стираются при каждом засыпании и перезапуске.
// Все данные лежат одним JSON-документом, держатся в памяти и сохраняются целиком после изменения.

const fs = require('fs');
const path = require('path');

const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_KEY = process.env.REDIS_KEY || 'chem-tutor:data';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

const empty = () => ({ availability: {}, bookings: [], settings: { lessonMinutes: 60 } });
function normalize(d) {
  d = d && typeof d === 'object' ? d : empty();
  d.availability ||= {};
  d.bookings ||= [];
  d.settings ||= {};
  d.settings.lessonMinutes ||= 60;
  return d;
}

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Upstash: ${j.error || r.status}`);
  return j.result;
}

async function readRaw() {
  if (useRedis) {
    const v = await redis(['GET', REDIS_KEY]);
    return v ? JSON.parse(v) : null;
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; }
}
async function writeRaw(d) {
  const json = JSON.stringify(d);
  if (useRedis) return redis(['SET', REDIS_KEY, json]);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(d, null, 2));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}

let cache = null;
let loading = null;
async function get() {
  if (cache) return cache;
  loading ||= readRaw().then((d) => { cache = normalize(d); return cache; }).finally(() => { loading = null; });
  return loading;
}

// Изменения выполняются строго по очереди, чтобы два ученика не заняли одно время одновременно.
let queue = Promise.resolve();
function update(fn) {
  const run = queue.then(async () => {
    const d = await get();
    const snapshot = JSON.stringify(d);
    const result = await fn(d);
    if (JSON.stringify(d) !== snapshot) {
      try { await writeRaw(d); }
      catch (e) { cache = normalize(JSON.parse(snapshot)); throw e; } // откат, если сохранить не удалось
    }
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

module.exports = { get, update, backend: useRedis ? 'Upstash Redis' : `файл ${DATA_FILE}` };
