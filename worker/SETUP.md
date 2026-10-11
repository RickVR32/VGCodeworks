# VG Codeworks backend: setup

One Cloudflare Worker (free plan) runs everything behind the website:

- **Telegram control centre:** every website enquiry, Stripe payment and booking lands in your Telegram, and you run the business with slash commands.
- **Database:** one Cloudflare D1 database holds customers, cars and jobs.
- **Google Calendar:** booked jobs appear in your calendar automatically, and move or disappear when you reschedule or cancel.
- **Garage Desk:** `yoursite/admin.html`, a private page over the same database.
- **Number plate checker** (DVSA) and **AI quick check** (Gemini).
- **Evening round-up:** tomorrow's jobs with one-tap WhatsApp reminders, review requests for yesterday's paid jobs, and anyone who still owes you.
- **Email into Telegram:** mail to your domain address lands in Telegram and your Gmail.
- **PDF receipts and invoices** from the bot or Garage Desk.

This folder holds no keys, so it's safe in your GitHub repo. Keys only ever go into Cloudflare. Each part switches on as soon as its keys are added, so you can do it in stages.

---

## 1. Database (10 min)

1. Sign up free at https://dash.cloudflare.com.
2. **Storage & Databases → D1 → Create database**. Name it `vgc`.
3. Open it, go to **Console**, paste in all of `schema.sql`, and run it.

## 2. Worker (10 min)

1. **Workers & Pages → Create → Create Worker**. Name it `vgc-helper` → **Deploy**.
2. **Edit code**: delete everything, paste all of `worker.js`, then **Deploy**.
3. **Settings → Bindings → Add → D1 database**. Variable name `DB`, database `vgc`.
4. **Settings → Variables and Secrets**. Add the ones below as you go (type **Secret** for anything private).
5. Copy the Worker address (e.g. `https://vgc-helper.yourname.workers.dev`) into `API_BASE` in `config.js` on the website.

| Name | Value |
|---|---|
| `ALLOWED_ORIGINS` | `https://rickvr32.github.io` (add `,https://www.vgcodeworks.co.uk` later) |
| `ADMIN_TOKEN` | a long random password for Garage Desk (30+ characters, use a password manager) |

## 3. Telegram bot (10 min)

1. In Telegram, message **@BotFather** → `/newbot` → name it (e.g. VG Codeworks Desk). Copy the **token**.
2. Add Worker secrets: `TELEGRAM_BOT_TOKEN` = the token, `TELEGRAM_WEBHOOK_SECRET` = any long random string (letters, numbers, `_` and `-` only).
3. Connect the bot to the Worker by opening this address in your browser (one line, with your values):
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://vgc-helper.yourname.workers.dev/tg&secret_token=<WEBHOOK_SECRET>`
   You should see `"ok":true`.
4. Send `/start` to your bot. It replies with your **chat ID**. Add it as `OWNER_CHAT_ID`. The bot only ever answers that chat.
5. Optional: in @BotFather, use `/setcommands`, pick your bot, and paste:
```
today - What's booked today
tomorrow - What's booked tomorrow
week - Next 7 days
jobs - Everything open
enquiries - New enquiries
owed - Done but not paid
takings - Paid this month
job - Details for a job number
find - Search names, numbers, regs
car - DVSA lookup and history for a reg
new - Name | phone | reg | service | when | price
book - Set a date: /book 12 sat 10:00
done - Mark a job done
paid - Mark paid: /paid 12 cash
cancel - Cancel a job
price - Set a price: /price 12 80
note - Add a note: /note 12 text
remind - WhatsApp reminder button
review - Ask for a Google review
invoice - PDF receipt or invoice
digest - Tomorrow's jobs and reviews now
help - All commands
```

**Dates the bot understands:** `sat 10:00`, `tomorrow 9:30`, `18/10 2pm`, `2026-10-18 10:00`. Add minutes on the end of `/book` to change the length: `/book 12 sat 10:00 90`.

## 4. Stripe → Telegram + calendar (10 min)

1. In your VG Codeworks Stripe account: **Developers → Webhooks → Add endpoint**.
   - URL: `https://vgc-helper.yourname.workers.dev/stripe`
   - Event: `checkout.session.completed`
2. Copy the **Signing secret** (`whsec_…`) into the Worker secret `STRIPE_WEBHOOK_SECRET`.
3. Recommended: **Developers → API keys → Create restricted key** with **Checkout Sessions: Read** only. Add it as `STRIPE_SECRET_KEY`. This lets the bot see which product was bought (without it, it guesses from the price, and can't tell a £50 diagnostic from a £50 deposit).
4. On each Payment Link, keep the custom fields **"Car registration"** and **"Preferred date and time"**. The bot reads both, and puts the job in your calendar if the date is clear (e.g. "sat 11am").

## 5. Google Calendar (15 min, one-off)

1. Go to https://console.cloud.google.com → create a project called `vgc`.
2. **APIs & Services → Library →** search **Google Calendar API → Enable**.
3. **IAM & Admin → Service accounts → Create service account** (name `vgc-calendar`, no roles needed) → open it → **Keys → Add key → JSON**. A file downloads.
4. Open the file, copy **all** of it, and paste it into the Worker secret `GOOGLE_SERVICE_ACCOUNT`.
5. In Google Calendar (on a computer): **Settings → your calendar → Share with specific people → Add** the service account's email (in the file, `client_email`) with **Make changes to events**.
6. Add `GOOGLE_CALENDAR_ID` = your Gmail address (or the calendar's ID from its settings, if you use a separate "VG Jobs" calendar, which is a nice touch).

Events show as **Service · Customer · Reg**, with a ✓ once paid, the customer's number and WhatsApp link in the notes, and the right length per service.

## 6. AI quick check and plate lookup

**Gemini:** https://aistudio.google.com → **Get API key**. Add it as `GEMINI_API_KEY`. Optional `GEMINI_MODEL` (default `gemini-2.5-flash`). Once real customers use it, turn on pay-as-you-go billing so Google doesn't use what they type.

**DVSA MOT History:** apply at https://documentation.history.mot.api.gov.uk/mot-history-api/register (free, up to 5 working days). From the approval email add `MOT_CLIENT_ID`, `MOT_CLIENT_SECRET`, `MOT_TOKEN_URL` and `MOT_API_KEY`. The DVSA key is cancelled if unused for 90 days; the client secret expires every 2 years.

## 7. Evening round-up (2 min)

1. Worker → **Settings → Trigger events → Add → Cron Triggers**. Enter `0 17 * * *` and save.
   Cloudflare uses UTC, so this arrives at 6pm in summer and 5pm in winter.
2. Every evening the bot sends:
   - **Tomorrow's jobs**, each with a *Remind Dave (10:00)* button. Tap it and WhatsApp opens with the reminder already written; just press send.
   - **Review requests** for jobs paid yesterday, same idea, with your review link in the message.
   - **Still owed:** jobs done 3+ days ago and not paid.
   - How many enquiries are waiting.
   Nothing to report means no message. Send `/digest` any time to get it now.
3. For review requests, add `REVIEW_URL`: in Google Business Profile, choose **Ask for reviews**, copy the link and paste it as the variable.

WhatsApp doesn't let anything send messages for you without a paid Business API account, so the bot writes the message and you press send. One tap each.

## 8. Email into Telegram (15 min, once you own the domain)

1. Add the domain to Cloudflare (**Add a domain**, then change the nameservers at your registrar to the two Cloudflare gives you). Your GitHub Pages DNS records come across with it.
2. Domain → **Email → Email Routing → Get started**. Let it add its DNS records.
3. **Destination addresses → Add** your Gmail (`v.gcodeworks@gmail.com`) and click the link in the email it sends.
4. **Routing rules → Custom address**: `holla@yourdomain` → action **Send to a Worker** → `vgc-helper`. (Or turn on **Catch-all** → Send to a Worker, so any address works.)
5. Add the Worker variable `FORWARD_TO` = the Gmail address from step 3.

Each email then pops up in Telegram (sender, subject, the first part of the message) and a full copy lands in Gmail, where you reply. If you set Gmail's **Send mail as** to `holla@yourdomain`, replies come from your domain too.

## 9. Receipts and invoices

Nothing to set up. `/invoice 12` in Telegram, or **Receipt/Invoice PDF** on a job in Garage Desk, makes a PDF with your details, the job, the car and the price. It says *Receipt* and *PAID* once the job is marked paid, otherwise *Invoice* with "please pay". Forward it to the customer on WhatsApp or email. Your business details are in `BUSINESS` near the top of `worker.js`.

---

## What happens when

| Customer does | You get |
|---|---|
| Sends the website form ("Send to Ric now") | Telegram message with WhatsApp button, any photo, and Book / Cancel buttons. Saved as an enquiry. |
| Pays on a Stripe link | Telegram "Paid £80: VAG Tweak Pack", customer and car saved, calendar event if they gave a clear time. |
| You `/book 12 sat 10:00` | Job booked, event in Google Calendar. |
| You `/done 12` then `/paid 12 cash` | Marked done, then paid; shows in `/takings` and Garage Desk. |
| You `/cancel 12` | Calendar event removed. |
| Evening (cron) | Tomorrow's jobs with reminder buttons, review requests, money owed. |
| Someone emails holla@ | Telegram message, full copy in Gmail. |
| You `/invoice 12` | PDF receipt or invoice in the chat, ready to forward. |

## Good to know
- If the Worker is down or not set up, the site still works: the form falls back to WhatsApp and email.
- Per-visitor limits: 6 enquiries, 12 AI checks and 30 plate lookups an hour. Change `LIMITS` at the top of `worker.js`.
- Garage Desk: `admin.html` on your site. Sign in with `ADMIN_TOKEN`. It's hidden from search engines, and the password is never stored in the website files.
- To change the bot's wording, edit `HELP` and the messages in `worker.js`, then paste and deploy again.
