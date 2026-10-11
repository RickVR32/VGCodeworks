/**
 * VG Codeworks helper backend (Cloudflare Worker)
 *
 *   POST /api/vehicle  { reg }                       → car details from the DVSA MOT History API
 *   POST /api/ask      { mode, vehicle, ...fields }  → quick AI guide from Google Gemini, grounded with live Google Search
 *
 * Keys live in Worker settings (Settings → Variables and Secrets), never in the website:
 *   GEMINI_API_KEY      from Google AI Studio
 *   GEMINI_MODEL        optional, defaults to gemini-2.5-flash
 *   MOT_CLIENT_ID       ┐
 *   MOT_CLIENT_SECRET   │ from your DVSA MOT History API credentials email
 *   MOT_TOKEN_URL       │ (https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token)
 *   MOT_API_KEY         ┘
 *   ALLOWED_ORIGINS     comma-separated, e.g. https://rickvr32.github.io,https://www.vgcodeworks.co.uk
 */

const MOT_BASE = 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration/';
const MOT_SCOPE = 'https://tapi.dvsa.gov.uk/.default';
const VAG_MAKES = ['VOLKSWAGEN', 'VW', 'AUDI', 'SEAT', 'SKODA', 'ŠKODA', 'CUPRA', 'PORSCHE', 'BENTLEY', 'LAMBORGHINI'];

// Light per-visitor limit (per Worker instance). Gemini's own quota is the hard cap.
const LIMITS = { vehicle: 30, ask: 12 };   // requests per visitor per hour
const hits = new Map();

let motToken = null; // { value, expires }

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const originOk = allowed.length === 0 || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk && origin ? origin : (allowed[0] || '*'),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const reply = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json' }
    });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return reply({ error: 'Not found' }, 404);
    if (!originOk) return reply({ error: 'Not allowed from this site' }, 403);

    let body;
    try { body = await request.json(); } catch { return reply({ error: 'Bad request' }, 400); }

    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    const kind = path === '/api/vehicle' ? 'vehicle' : path === '/api/ask' ? 'ask' : null;
    if (!kind) return reply({ error: 'Not found' }, 404);
    if (limited(ip + kind, LIMITS[kind])) {
      return reply({ error: 'Too many checks in a short time. Please try again later, or just send your details to Ric.' }, 429);
    }

    try {
      if (kind === 'vehicle') return reply(await lookupVehicle(body.reg, env));
      return reply(await ask(body, env));
    } catch (err) {
      const status = err.status || 500;
      return reply({ error: err.publicMessage || 'Something went wrong. Please send your details to Ric instead.' }, status);
    }
  }
};

function limited(key, max) {
  const now = Date.now(), hour = 3600e3;
  const list = (hits.get(key) || []).filter(t => now - t < hour);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return false;
}

function fail(status, publicMessage) {
  const e = new Error(publicMessage); e.status = status; e.publicMessage = publicMessage; return e;
}

// ── Vehicle lookup (DVSA MOT History API) ─────────────────────────────
async function getMotToken(env) {
  if (motToken && motToken.expires > Date.now() + 60e3) return motToken.value;
  const res = await fetch(env.MOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.MOT_CLIENT_ID,
      client_secret: env.MOT_CLIENT_SECRET,
      scope: MOT_SCOPE
    })
  });
  if (!res.ok) throw fail(502, 'Vehicle lookup is unavailable right now.');
  const data = await res.json();
  motToken = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 1200) * 1000 };
  return motToken.value;
}

async function lookupVehicle(rawReg, env) {
  const reg = String(rawReg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
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

function titleCase(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase())
    .replace(/\b(Vw|Bmw|Gti|Gtd|Tdi|Tsi|Tfsi|Rs|Amg|Suv|Mpv)\b/g, m => m.toUpperCase());
}

// ── AI quick guide (Gemini + Google Search grounding) ─────────────────
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

  const clip = (s, n) => String(s || '').slice(0, n);
  const fields = {
    vehicle: clip(body.vehicle, 160) || 'not given',
    codes: clip(body.codes, 300),
    symptoms: clip(body.symptoms, 1200),
    part: clip(body.part, 800),
    wanted: clip(body.wanted, 300),
    budget: clip(body.budget, 80),
    needs: clip(body.needs, 800),
    hasImage: false
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
  const sources = (meta.groundingChunks || [])
    .map(c => c.web).filter(Boolean)
    .filter(w => w.uri && !seen.has(w.uri) && seen.add(w.uri))
    .slice(0, 5)
    .map(w => ({ title: w.title || 'Source', uri: w.uri }));
  // Google requires showing its search suggestions when grounding is used
  const searchHtml = (meta.searchEntryPoint && meta.searchEntryPoint.renderedContent) || '';

  return { answer, sources, searchHtml };
}
