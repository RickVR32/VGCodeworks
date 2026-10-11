// VG Codeworks — shared script

// ============================================================
// EDIT: your settings
// ============================================================
const CONTACT = {
  email: 'hello@vgcodeworks.co.uk',
  phoneDisplay: '07XXX XXXXXX',   // how the number is shown on the site
  phoneIntl: '447000000000',      // same number, international format, no + or spaces (used for WhatsApp)
  telegram: 'vgcodeworks'         // your Telegram username, without the @
};

// Paste your booking / payment links once your accounts are set up:
//   single / pack / unlock / diagnostics → paid events in your booking tool, or Stripe Payment Links
//   deposit                              → a Stripe Payment Link
// Leave a link empty and that button sends people to the contact form instead.
const BOOKING_LINKS = {
  single: '',       // Single Tweak £40
  pack: '',         // VAG Tweak Pack £80
  unlock: '',       // Full Unlock £120
  diagnostics: '',  // Diagnostic Scan £50
  deposit: ''       // Retrofit / remap deposit
};

// Promo banner shown at the top of every page. Set active: true to switch it on.
// The code itself must also be created in Stripe (Products → Coupons → add a promotion code).
const PROMO = {
  active: false,
  code: 'LAUNCH10',
  text: '10% off your first booking'
};
// ============================================================

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

// ── Contact form ──
const form = document.getElementById('quote-form');
if (form) {
  const status = document.getElementById('form-status');
  const submitBtn = document.getElementById('send-btn');
  const serviceFor = {
    single: 'Coding / hidden features',
    pack: 'Coding / hidden features',
    unlock: 'Coding / hidden features',
    diagnostics: 'Diagnostics / fault finding',
    deposit: 'OEM retrofit',
    retrofit: 'OEM retrofit',
    stage1: 'Stage 1 remap',
    stage2: 'Stage 2 remap'
  };
  const pre = new URLSearchParams(location.search).get('service');
  if (pre && serviceFor[pre]) form.service.value = serviceFor[pre];

  const channelLabel = { email: 'Email', whatsapp: 'WhatsApp', telegram: 'Telegram' };
  const updateBtn = () => { submitBtn.textContent = 'Send via ' + channelLabel[form.channel.value]; };
  form.querySelectorAll('input[name="channel"]').forEach(r => r.addEventListener('change', updateBtn));
  updateBtn();

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (form.website.value) return; // spam trap
    const name = form.name.value.trim(), contact = form.contact.value.trim(), car = form.car.value.trim();
    if (!name || !contact || !car) {
      status.style.color = '#ff4d4d';
      status.textContent = 'Please fill in your name, contact details and vehicle.';
      return;
    }
    const code = cleanCode(form.code.value);
    if (code) setCode(code);
    const lines = [
      'Hi VG Codeworks, quote request:',
      `Name: ${name}`,
      `Contact: ${contact}`,
      `Vehicle: ${car}`,
      `Reg/VIN: ${form.reg.value.trim() || '-'}`,
      `Service: ${form.service.value}`
    ];
    if (code) lines.push(`Discount code: ${code}`);
    const msg = form.message.value.trim();
    if (msg) lines.push('', msg);
    const body = lines.join('\n');
    const channel = form.channel.value;
    status.style.color = '';

    if (channel === 'whatsapp') {
      window.open('https://wa.me/' + CONTACT.phoneIntl + '?text=' + encodeURIComponent(body), '_blank', 'noopener');
      status.textContent = 'Opening WhatsApp with your message ready to send…';
    } else if (channel === 'telegram') {
      // Copy as a backup in case the Telegram app doesn't pre-fill the text
      try { await navigator.clipboard.writeText(body); } catch (err) {}
      window.open('https://t.me/' + CONTACT.telegram + '?text=' + encodeURIComponent(body), '_blank', 'noopener');
      status.textContent = 'Opening Telegram… Your message is also copied, so just paste it if the chat opens empty.';
    } else {
      const subject = `Quote request: ${form.service.value} (${car})`;
      window.location.href = `mailto:${CONTACT.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      status.textContent = 'Opening your email app… If nothing happens, email ' + CONTACT.email + ' directly.';
    }
  });
}
