// VG Codeworks: all site settings in one place. Edit this file, commit, done.

const CONTACT = {
  email: 'v.gcodeworks@gmail.com', // swap for your domain address once it's set up
  phoneDisplay: '07427 169493',    // how the number is shown on the site
  phoneIntl: '447427169493',       // same number, international format, no + or spaces (used for WhatsApp)
  telegram: ''                     // your Telegram username, without the @. Telegram options stay hidden while this is empty
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

// Your Cloudflare Worker address (see worker/SETUP.md). Leave '' until it's set up:
// the plate checker and AI quick check then stay hidden/fall back, and enquiries still work.
const API_BASE = '';

// Number plate checker. Keep false until the DVSA API keys are in the Worker (see worker/SETUP.md),
// then set true: the "Check your car" section shows on the homepage and the Check button on the contact page.
const PLATE_CHECKER = false;

// Promo banner shown at the top of every page. Set active: true to switch it on.
// The code itself must also be created in Stripe (Products → Coupons → add a promotion code).
const PROMO = {
  active: false,
  code: 'LAUNCH10',
  text: '10% off your first booking'
};

// Seasonal themes switch on by date. 'auto' = by date, 'off' = never,
// or force one: 'halloween', 'blackfriday', 'christmas', 'easter', 'summer'.
// Preview any theme by adding ?season=christmas to a page address.
const SEASON = 'auto';

// Optional discount code shown on the Black Friday strip (create it in Stripe first). Leave '' for none.
const BLACK_FRIDAY_CODE = '';
