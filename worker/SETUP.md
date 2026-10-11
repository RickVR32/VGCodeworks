# VG Codeworks helper: setup

This folder is the small backend that powers the number plate checker and the AI quick check.
It runs on Cloudflare Workers (free plan) and keeps your keys out of the website.
It contains no keys, so it can sit in your GitHub repo safely, but it only *runs* once pasted into Cloudflare.

## 1. Get your keys

**Google Gemini (AI quick check)**
1. Go to https://aistudio.google.com and sign in with a Google account.
2. Click **Get API key → Create API key**. Copy it.
3. The free tier is fine to start. Note: on the free tier Google may use what customers type to improve its products.
   Once real customers use it, switch on billing in AI Studio (pay-as-you-go), which stops that. Costs are pennies at your volume.

**DVSA MOT History API (plate checker)**
1. Apply at https://documentation.history.mot.api.gov.uk/mot-history-api/register (free, takes up to 5 working days).
2. Your approval email contains: **Client ID, Client secret, Token URL, API key**. Keep it safe.

## 2. Create the Worker

1. Sign up free at https://dash.cloudflare.com.
2. **Workers & Pages → Create → Create Worker**. Name it `vgc-helper` → **Deploy**.
3. Click **Edit code**, delete everything, paste in all of `worker.js`, then **Deploy**.
4. Copy the Worker's address, e.g. `https://vgc-helper.yourname.workers.dev`.

## 3. Add your keys to the Worker

In the Worker: **Settings → Variables and Secrets → Add**. Use type **Secret** for keys.

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | your Google AI Studio key |
| `MOT_CLIENT_ID` | from the DVSA email |
| `MOT_CLIENT_SECRET` | from the DVSA email |
| `MOT_TOKEN_URL` | from the DVSA email |
| `MOT_API_KEY` | from the DVSA email |
| `ALLOWED_ORIGINS` | `https://rickvr32.github.io` (add your domain later, comma-separated) |
| `GEMINI_MODEL` | optional. Leave blank to use `gemini-2.5-flash`, or set a newer model name |

You can add the Gemini key first and the DVSA ones when they arrive: each feature switches on when its keys exist.

## 4. Connect the website

In `main.js`, set:

```js
const API_BASE = 'https://vgc-helper.yourname.workers.dev';
```

Commit to GitHub. Done.

## Good to know
- If the Worker isn't set up (or is down), the site still works: customers just send their details to you as normal.
- Each visitor gets about 12 AI checks and 30 plate lookups per hour. Change `LIMITS` at the top of `worker.js` if needed.
- The DVSA API key is cancelled if unused for 90 days, and the client secret expires every 2 years (they email reminders).
