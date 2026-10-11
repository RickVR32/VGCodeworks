// VG Codeworks — shared script

// Settings live in config.js (loaded before this file).

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Footer year
document.querySelectorAll('.yr').forEach(el => { el.textContent = new Date().getFullYear(); });

// Mobile menu
const menuBtn = document.querySelector('.menu-btn');
const navLinks = document.getElementById('nav-links');
if (menuBtn && navLinks) {
  menuBtn.addEventListener('click', () => {
    const open = navLinks.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', open);
    menuBtn.textContent = open ? 'Close' : 'Menu';
  });
}

// Reveal on scroll
const io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
}, { threshold: 0.12 }) : null;
document.querySelectorAll('.reveal').forEach(el => io ? io.observe(el) : el.classList.add('in'));

// ── Contact links: fill every [data-link] from CONTACT ──
if (!CONTACT.telegram) {
  document.querySelectorAll('[data-link="telegram"]').forEach(a => { const row = a.closest('.contact-detail'); (row || a).remove(); });
  document.querySelectorAll('input[name="channel"][value="telegram"]').forEach(r => r.closest('.channel').remove());
  document.querySelectorAll('.channel-options').forEach(o => o.classList.add('two'));
}
const links = {
  phone: { href: 'tel:+' + CONTACT.phoneIntl, text: CONTACT.phoneDisplay },
  whatsapp: { href: 'https://wa.me/' + CONTACT.phoneIntl, text: CONTACT.phoneDisplay },
  telegram: { href: 'https://t.me/' + CONTACT.telegram, text: '@' + CONTACT.telegram },
  email: { href: 'mailto:' + CONTACT.email, text: CONTACT.email }
};
document.querySelectorAll('[data-link]').forEach(a => {
  const l = links[a.dataset.link];
  if (!l) return;
  a.href = l.href;
  if (a.dataset.link !== 'phone' && a.dataset.link !== 'email') { a.target = '_blank'; a.rel = 'noopener'; }
  if (!a.dataset.keepText) a.textContent = l.text;
});

// ── Discount codes ──
// A code can arrive in the URL (?code=LAUNCH10), be typed on the Book page, or come from the promo banner.
// It is remembered for this visit and passed to Stripe checkout, where it is actually checked.
const CODE_KEY = 'vgc_discount_code';
function cleanCode(c) { return (c || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30); }
function getCode() { try { return sessionStorage.getItem(CODE_KEY) || ''; } catch (e) { return window.__vgcCode || ''; } }
function setCode(c) {
  c = cleanCode(c);
  window.__vgcCode = c;
  try { c ? sessionStorage.setItem(CODE_KEY, c) : sessionStorage.removeItem(CODE_KEY); } catch (e) {}
  showCode();
  return c;
}
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) setCode(urlCode);

function showCode() {
  const c = getCode();
  document.querySelectorAll('[data-code-status]').forEach(el => {
    el.textContent = c ? `Code ${c} will be applied at checkout. Codes are checked when you pay.` : '';
  });
  document.querySelectorAll('[data-code-input]').forEach(i => { if (document.activeElement !== i) i.value = c; });
  const field = document.getElementById('f-code');
  if (field && !field.value) field.value = c;
}

// Promo banner
if (PROMO.active && PROMO.code) {
  const bar = document.createElement('div');
  bar.className = 'promo-bar';
  bar.innerHTML = '<span></span><button type="button"></button>';
  bar.querySelector('span').textContent = `${PROMO.text} with code `;
  const b = bar.querySelector('button');
  b.textContent = PROMO.code;
  b.setAttribute('aria-label', `Use code ${PROMO.code}`);
  b.addEventListener('click', () => { setCode(PROMO.code); b.textContent = PROMO.code + ' ✓ applied'; });
  document.body.prepend(bar);
  document.body.classList.add('has-promo');
}

// ── Seasonal themes ──
// Each season: date range, accent colour, banner and an optional effect. Banner wording can be edited here.
const SEASONS = {
  halloween: { banner: 'Spooky season: warning lights giving you a fright? Full diagnostic scan £50.', link: 'contact.html#fault', cta: 'Check a fault', effect: 'embers' },
  blackfriday: { banner: 'Black Friday week', link: 'book.html', cta: 'Book now', effect: null },
  christmas: { banner: 'Festive season: get your car coded before the holidays. Book early, slots go fast.', link: 'book.html', cta: 'Book a slot', effect: 'snow' },
  easter: { banner: 'Easter road trip? A £50 health-check scan before you set off.', link: 'book.html', cta: 'Book a scan', effect: null },
  summer: { banner: 'Summer road-trip ready: a full diagnostic scan before the long drive, £50.', link: 'book.html', cta: 'Book a scan', effect: null }
};
function easterSunday(y) { // Anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}
function seasonFor(now) {
  const y = now.getFullYear(), d = new Date(Date.UTC(y, now.getMonth(), now.getDate()));
  const D = (m, day, yr = y) => new Date(Date.UTC(yr, m - 1, day));
  const between = (a, b) => d >= a && d <= b;
  const nov1 = D(11, 1), firstFri = 1 + ((5 - nov1.getUTCDay() + 7) % 7), bf = D(11, firstFri + 21);
  const bfStart = new Date(bf); bfStart.setUTCDate(bf.getUTCDate() - 4);
  const bfEnd = new Date(bf); bfEnd.setUTCDate(bf.getUTCDate() + 3);
  const easter = easterSunday(y), eStart = new Date(easter), eEnd = new Date(easter);
  eStart.setUTCDate(easter.getUTCDate() - 12); eEnd.setUTCDate(easter.getUTCDate() + 1);
  if (between(bfStart, bfEnd)) return 'blackfriday';
  if (between(D(10, 15), D(11, 6))) return 'halloween';
  if (between(D(12, 1), D(12, 31)) || between(D(1, 1), D(1, 2))) return 'christmas';
  if (between(eStart, eEnd)) return 'easter';
  if (between(D(6, 21), D(8, 31))) return 'summer';
  return null;
}
(function applySeason() {
  const forced = new URLSearchParams(location.search).get('season');
  const setting = typeof SEASON === 'undefined' ? 'auto' : SEASON;
  let season = null;
  if (forced && (SEASONS[forced] || forced === 'off')) season = forced === 'off' ? null : forced;
  else if (setting === 'auto') season = seasonFor(new Date());
  else if (SEASONS[setting]) season = setting;
  if (!season || document.body.dataset.noSeason !== undefined) return;
  document.body.dataset.season = season;
  const cfg = SEASONS[season];

  // Banner (the launch promo banner wins if both are on)
  if (!document.querySelector('.promo-bar')) {
    const bar = document.createElement('div');
    bar.className = 'promo-bar season-bar';
    const words = document.createElement('span');
    words.textContent = cfg.banner;
    bar.appendChild(words);
    const bfCode = typeof BLACK_FRIDAY_CODE === 'string' ? BLACK_FRIDAY_CODE : '';
    if (season === 'blackfriday' && bfCode) {
      words.textContent = 'Black Friday week: use code ';
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = bfCode; b.setAttribute('aria-label', `Use code ${bfCode}`);
      b.addEventListener('click', () => { setCode(bfCode); b.textContent = bfCode + ' ✓ applied'; });
      bar.appendChild(b);
    } else {
      const a = document.createElement('a');
      a.href = cfg.link; a.textContent = cfg.cta;
      bar.appendChild(a);
    }
    document.body.prepend(bar);
    document.body.classList.add('has-promo');
  }

  // Effect: light snowfall or rising embers, drawn on one canvas behind clicks
  if (!cfg.effect || reduceMotion) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'season-fx'; canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = () => { W = canvas.width = innerWidth * dpr; H = canvas.height = innerHeight * dpr; };
  size(); addEventListener('resize', size);
  const n = Math.round(Math.min(70, innerWidth / 18));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const parts = Array.from({ length: n }, () => ({ x: rnd(0, W), y: rnd(0, H), r: rnd(0.8, 2.6) * dpr, s: rnd(0.3, 1.1) * dpr, w: rnd(0, Math.PI * 2), a: rnd(0.35, 0.9) }));
  const snow = cfg.effect === 'snow';
  let last = 0;
  (function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden || t - last < 33) return; // ~30fps is plenty
    last = t;
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.w += 0.02;
      p.x += Math.sin(p.w) * 0.4 * dpr;
      p.y += snow ? p.s : -p.s * 0.9;
      if (snow && p.y > H + 5) { p.y = -5; p.x = rnd(0, W); }
      if (!snow && p.y < -5) { p.y = H + 5; p.x = rnd(0, W); }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = snow ? `rgba(255,255,255,${p.a * 0.8})` : `rgba(255,${Math.round(110 + 60 * Math.sin(p.w * 3))},20,${p.a * (0.6 + 0.4 * Math.sin(p.w * 5))})`;
      ctx.fill();
    }
  })(0);
})();

// Book page code form
document.querySelectorAll('[data-code-form]').forEach(f => f.addEventListener('submit', e => {
  e.preventDefault();
  const input = f.querySelector('[data-code-input]');
  const c = setCode(input.value);
  if (!c) f.querySelector('[data-code-status]').textContent = 'Code removed.';
}));
showCode();

// ── Booking buttons ──
document.querySelectorAll('[data-book]').forEach(b => b.addEventListener('click', () => {
  const key = b.dataset.book;
  let link = BOOKING_LINKS[key];
  const code = getCode();
  if (link) {
    // Stripe Payment Links accept a pre-filled promotion code
    if (code && /buy\.stripe\.com/.test(link)) {
      link += (link.includes('?') ? '&' : '?') + 'prefilled_promo_code=' + encodeURIComponent(code);
    }
    window.open(link, '_blank', 'noopener');
    return;
  }
  window.location.href = 'contact.html?service=' + encodeURIComponent(key) + '#enquiry';
}));

// ── Helpers ──
const esc = str => String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const VEH_KEY = 'vgc_vehicle';
function saveVehicle(v) { try { sessionStorage.setItem(VEH_KEY, JSON.stringify(v)); } catch (e) {} window.__vgcVeh = v; }
function loadVehicle() { try { return JSON.parse(sessionStorage.getItem(VEH_KEY)) || window.__vgcVeh || null; } catch (e) { return window.__vgcVeh || null; } }
function cleanReg(r) { return String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
function vehicleLabel(v) {
  if (!v) return '';
  const year = v.firstUsed ? String(v.firstUsed).slice(0, 4) + ' ' : '';
  return `${year}${v.make || ''} ${v.model || ''}`.trim();
}
function vehicleSpec(v) {
  const bits = [];
  if (v.fuel) bits.push(v.fuel);
  if (v.engineSize) bits.push(v.engineSize + 'cc');
  if (v.colour) bits.push(v.colour);
  return bits.join(' · ');
}
async function api(path, payload) {
  const res = await fetch(API_BASE.replace(/\/$/, '') + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please send your details to Ric instead.');
  return data;
}

// ── Number plate checker ──
// Used on the homepage and the contact page. Without API_BASE it just carries the reg to the contact form.
document.querySelectorAll('[data-plate-widget]').forEach(widget => {
  const input = widget.querySelector('input');
  const btn = widget.querySelector('[data-plate-check]');
  const scope = widget.closest('[data-plate-scope]') || widget.parentElement;
  const out = scope.querySelector('[data-plate-result]');
  const onHome = !!widget.closest('[data-plate-scope]');

  input.addEventListener('input', () => { const p = input.selectionStart; input.value = input.value.toUpperCase(); input.setSelectionRange(p, p); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); btn.click(); } });

  const saved = loadVehicle();
  if (saved && !input.value) { input.value = saved.reg || ''; if (saved.make) render(saved); }
  const urlReg = new URLSearchParams(location.search).get('reg');
  if (urlReg && !input.value) input.value = cleanReg(urlReg);

  function render(v) {
    const badge = v.vag
      ? '<span class="veh-badge ok">VW Group specialist ✓</span>'
      : '<span class="veh-badge">Diagnostics, coding &amp; servicing ✓</span>';
    const mot = v.motExpiry ? `<span>MOT until ${esc(new Date(v.motExpiry).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))}</span>` : '';
    const actions = onHome ? `<div class="veh-actions">
        ${v.vag ? '<a class="btn btn-primary" href="services.html#coding">See coding options</a>' : ''}
        <a class="btn ${v.vag ? 'btn-ghost' : 'btn-primary'}" href="contact.html#fault">Report a fault</a>
        <a class="btn btn-ghost" href="contact.html#quote">Get a quote</a>
      </div>` : '';
    out.innerHTML = `<div class="veh-card">
        <div class="veh-main"><strong>${esc(vehicleLabel(v))}</strong><span>${esc(vehicleSpec(v))}</span>${mot}</div>
        ${badge}
      </div>${actions}`;
    const car = document.getElementById('f-car');
    if (car) car.value = vehicleLabel(v) + (v.fuel ? ' ' + v.fuel : '') + (v.engineSize ? ' ' + v.engineSize + 'cc' : '');
  }

  btn.addEventListener('click', async () => {
    const reg = cleanReg(input.value);
    if (reg.length < 2) { out.innerHTML = '<p class="veh-msg">Enter your registration first.</p>'; input.focus(); return; }
    input.value = reg;
    if (!API_BASE) {
      saveVehicle({ reg });
      if (onHome) { location.href = 'contact.html?reg=' + encodeURIComponent(reg) + '#quote'; }
      else out.innerHTML = '<p class="veh-msg">Got it. Add your make and model below.</p>';
      return;
    }
    btn.disabled = true; btn.textContent = 'Checking…';
    out.innerHTML = '<p class="veh-msg">Looking up your car…</p>';
    try {
      const v = await api('/api/vehicle', { reg });
      saveVehicle(v); render(v);
    } catch (err) {
      saveVehicle({ reg });
      out.innerHTML = `<p class="veh-msg">${esc(err.message)}</p>`;
    } finally { btn.disabled = false; btn.textContent = 'Check'; }
  });
});

// ── Contact / help form ──
const form = document.getElementById('quote-form');
if (form) {
  const status = document.getElementById('form-status');
  const sendBtn = document.getElementById('send-btn');
  const aiBtn = document.getElementById('ai-btn');
  const aiPanel = document.getElementById('ai-panel');
  const tabs = [...form.querySelectorAll('[data-mode]')];
  const MODES = ['quote', 'fault', 'part', 'source'];
  let mode = 'quote';
  let photo = null; // data URL

  const serviceFor = {
    single: 'Coding / hidden features', pack: 'Coding / hidden features', unlock: 'Coding / hidden features',
    diagnostics: 'Diagnostics / fault finding', deposit: 'OEM retrofit', retrofit: 'OEM retrofit',
    service: 'Minor service', stage1: 'Stage 1 remap', stage2: 'Stage 2 remap'
  };
  const pre = new URLSearchParams(location.search).get('service');
  if (pre && serviceFor[pre]) form.service.value = serviceFor[pre];

  function setMode(m, focus) {
    mode = MODES.includes(m) ? m : 'quote';
    tabs.forEach(t => t.setAttribute('aria-selected', t.dataset.mode === mode));
    form.querySelectorAll('[data-for]').forEach(el => {
      const show = el.dataset.for.split(' ').includes(mode);
      el.hidden = !show || (el === aiBtn && !API_BASE);
    });
    aiPanel.hidden = true; aiPanel.innerHTML = ''; status.textContent = '';
    if (focus) tabs.find(t => t.dataset.mode === mode).focus();
  }
  tabs.forEach(t => t.addEventListener('click', () => { setMode(t.dataset.mode); history.replaceState(null, '', '#' + t.dataset.mode); }));
  form.querySelector('[role="tablist"]').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const i = MODES.indexOf(mode) + (e.key === 'ArrowRight' ? 1 : -1);
    setMode(MODES[(i + MODES.length) % MODES.length], true);
  });
  const hashMode = location.hash.replace('#', '');
  setMode(MODES.includes(hashMode) ? hashMode : 'quote');
  if (MODES.includes(hashMode)) setTimeout(() => document.getElementById('enquiry').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }), 50);
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (MODES.includes(h)) { setMode(h); document.getElementById('enquiry').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }); }
  });

  const channelLabel = { email: 'Email', whatsapp: 'WhatsApp', telegram: 'Telegram' };
  // With the backend switched on, "Send to Ric now" goes straight to Ric's Telegram; without it, that option hides
  const directOpt = form.querySelector('input[name="channel"][value="direct"]');
  if (directOpt && !API_BASE) {
    directOpt.closest('.channel').remove();
    const wa = form.querySelector('input[name="channel"][value="whatsapp"]'); if (wa) wa.checked = true;
    form.querySelector('.channel-options').classList.add('two');
  }
  const updateBtn = () => { sendBtn.textContent = form.channel.value === 'direct' ? 'Send to Ric' : 'Send via ' + channelLabel[form.channel.value]; };
  form.querySelectorAll('input[name="channel"]').forEach(r => r.addEventListener('change', updateBtn));
  updateBtn();

  // Photo: shrink to ~1024px JPEG in the browser before sending to the AI
  const photoInput = form.querySelector('[data-photo]');
  const photoPreview = form.querySelector('[data-photo-preview]');
  const photoLabel = form.querySelector('[data-photo-label]');
  photoInput.addEventListener('change', () => {
    const file = photoInput.files[0];
    if (!file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      photo = c.toDataURL('image/jpeg', 0.8);
      photoPreview.src = photo; photoPreview.hidden = false;
      photoLabel.textContent = 'Photo added. Tap to change it';
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { photoLabel.textContent = 'That photo couldn\'t be read. Try a JPG or PNG.'; };
    img.src = url;
  });

  const val = name => (form[name] && form[name].value || '').trim();
  function vehicleText() {
    const v = loadVehicle();
    const reg = cleanReg(val('reg'));
    return [val('car'), reg ? `(reg ${reg})` : ''].filter(Boolean).join(' ') || (v ? vehicleLabel(v) : '');
  }

  function check(forAi) {
    const need = [];
    if (!forAi && !val('name')) need.push('your name');
    if (!forAi && !val('contact')) need.push('your phone or email');
    if (mode !== 'source' && !val('car') && !cleanReg(val('reg'))) need.push('your reg or make & model');
    if (mode === 'fault' && !val('codes') && !val('symptoms') && !photo) need.push('the fault codes or symptoms');
    if (mode === 'part' && !val('part') && !photo) need.push('a description or photo of the part');
    if (mode === 'source' && !val('wanted') && !val('needs')) need.push('what you\'re looking for');
    if (need.length) {
      status.style.color = '#ff4d4d';
      status.textContent = 'Please add ' + need.join(', ') + '.';
      return false;
    }
    status.style.color = '';
    return true;
  }

  // Tiny, safe markdown: headings, bullets, bold. Everything is escaped first.
  function renderMd(md) {
    const lines = esc(md).split('\n');
    let html = '', inList = false;
    const inline = s => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw.trim();
      const li = line.match(/^[-*•]\s+(.*)/);
      if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      if (!line) continue;
      const h = line.match(/^#{1,4}\s+(.*)/);
      html += h ? `<h4>${inline(h[1])}</h4>` : `<p>${inline(line)}</p>`;
    }
    if (inList) html += '</ul>';
    return html;
  }

  let lastAi = '';
  aiBtn.addEventListener('click', async () => {
    if (!check(true)) return;
    aiBtn.disabled = true; aiBtn.textContent = 'Checking…';
    aiPanel.hidden = false;
    aiPanel.innerHTML = '<p class="ai-wait">Searching for your car and putting a quick guide together. This takes around 10–20 seconds…</p>';
    try {
      const data = await api('/api/ask', {
        mode, vehicle: vehicleText(),
        codes: val('codes'), symptoms: val('symptoms'), part: val('part'),
        wanted: val('wanted'), budget: val('budget'), needs: val('needs'),
        image: (mode === 'fault' || mode === 'part') ? photo : null
      });
      lastAi = data.answer;
      const sources = (data.sources || []).filter(s => /^https?:\/\//.test(s.uri))
        .map(s => `<li><a href="${esc(s.uri)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('');
      let shop = '';
      if (mode === 'part') {
        const q = encodeURIComponent(`${val('car')} ${val('part')}`.trim().slice(0, 120));
        shop = `<div class="ai-shop"><span>Search for it:</span>
          <a href="https://www.ebay.co.uk/sch/i.html?_nkw=${q}" target="_blank" rel="noopener">eBay</a>
          <a href="https://www.google.com/search?tbm=shop&q=${q}" target="_blank" rel="noopener">Google Shopping</a>
          <span class="ai-shop-note">Always check fitment by reg or VIN, or ask me to source it.</span></div>`;
      }
      aiPanel.innerHTML = `<div class="ai-head"><span class="ai-tag">AI quick check</span><span>A guide, not a diagnosis. Ric will confirm.</span></div>
        <div class="ai-body">${renderMd(data.answer)}</div>
        ${shop}
        ${sources ? `<details class="ai-sources"><summary>Sources</summary><ul>${sources}</ul></details>` : ''}
        ${data.searchHtml ? '<iframe class="ai-suggest" title="Related Google searches" sandbox="allow-popups allow-popups-to-escape-sandbox" scrolling="no"></iframe>' : ''}
        <p class="ai-next">Happy to take a look? Hit <strong>${esc(sendBtn.textContent)}</strong> to send this to Ric.</p>`;
      const frame = aiPanel.querySelector('.ai-suggest');
      if (frame) { frame.srcdoc = '<base target="_blank">' + data.searchHtml; }
    } catch (err) {
      aiPanel.innerHTML = `<p class="ai-wait">${esc(err.message)}</p>`;
    } finally { aiBtn.disabled = false; aiBtn.textContent = 'Get instant AI check'; }
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (form.website.value) return; // spam trap
    if (!check(false)) return;
    const titles = { quote: 'quote request', fault: 'fault report', part: 'part request', source: 'car sourcing request' };
    const lines = [`Hi Ric, ${titles[mode]}:`, `Name: ${val('name')}`, `Contact: ${val('contact')}`];
    if (mode !== 'source') lines.push(`Vehicle: ${vehicleText() || '-'}`);
    if (mode === 'quote') {
      lines.push(`Service: ${val('service')}`);
      const code = cleanCode(val('code'));
      if (code) { setCode(code); lines.push(`Discount code: ${code}`); }
      if (val('message')) lines.push('', val('message'));
    }
    if (mode === 'fault') {
      if (val('codes')) lines.push(`Fault codes: ${val('codes').toUpperCase()}`);
      if (val('symptoms')) lines.push(`Symptoms: ${val('symptoms')}`);
    }
    if (mode === 'part' && val('part')) lines.push(`Part: ${val('part')}`);
    if (mode === 'source') {
      if (val('wanted')) lines.push(`Looking for: ${val('wanted')}`);
      if (val('budget')) lines.push(`Budget: ${val('budget')}`);
      if (val('needs')) lines.push(`Needs: ${val('needs')}`);
    }
    if (photo) lines.push('', '(I have a photo, I\'ll send it in this chat.)');
    if (lastAi) lines.push('', '(I ran the AI quick check on the website.)');
    const body = lines.join('\n');
    const channel = form.channel.value;

    if (channel === 'direct') {
      sendBtn.disabled = true; const label = sendBtn.textContent; sendBtn.textContent = 'Sending…';
      try {
        await api('/api/enquiry', {
          mode, name: val('name'), contact: val('contact'), reg: cleanReg(val('reg')), car: val('car'),
          service: val('service'), code: cleanCode(val('code')), message: val('message'),
          codes: val('codes'), symptoms: val('symptoms'), part: val('part'),
          wanted: val('wanted'), budget: val('budget'), needs: val('needs'),
          photo: (mode === 'fault' || mode === 'part') ? photo : null, aiUsed: !!lastAi, website: form.website.value
        });
        status.style.color = '#5ad17a';
        status.textContent = 'Sent. Ric has your message' + (photo ? ' and photo' : '') + ' and will reply on WhatsApp or by email, usually within a few hours.';
        sendBtn.textContent = 'Sent ✓';
        setTimeout(() => { sendBtn.disabled = false; sendBtn.textContent = label; }, 4000);
      } catch (err) {
        status.style.color = '#ff4d4d';
        status.textContent = err.message + ' You can choose WhatsApp or Email below instead.';
        sendBtn.disabled = false; sendBtn.textContent = label;
      }
      return;
    }

    if (channel === 'whatsapp') {
      window.open('https://wa.me/' + CONTACT.phoneIntl + '?text=' + encodeURIComponent(body), '_blank', 'noopener');
      status.textContent = 'Opening WhatsApp with your message ready to send…' + (photo ? ' Attach your photo in the chat.' : '');
    } else if (channel === 'telegram') {
      try { navigator.clipboard.writeText(body); } catch (err) {}
      window.open('https://t.me/' + CONTACT.telegram + '?text=' + encodeURIComponent(body), '_blank', 'noopener');
      status.textContent = 'Opening Telegram… Your message is also copied, so just paste it if the chat opens empty.' + (photo ? ' Attach your photo in the chat.' : '');
    } else {
      const subject = `${titles[mode].replace(/^./, c => c.toUpperCase())}: ${vehicleText() || val('wanted') || 'enquiry'}`;
      window.location.href = `mailto:${CONTACT.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      status.textContent = 'Opening your email app…' + (photo ? ' Attach your photo to the email.' : '') + ' If nothing happens, email ' + CONTACT.email + ' directly.';
    }
  });
}
