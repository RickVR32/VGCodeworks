/**
 * VG Codeworks backend (Cloudflare Worker)
 *
 * Public (called by the website):
 *   POST /api/vehicle   { reg }                      → car details from the DVSA MOT History API
 *   POST /api/ask       { mode, vehicle, ... }       → AI quick check (Gemini + Google Search)
 *   POST /api/enquiry   { mode, name, contact, ... } → saved to the database and sent to Ric's Telegram
 *
 * Webhooks:
 *   POST /tg            Telegram bot updates (slash commands and buttons)
 *   POST /stripe        Stripe checkout.session.completed → paid booking
 *
 * Private (Garage Desk page, needs ADMIN_TOKEN):
 *   POST /api/admin/all | /api/admin/save | /api/admin/delete | /api/admin/receipt (PDF)
 *
 * Also:
 *   scheduled()  daily run (Cron Trigger): tomorrow's jobs with one-tap reminders, review asks, money owed
 *   email()      Cloudflare Email Routing: incoming mail to your domain → Telegram (+ forwarded to Gmail)
 *
 * Bindings and settings (Worker → Settings → Variables and Secrets / Bindings). See SETUP.md.
 *   DB                          D1 database binding (run schema.sql once)
 *   ALLOWED_ORIGINS             e.g. https://rickvr32.github.io,https://www.vgcodeworks.co.uk
 *   TELEGRAM_BOT_TOKEN          from @BotFather
 *   TELEGRAM_WEBHOOK_SECRET     any long random string, also given to Telegram when setting the webhook
 *   OWNER_CHAT_ID               your Telegram chat id (send /start to the bot to see it)
 *   ADMIN_TOKEN                 long random string, your Garage Desk password
 *   GEMINI_API_KEY, GEMINI_MODEL
 *   MOT_CLIENT_ID, MOT_CLIENT_SECRET, MOT_TOKEN_URL, MOT_API_KEY
 *   STRIPE_WEBHOOK_SECRET       whsec_… from the Stripe webhook endpoint
 *   STRIPE_SECRET_KEY           optional restricted key (read Checkout Sessions) to read product names
 *   GOOGLE_SERVICE_ACCOUNT      the service account JSON key, pasted whole
 *   GOOGLE_CALENDAR_ID          your calendar id (usually your Gmail address)
 *   REVIEW_URL                  your Google review link (for review requests)
 *   FORWARD_TO                  Gmail address incoming domain email is forwarded to (verified in Email Routing)
 */

const TZ = 'Europe/London';
const MOT_BASE = 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration/';
const MOT_SCOPE = 'https://tapi.dvsa.gov.uk/.default';
const VAG_MAKES = ['VOLKSWAGEN', 'VW', 'AUDI', 'SEAT', 'SKODA', 'ŠKODA', 'CUPRA', 'PORSCHE', 'BENTLEY', 'LAMBORGHINI'];

// Per-visitor limits, requests per hour (per Worker instance)
const LIMITS = { vehicle: 30, ask: 12, enquiry: 6 };
const hits = new Map();

// Service list: names, typical length (minutes) and fixed prices
const SERVICES = {
  'Single Tweak': { min: 30, price: 40 },
  'VAG Tweak Pack': { min: 45, price: 80 },
  'Full Unlock': { min: 120, price: 120 },
  'Diagnostic scan': { min: 45, price: 50 },
  'OEM retrofit': { min: 120 },
  'Ambient lighting': { min: 90 },
  'Minor service': { min: 90 },
  'Stage 1 remap': { min: 90 },
  'Stage 2 remap': { min: 120 },
  'Parts sourcing': { min: 30 },
  'Car finding': { min: 60 },
  'Pre-purchase check': { min: 60 },
  'Coding / hidden features': { min: 45 },
  'Diagnostics / fault finding': { min: 45 },
  'Other': { min: 60 }
};

// Your details for receipts and customer messages
const BUSINESS = {
  name: 'VG Codeworks',
  owner: 'Ric Lee',
  area: 'Orpington, London',
  phone: '07427 169493',
  email: 'v.gcodeworks@gmail.com',
  website: 'vgcodeworks.co.uk',
  vatNote: 'Not VAT registered.'
};

let motToken = null;     // { value, expires }
let googleToken = null;  // { value, expires }

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(dailyDigest(env)); },
  async email(message, env, ctx) { await incomingEmail(message, env); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Webhooks: no CORS, their own checks
    if (path === '/tg' && request.method === 'POST') return telegramWebhook(request, env);
    if (path === '/stripe' && request.method === 'POST') return stripeWebhook(request, env);

    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const originOk = allowed.length === 0 || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk && origin ? origin : (allowed[0] || '*'),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Expose-Headers': 'Content-Disposition',
      'Vary': 'Origin'
    };
    const reply = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json', 'X-Robots-Tag': 'noindex' }
    });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return reply({ error: 'Not found' }, 404);
    if (!originOk) return reply({ error: 'Not allowed from this site' }, 403);

    let body;
    try { body = await request.json(); } catch { return reply({ error: 'Bad request' }, 400); }

    try {
      if (path.startsWith('/api/admin/')) {
        if (!env.ADMIN_TOKEN || !safeEqual(request.headers.get('Authorization') || '', 'Bearer ' + env.ADMIN_TOKEN)) {
          return reply({ error: 'Wrong password' }, 401);
        }
        if (path === '/api/admin/receipt') {
          const j = await jobFull(env, Number(body.id));
          if (!j) return reply({ error: 'No such job' }, 404);
          return new Response(receiptPdf(j), { headers: { ...cors, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${receiptName(j)}"` } });
        }
        return reply(await admin(path.slice('/api/admin/'.length), body, env));
      }

      const kind = { '/api/vehicle': 'vehicle', '/api/ask': 'ask', '/api/enquiry': 'enquiry' }[path];
      if (!kind) return reply({ error: 'Not found' }, 404);
      const ip = request.headers.get('CF-Connecting-IP') || 'anon';
      if (limited(ip + kind, LIMITS[kind])) {
        return reply({ error: 'Too many requests in a short time. Please try again later, or WhatsApp Ric.' }, 429);
      }
      if (kind === 'vehicle') return reply(await lookupVehicle(body.reg, env));
      if (kind === 'ask') return reply(await ask(body, env));
      return reply(await enquiry(body, env, ctx));
    } catch (err) {
      return reply({ error: err.publicMessage || 'Something went wrong. Please WhatsApp Ric instead.' }, err.status || 500);
    }
  }
};

// ── Small helpers ──────────────────────────────────────────────────────
function limited(key, max) {
  const now = Date.now(), hour = 3600e3;
  const list = (hits.get(key) || []).filter(t => now - t < hour);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return false;
}
function fail(status, publicMessage) { const e = new Error(publicMessage); e.status = status; e.publicMessage = publicMessage; return e; }
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const html = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const cleanReg = r => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const phoneDigits = p => String(p || '').replace(/[^\d+]/g, '');
const phoneIntl = p => { const d = String(p || '').replace(/\D/g, ''); return d.startsWith('0') ? '44' + d.slice(1) : d; };
const looksLikePhone = s => /^[+\d][\d\s()-]{8,}$/.test(String(s || '').trim());
const looksLikeEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
const money = n => n == null || n === '' ? '' : '£' + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 });

function titleCase(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase())
    .replace(/\b(Vw|Bmw|Gti|Gtd|Tdi|Tsi|Tfsi|Rs|Amg|Suv|Mpv)\b/g, m => m.toUpperCase());
}

// London local time helpers. Times are stored as 'YYYY-MM-DDTHH:MM' London local.
function londonNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
const londonToday = () => londonNow().slice(0, 10);
function addDays(day, n) { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function addMinutes(local, mins) { const d = new Date(local + ':00Z'); d.setUTCMinutes(d.getUTCMinutes() + mins); return d.toISOString().slice(0, 16); }
function niceWhen(local) {
  if (!local) return 'no date';
  const d = new Date(local.slice(0, 10) + 'T12:00:00Z');
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return local.length > 10 ? `${day} ${local.slice(11, 16)}` : day;
}
// Accepts '2026-10-18 10:00', '18/10 10:00', '18/10/2026 10am', 'tomorrow 9:30', 'sat 14:00'
function parseWhen(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  let day = null, rest = t;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) { day = `${m[1]}-${m[2]}-${m[3]}`; rest = t.slice(m[0].length); }
  else if ((m = t.match(/^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?/))) {
    const now = londonToday(); let y = m[3] ? Number(m[3]) : Number(now.slice(0, 4)); if (y < 100) y += 2000;
    day = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    if (!m[3] && day < now) day = `${y + 1}${day.slice(4)}`;
    rest = t.slice(m[0].length);
  } else if ((m = t.match(/^(today|tomorrow|tmrw)/))) {
    day = addDays(londonToday(), m[1] === 'today' ? 0 : 1); rest = t.slice(m[0].length);
  } else if ((m = t.match(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*/))) {
    const want = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(m[1]);
    const today = londonToday(); const now = new Date(today + 'T12:00:00Z').getUTCDay();
    day = addDays(today, ((want - now + 7) % 7) || 7); rest = t.slice(m[0].length);
  }
  if (!day || isNaN(Date.parse(day + 'T00:00:00Z'))) return null;
  const tm = rest.match(/(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)?/);
  if (!tm) return day + 'T09:00';
  let h = Number(tm[1]); const min = Number(tm[2] || 0);
  if (tm[3] === 'pm' && h < 12) h += 12;
  if (tm[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${day}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
function matchService(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  const names = Object.keys(SERVICES);
  return names.find(n => n.toLowerCase() === t) ||
    names.find(n => n.toLowerCase().includes(t)) ||
    names.find(n => t.includes(n.toLowerCase().split(' ')[0])) || clip(text, 60);
}

// ── Database helpers ───────────────────────────────────────────────────
function needDb(env) { if (!env.DB) throw fail(503, 'The database isn\'t connected yet.'); return env.DB; }
const one = (env, sql, ...args) => needDb(env).prepare(sql).bind(...args).first();
const all = async (env, sql, ...args) => (await needDb(env).prepare(sql).bind(...args).all()).results || [];
const run = (env, sql, ...args) => needDb(env).prepare(sql).bind(...args).run();

async function findOrCreateCustomer(env, { name, phone, email }) {
  let c = null;
  if (phone) c = await one(env, `SELECT * FROM customers WHERE replace(replace(phone, ' ', ''), '-', '') = ? LIMIT 1`, phoneDigits(phone));
  if (!c && email) c = await one(env, 'SELECT * FROM customers WHERE lower(email) = lower(?) LIMIT 1', email);
  if (c) {
    await run(env, `UPDATE customers SET name = coalesce(nullif(name, ''), ?), phone = coalesce(nullif(phone, ''), ?), email = coalesce(nullif(email, ''), ?), updated_at = datetime('now') WHERE id = ?`,
      name || '', phone || null, email || null, c.id);
    return c.id;
  }
  const r = await run(env, 'INSERT INTO customers (name, phone, email) VALUES (?, ?, ?)', name || 'Unknown', phone || null, email || null);
  return r.meta.last_row_id;
}
async function findOrCreateCar(env, { reg, model, customerId }) {
  if (!reg) return null;
  const c = await one(env, 'SELECT * FROM cars WHERE reg = ? LIMIT 1', reg);
  if (c) {
    await run(env, `UPDATE cars SET model = coalesce(nullif(model, ''), ?), customer_id = coalesce(customer_id, ?), updated_at = datetime('now') WHERE id = ?`, model || null, customerId || null, c.id);
    return c.id;
  }
  const r = await run(env, 'INSERT INTO cars (reg, model, customer_id) VALUES (?, ?, ?)', reg, model || null, customerId || null);
  return r.meta.last_row_id;
}
async function jobFull(env, id) {
  return one(env, `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, c.area AS customer_area,
      v.reg AS reg, v.model AS car_model, v.notes AS car_notes
    FROM jobs j LEFT JOIN customers c ON c.id = j.customer_id LEFT JOIN cars v ON v.id = j.car_id WHERE j.id = ?`, id);
}

// ── Telegram helpers ───────────────────────────────────────────────────
async function tg(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  return res.json().catch(() => null);
}
function send(env, text, extra = {}, chatId) {
  const chat = chatId || env.OWNER_CHAT_ID;
  if (!chat) return null;
  return tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}
async function sendPhoto(env, dataUrl, caption) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.OWNER_CHAT_ID) return;
  const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m || m[2].length > 2_000_000) return;
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  const form = new FormData();
  form.append('chat_id', String(env.OWNER_CHAT_ID));
  form.append('caption', caption);
  form.append('photo', new Blob([bytes], { type: m[1] }), 'photo.' + m[1].split('/')[1]);
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
}
function jobButtons(j) {
  const row1 = [];
  if (j.customer_phone) row1.push({ text: 'WhatsApp', url: `https://wa.me/${phoneIntl(j.customer_phone)}` });
  row1.push({ text: 'Details', callback_data: `job:${j.id}` });
  const row2 = [];
  if (j.status === 'enquiry') row2.push({ text: 'Book it', callback_data: `book:${j.id}` });
  if (j.status === 'booked') row2.push({ text: 'Mark done', callback_data: `done:${j.id}` });
  if (!j.paid && j.status !== 'cancelled') row2.push({ text: 'Mark paid', callback_data: `paid:${j.id}` });
  if (j.status !== 'cancelled' && j.status !== 'done') row2.push({ text: 'Cancel', callback_data: `cancel:${j.id}` });
  return { inline_keyboard: [row1, row2].filter(r => r.length) };
}
function jobLine(j) {
  const bits = [`<b>#${j.id}</b>`];
  if (j.starts_at) bits.push(niceWhen(j.starts_at));
  bits.push(html(j.service || j.kind || 'Job'));
  if (j.customer_name) bits.push(html(j.customer_name));
  if (j.reg) bits.push(`<code>${html(j.reg)}</code>`);
  if (j.price != null) bits.push(money(j.price) + (j.paid ? ' ✓' : ''));
  else if (j.deposit) bits.push(`dep ${money(j.deposit)}`);
  return bits.join(' · ');
}
function jobCard(j) {
  const status = j.status === 'done' && !j.paid ? 'done, unpaid' : j.status + (j.paid ? ', paid' : '');
  const lines = [
    `<b>#${j.id} ${html(j.service || j.kind || 'Job')}</b> (${html(status)})`,
    `${html(j.customer_name || 'No name')}${j.customer_phone ? ' · ' + html(j.customer_phone) : ''}${j.customer_email ? ' · ' + html(j.customer_email) : ''}`,
    j.reg || j.car_model ? `Car: ${j.reg ? `<code>${html(j.reg)}</code> ` : ''}${html(j.car_model || '')}` : '',
    j.starts_at ? `When: ${niceWhen(j.starts_at)}${j.duration_min ? ` (${j.duration_min} min)` : ''}` : '',
    j.price != null ? `Price: ${money(j.price)}${j.paid ? ' paid' : ''}${j.method ? ' by ' + html(j.method) : ''}` : '',
    j.deposit ? `Deposit paid: ${money(j.deposit)}` : '',
    j.code ? `Discount code: ${html(j.code)}` : '',
    j.details ? `\n${html(j.details)}` : '',
    j.notes ? `\nNotes: ${html(j.notes)}` : ''
  ];
  return lines.filter(Boolean).join('\n');
}

// ── Website enquiry → database + Telegram ──────────────────────────────
const MODE_TITLES = { quote: 'Quote request', fault: 'Fault report', part: 'Part request', source: 'Car sourcing request' };

async function enquiry(b, env, ctx) {
  if (b.website) return { ok: true };                 // spam trap
  const mode = MODE_TITLES[b.mode] ? b.mode : 'quote';
  const name = clip(b.name, 80), contact = clip(b.contact, 120);
  if (!name || !contact) throw fail(400, 'Please add your name and phone or email.');
  const phone = looksLikePhone(contact) ? contact : (looksLikePhone(b.phone) ? clip(b.phone, 30) : '');
  const email = looksLikeEmail(contact) ? contact : '';
  const reg = cleanReg(b.reg);
  const carText = clip(b.car, 120);

  const lines = [];
  if (carText) lines.push(`Car: ${carText}`);
  if (mode === 'quote') { if (b.message) lines.push(clip(b.message, 1500)); }
  if (mode === 'fault') {
    if (b.codes) lines.push(`Codes: ${clip(b.codes, 300).toUpperCase()}`);
    if (b.symptoms) lines.push(`Symptoms: ${clip(b.symptoms, 1500)}`);
  }
  if (mode === 'part' && b.part) lines.push(`Part: ${clip(b.part, 1000)}`);
  if (mode === 'source') {
    if (b.wanted) lines.push(`Looking for: ${clip(b.wanted, 300)}`);
    if (b.budget) lines.push(`Budget: ${clip(b.budget, 80)}`);
    if (b.needs) lines.push(`Needs: ${clip(b.needs, 600)}`);
  }
  if (b.aiUsed) lines.push('(Ran the AI quick check on the site)');
  const details = lines.join('\n');
  const service = mode === 'quote' ? matchService(b.service) : { fault: 'Diagnostics / fault finding', part: 'Parts sourcing', source: 'Car finding' }[mode];
  const code = clip(b.code, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, '');

  let id = null;
  if (env.DB) {
    const customerId = await findOrCreateCustomer(env, { name, phone, email });
    const carId = await findOrCreateCar(env, { reg, model: carText, customerId });
    const r = await run(env, `INSERT INTO jobs (customer_id, car_id, kind, service, status, price, code, details, source, duration_min)
      VALUES (?, ?, ?, ?, 'enquiry', ?, ?, ?, 'website', ?)`,
      customerId, carId, mode, service, (SERVICES[service] || {}).price ?? null, code || null, details, (SERVICES[service] || {}).min || 60);
    id = r.meta.last_row_id;
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.OWNER_CHAT_ID) {
    if (!env.DB) throw fail(503, 'Online enquiries aren\'t switched on yet. Please WhatsApp Ric.');
    return { ok: true, id };
  }

  const j = id ? await jobFull(env, id) : { id: '–', status: 'enquiry', customer_name: name, customer_phone: phone, reg, service, details, code };
  const head = `<b>New ${MODE_TITLES[mode].toLowerCase()}</b>${id ? ` #${id}` : ''}`;
  const text = [head,
    `${html(name)} · ${html(contact)}`,
    reg ? `Reg: <code>${html(reg)}</code>` : '',
    service ? `Service: ${html(service)}` : '',
    code ? `Code: ${html(code)}` : '',
    details ? `\n${html(details)}` : ''].filter(Boolean).join('\n');
  const work = (async () => {
    await send(env, text, id ? { reply_markup: jobButtons(j) } : {});
    if (b.photo) await sendPhoto(env, b.photo, `Photo for ${id ? '#' + id : name}`);
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
  return { ok: true, id };
}

// ── Telegram webhook: slash commands and buttons ───────────────────────
const HELP = `<b>VG Codeworks bot</b>
/today · /tomorrow · /week: what's booked
/jobs: everything open
/enquiries: new enquiries
/owed: done but not paid
/takings: paid this month (/takings 2026-09)
/job 12: full details
/find dave or /find AB17CDE
/car AB17CDE: DVSA lookup and history
/new Name | phone | reg | service | when | price
/book 12 sat 10:00 (or 18/10 10am, 2026-10-18 10:00)
/done 12 · /paid 12 cash · /cancel 12
/price 12 80 · /note 12 text
/remind 12: WhatsApp reminder button
/review 12: ask for a Google review
/invoice 12: PDF receipt or invoice
/digest: tomorrow's jobs and reviews now`;

async function telegramWebhook(request, env) {
  const ok = () => new Response('ok');
  if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response('forbidden', { status: 403 });
  }
  let update; try { update = await request.json(); } catch { return ok(); }

  const owner = String(env.OWNER_CHAT_ID || '');
  if (update.callback_query) {
    const q = update.callback_query;
    const chat = String(q.message && q.message.chat && q.message.chat.id);
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
    if (chat !== owner) return ok();
    const [action, idText] = String(q.data || '').split(':');
    const id = Number(idText);
    try {
      if (action === 'job') return await replyJob(env, id), ok();
      if (action === 'book') return await send(env, `Reply with the date and time, e.g.\n<code>/book ${id} sat 10:00</code>`), ok();
      if (action === 'done') return await setDone(env, id), ok();
      if (action === 'paid') return await setPaid(env, id, ''), ok();
      if (action === 'cancel') return await setCancelled(env, id), ok();
      if (action === 'receipt') { const j = await jobFull(env, id); if (j) await sendDocument(env, receiptPdf(j), receiptName(j), `${j.paid ? 'Receipt' : 'Invoice'} for #${id}`); return ok(); }
    } catch (e) { await send(env, html(e.publicMessage || 'That didn\'t work: ' + e.message)); }
    return ok();
  }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return ok();
  const chat = String(msg.chat.id);
  const text = msg.text.trim();
  const [rawCmd, ...restParts] = text.split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@.*$/, '');
  const rest = text.slice(rawCmd.length).trim();

  if (cmd === '/start' && chat !== owner) {
    await send(env, `Your chat ID is <code>${html(chat)}</code>.\nPut it in the Worker setting OWNER_CHAT_ID, then send /help.`, {}, chat);
    return ok();
  }
  if (chat !== owner) return ok(); // private bot: ignore everyone else

  try {
    await command(env, cmd, rest, restParts);
  } catch (e) {
    await send(env, html(e.publicMessage || 'That didn\'t work: ' + e.message));
  }
  return ok();
}

async function command(env, cmd, rest, parts) {
  const id = Number(parts[0]);
  const listOut = async (title, rows, empty) => send(env, rows.length
    ? `<b>${title}</b>\n` + rows.map(jobLine).join('\n')
    : empty);
  const base = `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone, v.reg AS reg FROM jobs j
    LEFT JOIN customers c ON c.id = j.customer_id LEFT JOIN cars v ON v.id = j.car_id`;

  switch (cmd) {
    case '/start': case '/help':
      return send(env, HELP);
    case '/today': case '/tomorrow': {
      const day = addDays(londonToday(), cmd === '/today' ? 0 : 1);
      const rows = await all(env, `${base} WHERE j.status IN ('booked','done') AND substr(j.starts_at, 1, 10) = ? ORDER BY j.starts_at`, day);
      return listOut(`${cmd === '/today' ? 'Today' : 'Tomorrow'}, ${niceWhen(day)}`, rows, `Nothing booked ${cmd.slice(1)}.`);
    }
    case '/week': {
      const from = londonToday(), to = addDays(from, 7);
      const rows = await all(env, `${base} WHERE j.status = 'booked' AND substr(j.starts_at, 1, 10) >= ? AND substr(j.starts_at, 1, 10) < ? ORDER BY j.starts_at`, from, to);
      return listOut('Next 7 days', rows, 'Nothing booked in the next 7 days.');
    }
    case '/jobs': {
      const rows = await all(env, `${base} WHERE j.status IN ('enquiry','booked') OR (j.status = 'done' AND j.paid = 0) ORDER BY coalesce(j.starts_at, '9999'), j.id LIMIT 40`);
      return listOut('Open jobs', rows, 'No open jobs.');
    }
    case '/enquiries': {
      const rows = await all(env, `${base} WHERE j.status = 'enquiry' ORDER BY j.id DESC LIMIT 25`);
      return listOut('Enquiries', rows, 'No open enquiries.');
    }
    case '/owed': {
      const rows = await all(env, `${base} WHERE j.status = 'done' AND j.paid = 0 ORDER BY j.starts_at`);
      const total = rows.reduce((s, j) => s + (Number(j.price) || 0) - (Number(j.deposit) || 0), 0);
      return listOut(`Owed: ${money(total)}`, rows, 'Nobody owes you anything.');
    }
    case '/takings': {
      const month = /^\d{4}-\d{2}$/.test(parts[0] || '') ? parts[0] : londonToday().slice(0, 7);
      const rows = await all(env, `${base} WHERE j.paid = 1 AND substr(j.paid_at, 1, 7) = ? ORDER BY j.paid_at`, month);
      const deposits = await one(env, `SELECT coalesce(sum(deposit), 0) AS d FROM jobs WHERE paid = 0 AND deposit > 0 AND substr(updated_at, 1, 7) = ?`, month);
      const total = rows.reduce((s, j) => s + (Number(j.price) || 0), 0);
      return send(env, `<b>Takings ${month}: ${money(total)}</b> from ${rows.length} paid job${rows.length === 1 ? '' : 's'}` +
        (deposits && deposits.d ? `\nPlus ${money(deposits.d)} in deposits on unfinished jobs` : '') +
        (rows.length ? '\n' + rows.map(jobLine).join('\n') : ''));
    }
    case '/job': case '/details':
      return replyJob(env, id);
    case '/find': {
      if (!rest) return send(env, 'Usage: /find dave or /find AB17CDE');
      const q = '%' + rest.toLowerCase() + '%', reg = '%' + cleanReg(rest) + '%';
      const rows = await all(env, `${base} WHERE lower(c.name) LIKE ? OR replace(c.phone, ' ', '') LIKE ? OR v.reg LIKE ? OR lower(j.service) LIKE ?
        ORDER BY j.id DESC LIMIT 20`, q, '%' + rest.replace(/\s/g, '') + '%', reg, q);
      return listOut(`Found ${rows.length}`, rows, 'Nothing found.');
    }
    case '/car': {
      const reg = cleanReg(rest);
      if (!reg) return send(env, 'Usage: /car AB17CDE');
      const out = [];
      try {
        const v = await lookupVehicle(reg, env);
        out.push(`<b>${html(v.reg)}</b> ${html([v.firstUsed && v.firstUsed.slice(0, 4), v.make, v.model].filter(Boolean).join(' '))}`,
          html([v.fuel, v.engineSize && v.engineSize + 'cc', v.colour].filter(Boolean).join(' · ')),
          v.motExpiry ? `MOT until ${niceWhen(v.motExpiry.slice(0, 10))}${v.lastMileage ? ' · ' + html(v.lastMileage) : ''}` : '');
      } catch (e) { out.push(`<b>${html(reg)}</b> (DVSA: ${html(e.publicMessage || 'lookup unavailable')})`); }
      const car = env.DB ? await one(env, 'SELECT v.*, c.name AS owner FROM cars v LEFT JOIN customers c ON c.id = v.customer_id WHERE v.reg = ?', reg) : null;
      if (car) {
        if (car.owner) out.push(`Owner: ${html(car.owner)}`);
        if (car.notes) out.push(`\nCoding log:\n${html(car.notes)}`);
        const jobs = await all(env, `${base} WHERE j.car_id = ? ORDER BY j.id DESC LIMIT 10`, car.id);
        if (jobs.length) out.push('\nJobs:\n' + jobs.map(jobLine).join('\n'));
      } else out.push('Not in your records yet.');
      return send(env, out.filter(Boolean).join('\n'));
    }
    case '/new': {
      // /new Name | phone | reg | service | when | price
      const f = rest.split('|').map(s => s.trim());
      if (!f[0]) return send(env, 'Usage: /new Dave | 07123 456789 | AB17CDE | Tweak Pack | sat 10:00 | 80');
      const [name, phone, regText, serviceText, whenText, priceText] = f;
      const service = matchService(serviceText) || 'Other';
      const startsAt = parseWhen(whenText);
      if (whenText && !startsAt) return send(env, `I couldn't read "${html(whenText)}" as a date. Try sat 10:00, 18/10 10am or 2026-10-18 10:00.`);
      const price = priceText ? Number(priceText.replace(/[£,]/g, '')) : (SERVICES[service] || {}).price ?? null;
      const customerId = await findOrCreateCustomer(env, { name, phone: looksLikePhone(phone) ? phone : '', email: looksLikeEmail(phone) ? phone : '' });
      const carId = await findOrCreateCar(env, { reg: cleanReg(regText), customerId });
      const r = await run(env, `INSERT INTO jobs (customer_id, car_id, kind, service, status, starts_at, duration_min, price, source)
        VALUES (?, ?, 'booking', ?, ?, ?, ?, ?, 'telegram')`, customerId, carId, service, startsAt ? 'booked' : 'enquiry',
        startsAt, (SERVICES[service] || {}).min || 60, isNaN(price) ? null : price);
      const newId = r.meta.last_row_id;
      const cal = startsAt ? await syncCalendar(env, newId) : '';
      const j = await jobFull(env, newId);
      return send(env, `Added ${jobLine(j)}${cal}`, { reply_markup: jobButtons(j) });
    }
    case '/book': case '/move': {
      if (!id) return send(env, 'Usage: /book 12 sat 10:00 (add minutes at the end to change the length)');
      const whenText = parts.slice(1).join(' ');
      const lenMatch = whenText.match(/\s(\d{2,3})\s*(?:min|mins)?$/);
      const startsAt = parseWhen(lenMatch ? whenText.slice(0, lenMatch.index) : whenText);
      if (!startsAt) return send(env, `I couldn't read "${html(whenText)}" as a date. Try sat 10:00, 18/10 10am or 2026-10-18 10:00.`);
      const j0 = await jobFull(env, id); if (!j0) return send(env, `No job #${id}.`);
      const mins = lenMatch ? Number(lenMatch[1]) : (j0.duration_min || (SERVICES[j0.service] || {}).min || 60);
      await run(env, `UPDATE jobs SET status = 'booked', starts_at = ?, duration_min = ?, updated_at = datetime('now') WHERE id = ?`, startsAt, mins, id);
      const cal = await syncCalendar(env, id);
      const j = await jobFull(env, id);
      return send(env, `Booked ${jobLine(j)}${cal}`, { reply_markup: jobButtons(j) });
    }
    case '/done': return setDone(env, id);
    case '/paid': return setPaid(env, id, parts.slice(1).join(' '));
    case '/cancel': return setCancelled(env, id);
    case '/price': {
      const p = Number(String(parts[1] || '').replace(/[£,]/g, ''));
      if (!id || isNaN(p)) return send(env, 'Usage: /price 12 80');
      await run(env, `UPDATE jobs SET price = ?, updated_at = datetime('now') WHERE id = ?`, p, id);
      await syncCalendar(env, id);
      return replyJob(env, id);
    }
    case '/remind': {
      const j = id ? await jobFull(env, id) : null; if (!j) return send(env, 'Usage: /remind 12');
      if (!j.customer_phone) return send(env, `#${id} has no phone number.`);
      return send(env, `Reminder for ${jobLine(j)}`, { reply_markup: { inline_keyboard: [[{ text: `Send reminder to ${firstName(j.customer_name)}`, url: waLink(j.customer_phone, reminderText(j)) }]] } });
    }
    case '/review': {
      const j = id ? await jobFull(env, id) : null; if (!j) return send(env, 'Usage: /review 12');
      const b = reviewButton(env, j);
      return b ? send(env, `Review request for ${jobLine(j)}`, { reply_markup: { inline_keyboard: [[b]] } }) : send(env, env.REVIEW_URL ? `#${id} has no phone number.` : 'Add your Google review link as REVIEW_URL in the Worker settings first.');
    }
    case '/invoice': case '/receipt': {
      const j = id ? await jobFull(env, id) : null; if (!j) return send(env, 'Usage: /invoice 12');
      return sendDocument(env, receiptPdf(j), receiptName(j), `${j.paid ? 'Receipt' : 'Invoice'} for #${id}. Forward it to ${html(firstName(j.customer_name))} on WhatsApp or email.`);
    }
    case '/digest':
      return dailyDigest(env, true);
    case '/note': {
      const note = parts.slice(1).join(' ');
      if (!id || !note) return send(env, 'Usage: /note 12 swapped boost hose, cleared P0299');
      const stamp = londonNow().replace('T', ' ');
      await run(env, `UPDATE jobs SET notes = trim(coalesce(notes, '') || char(10) || ?), updated_at = datetime('now') WHERE id = ?`, `${stamp}: ${note}`, id);
      return send(env, `Note added to #${id}.`);
    }
    default:
      return send(env, 'I didn\'t catch that. Send /help for the list of commands.');
  }
}

async function replyJob(env, id) {
  const j = id ? await jobFull(env, id) : null;
  if (!j) return send(env, id ? `No job #${id}.` : 'Usage: /job 12');
  return send(env, jobCard(j), { reply_markup: jobButtons(j) });
}
async function setDone(env, id) {
  const j0 = id ? await jobFull(env, id) : null; if (!j0) return send(env, id ? `No job #${id}.` : 'Usage: /done 12');
  await run(env, `UPDATE jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?`, id);
  await syncCalendar(env, id);
  const j = await jobFull(env, id);
  const due = (Number(j.price) || 0) - (Number(j.deposit) || 0);
  return send(env, `Done: ${jobLine(j)}${j.paid ? '' : due > 0 ? `\n${money(due)} still to pay.` : ''}`, { reply_markup: jobButtons(j) });
}
async function setPaid(env, id, how) {
  const j0 = id ? await jobFull(env, id) : null; if (!j0) return send(env, id ? `No job #${id}.` : 'Usage: /paid 12 cash');
  const amount = (how.match(/£?\s*(\d+(?:\.\d{1,2})?)/) || [])[1];
  const method = clip(how.replace(/£?\s*\d+(?:\.\d{1,2})?/, ''), 40) || j0.method || null;
  await run(env, `UPDATE jobs SET paid = 1, paid_at = ?, method = ?, price = coalesce(?, price), updated_at = datetime('now') WHERE id = ?`,
    londonNow(), method, amount ? Number(amount) : null, id);
  await syncCalendar(env, id);
  const j = await jobFull(env, id);
  const buttons = [[{ text: 'Receipt PDF', callback_data: `receipt:${id}` }]];
  const rb = reviewButton(env, j); if (rb) buttons[0].push(rb);
  return send(env, `Paid: ${jobLine(j)}`, { reply_markup: { inline_keyboard: buttons } });
}
async function setCancelled(env, id) {
  const j0 = id ? await jobFull(env, id) : null; if (!j0) return send(env, id ? `No job #${id}.` : 'Usage: /cancel 12');
  await run(env, `UPDATE jobs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`, id);
  const cal = await syncCalendar(env, id);
  return send(env, `Cancelled #${id}.${cal}`);
}

// ── Stripe webhook ─────────────────────────────────────────────────────
async function verifyStripe(raw, header, secret) {
  const t = (String(header || '').match(/(?:^|,)t=(\d+)/) || [])[1];
  const sigs = [...String(header || '').matchAll(/(?:^|,)v1=([0-9a-f]+)/g)].map(m => m[1]);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => safeEqual(s, hex));
}

async function stripeWebhook(request, env) {
  const raw = await request.text();
  if (!env.STRIPE_WEBHOOK_SECRET || !(await verifyStripe(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return new Response('bad signature', { status: 400 });
  }
  let event; try { event = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  if (event.type !== 'checkout.session.completed') return new Response('ignored');
  const s = event.data && event.data.object || {};
  if (s.payment_status && s.payment_status !== 'paid') return new Response('not paid yet');
  if (env.DB && await one(env, 'SELECT id FROM jobs WHERE stripe_session = ?', s.id)) return new Response('already recorded');

  const amount = (Number(s.amount_total) || 0) / 100;
  let product = '';
  if (env.STRIPE_SECRET_KEY) {
    try {
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(s.id)}/line_items?limit=5`, {
        headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY }
      });
      const li = await r.json();
      product = ((li.data || [])[0] || {}).description || '';
    } catch { /* fall back to price */ }
  }
  if (!product) product = { 40: 'Single Tweak', 80: 'VAG Tweak Pack', 120: 'Full Unlock' }[Math.round(amount + ((s.total_details || {}).amount_discount || 0) / 100)] || 'Stripe payment';
  const isDeposit = /deposit/i.test(product);
  const service = isDeposit ? 'Deposit for quoted job' : (matchService(product) || product);

  const field = label => ((s.custom_fields || []).find(f => (((f.label || {}).custom || '') + ' ' + (f.key || '')).toLowerCase().includes(label)) || {});
  const fieldText = f => (f.text && f.text.value) || (f.dropdown && f.dropdown.value) || (f.numeric && f.numeric.value) || '';
  const reg = cleanReg(fieldText(field('reg')));
  const preferred = clip(fieldText(field('date')) || fieldText(field('time')), 120);
  const cd = s.customer_details || {};
  const discount = ((s.total_details || {}).amount_discount || 0) / 100;

  let id = null;
  if (env.DB) {
    const customerId = await findOrCreateCustomer(env, { name: clip(cd.name, 80) || 'Stripe customer', phone: clip(cd.phone, 30), email: clip(cd.email, 120) });
    const carId = await findOrCreateCar(env, { reg, customerId });
    const startsAt = parseWhen(preferred);
    const details = [preferred ? `Preferred: ${preferred}` : '', discount ? `Discount: ${money(discount)}` : ''].filter(Boolean).join('\n');
    const r = await run(env, `INSERT INTO jobs (customer_id, car_id, kind, service, status, starts_at, duration_min, price, paid, deposit, paid_at, method, details, source, stripe_session)
      VALUES (?, ?, 'booking', ?, 'booked', ?, ?, ?, ?, ?, ?, 'Stripe', ?, 'stripe', ?)`,
      customerId, carId, service, startsAt, (SERVICES[service] || {}).min || 60,
      isDeposit ? null : amount, isDeposit ? 0 : 1, isDeposit ? amount : 0, isDeposit ? null : londonNow(), details, s.id);
    id = r.meta.last_row_id;
    if (startsAt) await syncCalendar(env, id);
  }
  const j = id ? await jobFull(env, id) : null;
  const text = [`<b>Paid ${money(amount)}: ${html(product)}</b>${id ? ` #${id}` : ''}`,
    `${html(cd.name || '')}${cd.phone ? ' · ' + html(cd.phone) : ''}${cd.email ? ' · ' + html(cd.email) : ''}`,
    reg ? `Reg: <code>${html(reg)}</code>` : '',
    preferred ? `Wants: ${html(preferred)}` : '',
    discount ? `Discount used: ${money(discount)}` : '',
    id && !(j && j.starts_at) ? `\nSet the time: <code>/book ${id} sat 10:00</code>` : ''].filter(Boolean).join('\n');
  await send(env, text, j ? { reply_markup: jobButtons(j) } : {});
  return new Response('ok');
}

// ── Google Calendar sync (service account) ─────────────────────────────
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = s => b64url(new TextEncoder().encode(s));

async function getGoogleToken(env) {
  if (googleToken && googleToken.expires > Date.now() + 60e3) return googleToken.value;
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64urlText(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/calendar.events',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64url(sig) })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Google sign-in failed: ' + (data.error_description || data.error || res.status));
  googleToken = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return googleToken.value;
}

// Returns a short note for Telegram replies ('' when calendar isn't set up)
async function syncCalendar(env, id) {
  if (!env.GOOGLE_SERVICE_ACCOUNT || !env.GOOGLE_CALENDAR_ID || !env.DB) return '';
  try {
    const j = await jobFull(env, id);
    if (!j) return '';
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`;
    const token = await getGoogleToken(env);
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const wanted = j.starts_at && j.starts_at.length >= 16 && (j.status === 'booked' || j.status === 'done');

    if (!wanted) {
      if (j.gcal_event_id) {
        await fetch(`${base}/${encodeURIComponent(j.gcal_event_id)}`, { method: 'DELETE', headers });
        await run(env, 'UPDATE jobs SET gcal_event_id = NULL WHERE id = ?', id);
        return '\nRemoved from your calendar.';
      }
      return '';
    }
    const end = addMinutes(j.starts_at, j.duration_min || 60);
    const event = {
      summary: `${j.paid ? '✓ ' : ''}${j.service || 'Job'} · ${j.customer_name || 'Customer'}${j.reg ? ' · ' + j.reg : ''}`,
      location: j.customer_area || undefined,
      description: [`Job #${j.id}`, j.customer_phone ? `Phone: ${j.customer_phone} (WhatsApp https://wa.me/${phoneIntl(j.customer_phone)})` : '',
        j.car_model ? `Car: ${j.car_model}` : '', j.price != null ? `Price: ${money(j.price)}${j.paid ? ' (paid)' : ''}` : '',
        j.deposit ? `Deposit paid: ${money(j.deposit)}` : '', j.details || '', j.notes ? `Notes: ${j.notes}` : ''].filter(Boolean).join('\n'),
      start: { dateTime: j.starts_at + ':00', timeZone: TZ },
      end: { dateTime: end + ':00', timeZone: TZ },
      colorId: j.status === 'done' ? '8' : (j.paid ? '10' : '11')
    };
    let res;
    if (j.gcal_event_id) {
      res = await fetch(`${base}/${encodeURIComponent(j.gcal_event_id)}`, { method: 'PATCH', headers, body: JSON.stringify(event) });
      if (res.status === 404 || res.status === 410) res = null; // deleted in Google: recreate
    }
    if (!res) {
      res = await fetch(base, { method: 'POST', headers, body: JSON.stringify(event) });
    }
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'status ' + res.status);
    if (data.id && data.id !== j.gcal_event_id) await run(env, 'UPDATE jobs SET gcal_event_id = ? WHERE id = ?', data.id, id);
    return '\nCalendar updated.';
  } catch (e) {
    return `\nCalendar sync failed: ${html(e.message).slice(0, 160)}`;
  }
}

// ── Garage Desk (private) ──────────────────────────────────────────────
const FIELDS = {
  customers: ['name', 'phone', 'email', 'area', 'notes'],
  cars: ['reg', 'customer_id', 'model', 'year', 'engine', 'vin', 'notes'],
  jobs: ['customer_id', 'car_id', 'kind', 'service', 'status', 'starts_at', 'duration_min', 'price', 'paid', 'deposit', 'paid_at', 'method', 'code', 'details', 'notes']
};
async function admin(action, b, env) {
  needDb(env);
  if (action === 'all') {
    const [customers, cars, jobs] = await Promise.all([
      all(env, 'SELECT * FROM customers ORDER BY name LIMIT 5000'),
      all(env, 'SELECT * FROM cars ORDER BY reg LIMIT 5000'),
      all(env, 'SELECT * FROM jobs ORDER BY id DESC LIMIT 5000')
    ]);
    return { customers, cars, jobs, calendar: !!(env.GOOGLE_SERVICE_ACCOUNT && env.GOOGLE_CALENDAR_ID), telegram: !!(env.TELEGRAM_BOT_TOKEN && env.OWNER_CHAT_ID) };
  }
  const kind = b.kind;
  if (!FIELDS[kind]) throw fail(400, 'Unknown record type.');
  if (action === 'save') {
    const rec = b.record || {};
    const vals = {};
    for (const f of FIELDS[kind]) if (f in rec) vals[f] = rec[f] === '' ? null : rec[f];
    if (kind === 'cars' && 'reg' in vals) vals.reg = cleanReg(vals.reg);
    if (kind === 'customers' && !vals.name && !rec.id) throw fail(400, 'Add a name first.');
    if (kind === 'cars' && !vals.reg && !rec.id) throw fail(400, 'Add the registration first.');
    if (kind === 'jobs') {
      if ('paid' in vals) vals.paid = vals.paid ? 1 : 0;
      if (vals.paid && !vals.paid_at) vals.paid_at = londonNow();
      if ('paid' in vals && !vals.paid) vals.paid_at = null;
      if (vals.starts_at && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(vals.starts_at)) throw fail(400, 'Date and time look wrong.');
    }
    const keys = Object.keys(vals);
    let id = Number(rec.id) || null;
    if (id) {
      if (keys.length) await run(env, `UPDATE ${kind} SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map(k => vals[k]), id);
    } else {
      if (kind === 'jobs' && !keys.includes('source')) { keys.push('source'); vals.source = 'desk'; }
      const r = await run(env, `INSERT INTO ${kind} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map(k => vals[k]));
      id = r.meta.last_row_id;
    }
    let calendar = '';
    if (kind === 'jobs') calendar = (await syncCalendar(env, id)).trim();
    return { ok: true, id, record: await one(env, `SELECT * FROM ${kind} WHERE id = ?`, id), calendar };
  }
  if (action === 'delete') {
    const id = Number(b.id);
    if (!id) throw fail(400, 'Missing id.');
    if (kind === 'customers') {
      const used = await one(env, 'SELECT (SELECT count(*) FROM jobs WHERE customer_id = ?) + (SELECT count(*) FROM cars WHERE customer_id = ?) AS n', id, id);
      if (used && used.n) throw fail(400, 'This customer still has cars or jobs. Delete or move those first.');
    }
    if (kind === 'cars') {
      const used = await one(env, 'SELECT count(*) AS n FROM jobs WHERE car_id = ?', id);
      if (used && used.n) throw fail(400, 'This car still has jobs. Delete those first.');
    }
    if (kind === 'jobs') { await run(env, `UPDATE jobs SET status = 'cancelled' WHERE id = ?`, id); await syncCalendar(env, id); }
    await run(env, `DELETE FROM ${kind} WHERE id = ?`, id);
    return { ok: true };
  }
  throw fail(404, 'Not found');
}

// ── Reminders, reviews and the daily digest ────────────────────────────
const firstName = n => String(n || 'there').trim().split(/\s+/)[0];
const waLink = (phone, text) => `https://wa.me/${phoneIntl(phone)}?text=${encodeURIComponent(text)}`;
function reminderText(j) {
  const when = j.starts_at ? `${niceWhen(j.starts_at)}` : 'soon';
  return `Hi ${firstName(j.customer_name)}, just confirming I'm booked in for your ${j.service || 'job'}` +
    `${j.reg ? ` on ${j.reg}` : ''} ${j.starts_at && j.starts_at.slice(0, 10) === addDays(londonToday(), 1) ? 'tomorrow at ' + j.starts_at.slice(11, 16) : 'on ' + when}. ` +
    `Please make sure I can park near the car and have the keys handy. Any problems, just message me. Ric, ${BUSINESS.name}`;
}
function reviewButton(env, j) {
  if (!env.REVIEW_URL || !j || !j.customer_phone) return null;
  const text = `Hi ${firstName(j.customer_name)}, thanks again for choosing ${BUSINESS.name}. If you're happy with the ${j.service || 'work'}, ` +
    `a quick Google review would really help me out: ${env.REVIEW_URL}  Cheers, Ric`;
  return { text: `Ask ${firstName(j.customer_name)} for a review`, url: waLink(j.customer_phone, text) };
}
async function dailyDigest(env, manual) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.OWNER_CHAT_ID) return;
  const base = `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone, v.reg AS reg FROM jobs j
    LEFT JOIN customers c ON c.id = j.customer_id LEFT JOIN cars v ON v.id = j.car_id`;
  const tomorrow = addDays(londonToday(), 1), yesterday = addDays(londonToday(), -1);
  const jobs = await all(env, `${base} WHERE j.status = 'booked' AND substr(j.starts_at, 1, 10) = ? ORDER BY j.starts_at`, tomorrow);
  const reviews = await all(env, `${base} WHERE j.paid = 1 AND j.status IN ('done','booked') AND (substr(j.paid_at, 1, 10) = ? OR substr(j.starts_at, 1, 10) = ?) ORDER BY j.id`, yesterday, yesterday);
  const owed = await all(env, `${base} WHERE j.status = 'done' AND j.paid = 0 AND substr(coalesce(j.starts_at, j.updated_at), 1, 10) <= ?`, addDays(londonToday(), -3));
  const enquiries = await one(env, `SELECT count(*) AS n FROM jobs WHERE status = 'enquiry'`);

  const remindRows = jobs.filter(j => j.customer_phone).slice(0, 8).map(j => [{ text: `Remind ${firstName(j.customer_name)} (${j.starts_at.slice(11, 16)})`, url: waLink(j.customer_phone, reminderText(j)) }]);
  if (jobs.length) {
    await send(env, `<b>Tomorrow, ${niceWhen(tomorrow)}</b>\n` + jobs.map(jobLine).join('\n') + (remindRows.length ? '\n\nTap to send each customer a reminder:' : ''),
      remindRows.length ? { reply_markup: { inline_keyboard: remindRows } } : {});
  } else if (manual) await send(env, `Nothing booked for tomorrow (${niceWhen(tomorrow)}).`);

  const reviewRows = reviews.map(j => reviewButton(env, j)).filter(Boolean).slice(0, 8).map(b => [b]);
  if (reviewRows.length) await send(env, `<b>Finished yesterday</b>: ask for a Google review while it's fresh.`, { reply_markup: { inline_keyboard: reviewRows } });

  if (owed.length) {
    const total = owed.reduce((s, j) => s + Math.max(0, (Number(j.price) || 0) - (Number(j.deposit) || 0)), 0);
    await send(env, `<b>Still owed ${money(total)}</b> (3+ days)\n` + owed.map(jobLine).join('\n'));
  }
  if (enquiries && enquiries.n && (manual || new Date().getUTCDay() !== 0)) await send(env, `${enquiries.n} enquir${enquiries.n === 1 ? 'y' : 'ies'} waiting: /enquiries`);
}

// ── Incoming email (Cloudflare Email Routing) → Telegram ───────────────
function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    try {
      const bytes = enc.toUpperCase() === 'B' ? Uint8Array.from(atob(txt), c => c.charCodeAt(0))
        : new TextEncoder().encode(txt.replace(/_/g, ' ')).map((b, i, a) => b);
      if (enc.toUpperCase() === 'Q') return decodeQP(txt.replace(/_/g, ' '));
      return new TextDecoder(cs).decode(bytes);
    } catch { return txt; }
  });
}
function decodeQP(t) {
  const bytes = [];
  const src = t.replace(/=\r?\n/g, '');
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '=' && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) { bytes.push(parseInt(src.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(src.charCodeAt(i) & 0xff);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
function splitHeaders(part) {
  const i = part.search(/\r?\n\r?\n/);
  const head = i < 0 ? part : part.slice(0, i), body = i < 0 ? '' : part.slice(i).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach(line => { const k = line.indexOf(':'); if (k > 0) headers[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim(); });
  return { headers, body };
}
function bodyText(part) {
  const { headers, body } = splitHeaders(part);
  const type = (headers['content-type'] || 'text/plain').toLowerCase();
  const boundary = (headers['content-type'] || '').match(/boundary="?([^";]+)"?/i);
  if (type.startsWith('multipart/') && boundary) {
    const parts = body.split('--' + boundary[1]).slice(1).filter(p => !p.startsWith('--'));
    const texts = parts.map(p => ({ p, t: (splitHeaders(p).headers['content-type'] || 'text/plain').toLowerCase() }));
    const pick = texts.find(x => x.t.startsWith('text/plain')) || texts.find(x => x.t.startsWith('multipart/')) || texts.find(x => x.t.startsWith('text/html'));
    return pick ? bodyText(pick.p) : '';
  }
  const enc = (headers['content-transfer-encoding'] || '').toLowerCase();
  let text = body;
  try {
    if (enc === 'base64') text = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s+/g, '')), c => c.charCodeAt(0)));
    else if (enc === 'quoted-printable') text = decodeQP(body);
  } catch { /* keep raw */ }
  if (type.startsWith('text/html')) text = text.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return text;
}
async function incomingEmail(message, env) {
  try {
    const raw = await new Response(message.raw).text();
    const { headers } = splitHeaders(raw);
    const from = decodeWords(headers.from || message.from);
    const subject = decodeWords(headers.subject || '(no subject)');
    const text = bodyText(raw).replace(/\n{3,}/g, '\n\n').replace(/^>.*$/gm, '').trim();
    const body = text.length > 2500 ? text.slice(0, 2500) + '…' : text;
    await send(env, `<b>Email</b> to ${html(message.to)}\nFrom: ${html(from)}\nSubject: ${html(subject)}\n\n${html(body)}${env.FORWARD_TO ? `\n\n<i>Also in ${html(env.FORWARD_TO)}. Reply from there.</i>` : ''}`);
  } catch (e) {
    await send(env, `<b>Email</b> from ${html(message.from)} (couldn't read it here: ${html(e.message)})`);
  }
  if (env.FORWARD_TO) await message.forward(env.FORWARD_TO);
}

// ── PDF receipts and invoices (hand-built, no libraries) ───────────────
const receiptName = j => `${j.paid ? 'Receipt' : 'Invoice'}-VGC-${String(j.id).padStart(4, '0')}.pdf`;
function receiptPdf(j) {
  const W = 595, H = 842, M = 50;
  const ops = [];
  const enc = s => String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E\xA3]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const color = (r, g, b) => `${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)}`;
  const rect = (x, y, w, h, c) => ops.push(`${color(...c)} rg ${x} ${y} ${w} ${h} re f`);
  const text = (x, y, s, size = 10, font = 'F1', c = [17, 17, 17], spacing = 0) =>
    ops.push(`BT /${font} ${size} Tf ${color(...c)} rg ${spacing} Tc ${x} ${y} Td (${enc(s)}) Tj ET`);
  // Helvetica widths for right-aligning amounts (per 1000 units)
  const widthOf = (s, size) => [...String(s)].reduce((w, ch) => w + ({ '.': 278, ',': 278, '-': 333, ' ': 278 }[ch] || 556), 0) * size / 1000;
  const right = (x, y, s, size = 10, font = 'F1', c) => text(x - widthOf(s, size), y, s, size, font, c);
  const line = (x1, y1, x2, y2, c = [220, 220, 220], w = 0.8) => ops.push(`${color(...c)} RG ${w} w ${x1} ${y1} m ${x2} ${y2} l S`);
  const amt = n => '£' + (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const RED = [209, 0, 0], GREY = [110, 110, 110], INK = [17, 17, 17];

  const isReceipt = !!j.paid;
  const number = 'VGC-' + String(j.id).padStart(4, '0');
  const issued = (j.paid_at || londonNow()).slice(0, 10);
  const nice = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

  // Header band with logo
  rect(0, H - 130, W, 130, [8, 8, 8]);
  text(M, H - 82, 'VG', 40, 'F3', [255, 255, 255], -2);
  rect(M + 58, H - 82, 11, 8, RED);
  text(M + 2, H - 102, 'CODEWORKS', 9, 'F1', [160, 160, 160], 2.4);
  right(W - M, H - 72, isReceipt ? 'RECEIPT' : 'INVOICE', 26, 'F2', [255, 255, 255]);
  right(W - M, H - 96, number, 11, 'F1', [190, 190, 190]);
  rect(0, H - 134, W, 4, RED);

  // From / To
  let y = H - 175;
  text(M, y, 'FROM', 8, 'F2', GREY, 1.2); text(W / 2, y, isReceipt ? 'RECEIVED FROM' : 'BILL TO', 8, 'F2', GREY, 1.2);
  y -= 16;
  const from = [BUSINESS.name, BUSINESS.owner, BUSINESS.area, BUSINESS.phone, BUSINESS.email];
  const to = [j.customer_name || 'Customer', j.customer_phone, j.customer_email, j.customer_area].filter(Boolean);
  from.forEach((l, i) => text(M, y - i * 14, l, 10, i === 0 ? 'F2' : 'F1'));
  to.forEach((l, i) => text(W / 2, y - i * 14, l, 10, i === 0 ? 'F2' : 'F1'));

  // Meta row
  y -= Math.max(from.length, to.length) * 14 + 22;
  const meta = [['DATE', nice(issued)], ['JOB', '#' + j.id], ['VEHICLE', [j.reg, j.car_model].filter(Boolean).join(' ') || '-']];
  meta.forEach(([k, v], i) => { const x = M + i * 165; text(x, y, k, 8, 'F2', GREY, 1.2); text(x, y - 15, v.slice(0, 32), 10); });

  // Line items
  y -= 50;
  rect(M, y - 6, W - 2 * M, 22, [244, 244, 242]);
  text(M + 10, y + 1, 'DESCRIPTION', 8, 'F2', GREY, 1.2); right(W - M - 10, y + 1, 'AMOUNT', 8, 'F2', GREY);
  y -= 28;
  const price = j.price != null ? Number(j.price) : (Number(j.deposit) || 0);
  const desc = (j.service || 'Vehicle work') + (j.starts_at ? ` (${nice(j.starts_at.slice(0, 10))})` : '');
  text(M + 10, y, desc.slice(0, 70), 11, 'F2'); right(W - M - 10, y, amt(price), 11, 'F2');
  if (j.code) { y -= 16; text(M + 10, y, `Discount code applied: ${j.code}`, 9, 'F1', GREY); }
  if (j.notes) {
    const words = String(j.notes).replace(/\s+/g, ' ').split(' '); let cur = '', lines = [];
    for (const w of words) { if ((cur + ' ' + w).length > 90) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; }
    if (cur) lines.push(cur);
    lines.slice(0, 4).forEach(l => { y -= 14; text(M + 10, y, l, 9, 'F1', GREY); });
  }
  y -= 18; line(M, y, W - M, y);

  // Totals
  const deposit = Number(j.deposit) || 0;
  const rows = [['Subtotal', amt(price)]];
  if (deposit && !isReceipt) rows.push(['Deposit paid', '-' + amt(deposit)]);
  y -= 20;
  rows.forEach(([k, v]) => { text(W - M - 220, y, k, 10, 'F1', GREY); right(W - M - 10, y, v, 10); y -= 18; });
  const dueNow = isReceipt ? price : Math.max(0, price - deposit);
  y -= 16;
  rect(W - M - 230, y - 10, 230, 30, isReceipt ? [8, 8, 8] : RED);
  text(W - M - 220, y + 1, isReceipt ? 'TOTAL PAID' : 'BALANCE DUE', 10, 'F2', [255, 255, 255], 1);
  right(W - M - 10, y + 1, amt(dueNow), 13, 'F2', [255, 255, 255]);
  if (isReceipt) { y -= 30; right(W - M - 10, y, `Paid ${nice(issued)}${j.method ? ' by ' + j.method : ''}`, 9, 'F1', GREY); }

  // Notes
  y = 150;
  line(M, y + 20, W - M, y + 20);
  text(M, y, isReceipt ? 'Thank you for choosing VG Codeworks.' : 'Payment due on completion of the work.', 11, 'F2');
  text(M, y - 18, isReceipt ? 'Keep this receipt for your records. Coding changes can be reverted on request.' : 'Pay by card or bank transfer. Message me for payment details or a payment link.', 9, 'F1', GREY);
  text(M, y - 32, BUSINESS.vatNote, 9, 'F1', GREY);
  rect(0, 0, W, 46, [8, 8, 8]);
  text(M, 18, `${BUSINESS.website}  ·  ${BUSINESS.phone}  ·  ${BUSINESS.email}`.replace(/·/g, '|'), 9, 'F1', [190, 190, 190]);
  right(W - M, 18, 'VAG coding  |  diagnostics  |  retrofits', 9, 'F1', [190, 190, 190]);

  // Assemble the PDF (Latin-1 bytes so £ prints)
  const stream = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique /Encoding /WinAnsiEncoding >>'
  ];
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info << /Title (${isReceipt ? 'Receipt' : 'Invoice'} ${number}) /Producer (VG Codeworks) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, ch => ch.charCodeAt(0) & 0xff);
}
async function sendDocument(env, bytes, filename, caption) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.OWNER_CHAT_ID) return;
  const form = new FormData();
  form.append('chat_id', String(env.OWNER_CHAT_ID));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('document', new Blob([bytes], { type: 'application/pdf' }), filename);
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
}

// ── Vehicle lookup (DVSA MOT History API) ──────────────────────────────
async function getMotToken(env) {
  if (motToken && motToken.expires > Date.now() + 60e3) return motToken.value;
  const res = await fetch(env.MOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.MOT_CLIENT_ID, client_secret: env.MOT_CLIENT_SECRET, scope: MOT_SCOPE })
  });
  if (!res.ok) throw fail(502, 'Vehicle lookup is unavailable right now.');
  const data = await res.json();
  motToken = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 1200) * 1000 };
  return motToken.value;
}

async function lookupVehicle(rawReg, env) {
  const reg = cleanReg(rawReg);
  if (!/^[A-Z0-9]{2,8}$/.test(reg)) throw fail(400, 'That doesn\'t look like a UK registration.');
  if (!env.MOT_API_KEY) throw fail(503, 'Vehicle lookup isn\'t switched on yet.');
  const token = await getMotToken(env);
  const res = await fetch(MOT_BASE + encodeURIComponent(reg), {
    headers: { 'Authorization': 'Bearer ' + token, 'X-API-Key': env.MOT_API_KEY, 'Accept': 'application/json' }
  });
  if (res.status === 404) throw fail(404, 'No car found for that registration. Brand-new cars may not be listed yet.');
  if (!res.ok) throw fail(502, 'Vehicle lookup is unavailable right now.');
  const v = await res.json();
  const tests = Array.isArray(v.motTests) ? v.motTests : [];
  const latest = tests[0] || null;
  const make = (v.make || '').toUpperCase();
  return {
    reg: v.registration || reg,
    make: titleCase(v.make),
    model: titleCase(v.model),
    fuel: titleCase(v.fuelType),
    colour: titleCase(v.primaryColour),
    engineSize: v.engineSize ? Number(v.engineSize) : null,
    firstUsed: v.firstUsedDate || v.registrationDate || null,
    motExpiry: latest && latest.expiryDate ? latest.expiryDate : (v.motTestDueDate || null),
    lastMotResult: latest ? latest.testResult : null,
    lastMileage: latest && latest.odometerValue ? `${latest.odometerValue} ${latest.odometerUnit === 'KM' ? 'km' : 'miles'}` : null,
    vag: VAG_MAKES.includes(make)
  };
}

// ── AI quick guide (Gemini + Google Search grounding) ──────────────────
const SYSTEM = `You are the quick-help assistant on the website of VG Codeworks, a UK mobile automotive technician (Ric) based in Orpington, South East London. Ric specialises in VW Group cars (VW, Audi, SEAT, Skoda, Cupra) and also diagnoses and codes most other makes, does minor servicing, and sources parts and vehicles.

Customers use you when Ric can't answer the phone. Use Google Search to check details for the specific car before answering.

Rules:
- British English, plain words, friendly and short (under 220 words). Use short "## " headings and "- " bullets only.
- You give a quick guide, not a diagnosis. Never claim certainty.
- SAFETY FIRST: if anything points to brakes, steering, airbags, fuel leaks, smoke, overheating, oil pressure, a flashing engine light or loss of power on a motorway, start with "## Stop driving" and say why.
- Never invent part numbers or prices. If you mention an OE part number, say it must be checked against the car's VIN.
- Do not tell customers to do risky DIY repairs. Simple checks (fluid levels, fuses, tyre pressures, battery terminals) are fine.
- Finish with "## Next step" pointing them to send the details to Ric.`;

const MODES = {
  fault: f => `A customer reports a fault.
Car: ${f.vehicle}
Fault codes: ${f.codes || 'none given'}
Warning lights / symptoms: ${f.symptoms || 'none given'}
${f.hasImage ? 'They attached a photo (e.g. of the dashboard); describe what it shows first.' : ''}
Give: ## What the codes mean (one line each), ## Most likely causes (ranked, most likely first), ## Safe to drive?, ## Quick checks you can do, ## Next step.`,
  part: f => `A customer needs to identify a part.
Car: ${f.vehicle}
Part description: ${f.part || 'not described'}
${f.hasImage ? 'They attached a photo of the part; identify it from the photo.' : ''}
Give: ## What the part is (its proper name and what it does), ## Things to check before buying (e.g. engine code, PR codes, left/right, VIN check), ## What to search for (2-3 exact search phrases), ## Next step (Ric can source it).`,
  source: f => `A customer wants help buying a car.
Looking for: ${f.wanted || 'not specified'}
Budget: ${f.budget || 'not given'}
Must-haves / use: ${f.needs || 'not given'}
Give: ## Good matches (2-3 models/years that fit the budget), ## Common problems to check on these, ## What to ask the seller, ## Next step (Ric can find, inspect and scan a car for them).`
};

async function ask(body, env) {
  if (!env.GEMINI_API_KEY) throw fail(503, 'The quick check isn\'t switched on yet.');
  const mode = MODES[body.mode] ? body.mode : null;
  if (!mode) throw fail(400, 'Unknown request.');
  const fields = {
    vehicle: clip(body.vehicle, 160) || 'not given', codes: clip(body.codes, 300), symptoms: clip(body.symptoms, 1200),
    part: clip(body.part, 800), wanted: clip(body.wanted, 300), budget: clip(body.budget, 80), needs: clip(body.needs, 800), hasImage: false
  };
  const parts = [];
  if (typeof body.image === 'string') {
    const m = body.image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (m && m[2].length < 1_500_000) { parts.push({ inline_data: { mime_type: m[1], data: m[2] } }); fields.hasImage = true; }
  }
  parts.unshift({ text: MODES[mode](fields) });

  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1200 }
    })
  });
  if (res.status === 429) throw fail(429, 'The quick check is busy right now. Please send your details to Ric instead.');
  if (!res.ok) throw fail(502, 'The quick check is unavailable right now. Please send your details to Ric instead.');
  const data = await res.json();
  const cand = (data.candidates || [])[0] || {};
  const answer = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('').trim();
  if (!answer) throw fail(502, 'No answer came back. Please send your details to Ric instead.');
  const meta = cand.groundingMetadata || {};
  const seen = new Set();
  const sources = (meta.groundingChunks || []).map(c => c.web).filter(Boolean)
    .filter(w => w.uri && !seen.has(w.uri) && seen.add(w.uri)).slice(0, 5)
    .map(w => ({ title: w.title || 'Source', uri: w.uri }));
  const searchHtml = (meta.searchEntryPoint && meta.searchEntryPoint.renderedContent) || '';
  return { answer, sources, searchHtml };
}
