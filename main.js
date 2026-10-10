// VG Codeworks — shared script

// ============================================================
// EDIT: your settings
// ============================================================
const ENQUIRY_EMAIL = 'hello@vgcodeworks.co.uk';

// Paste your booking / payment links once your accounts are set up:
//   coding / diagnostics → a paid event in your booking tool (Cal.com, Calendly etc. connected to Stripe)
//   deposit              → a Stripe Payment Link
// Leave a link empty and that button sends people to the contact form instead.
const BOOKING_LINKS = {
  coding: '',
  diagnostics: '',
  deposit: ''
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

// Booking buttons
document.querySelectorAll('[data-book]').forEach(b => b.addEventListener('click', () => {
  const key = b.dataset.book;
  const link = BOOKING_LINKS[key];
  if (link) { window.open(link, '_blank', 'noopener'); return; }
  window.location.href = 'contact.html?service=' + encodeURIComponent(key) + '#enquiry';
}));

// Contact form
const form = document.getElementById('quote-form');
if (form) {
  const status = document.getElementById('form-status');
  const serviceFor = {
    coding: 'Coding / hidden features',
    diagnostics: 'Diagnostics / fault finding',
    deposit: 'OEM retrofit',
    retrofit: 'OEM retrofit',
    stage1: 'Stage 1 remap',
    stage2: 'Stage 2 remap'
  };
  const pre = new URLSearchParams(location.search).get('service');
  if (pre && serviceFor[pre]) form.service.value = serviceFor[pre];

  form.addEventListener('submit', e => {
    e.preventDefault();
    if (form.website.value) return; // spam trap
    const name = form.name.value.trim(), contact = form.contact.value.trim(), car = form.car.value.trim();
    if (!name || !contact || !car) {
      status.style.color = '#ff4d4d';
      status.textContent = 'Please fill in your name, contact details and vehicle.';
      return;
    }
    const body = [
      `Name: ${name}`,
      `Contact: ${contact}`,
      `Vehicle: ${car}`,
      `Reg/VIN: ${form.reg.value.trim() || '-'}`,
      `Service: ${form.service.value}`,
      '',
      form.message.value.trim()
    ].join('\n');
    const subject = `Quote request: ${form.service.value} (${car})`;
    window.location.href = `mailto:${ENQUIRY_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    status.style.color = '';
    status.textContent = 'Opening your email app… If nothing happens, email ' + ENQUIRY_EMAIL + ' directly.';
  });
}
