# 🧼 Telegram Combolist Cleaner Bot

A Telegram bot that takes forwarded **`.zip`** files (full of messy combolists) and
cleans them down to just the credential pairs you care about. Everything accumulates
into a batch, and you download one combined, deduped file **whenever you're ready** —
named after the website it belongs to:

- ✅ keeps `email:password` — e.g. `user@mail.com:pass123`
- ✅ keeps `number:password` — e.g. `15551234567:pass123`
- ❌ drops URL / domain / host lines — e.g. `https://site.com:443`, `site.com:8080`, `1.2.3.4:443`
- ❌ drops junk lines with no colon or an empty side
- 🌐 **one combined, deduped file on demand** — named after the site: `netflix.com_combined_2026-09-19.txt`

You can send **many** files: everything is cleaned, merged and de-duplicated into one
batch. Nothing is auto-sent — tap **📦 Get combined file** (or `/combine`) when you
want the download. `/clear` starts a fresh batch.

---

## Features

| Feature | Details |
| --- | --- |
| Forward or upload | Send `.zip`, `.txt`, `.csv`, `.log`, etc. as a document |
| **On-demand combined file** | Uploads accumulate in the batch; tap **📦 Get combined file** (or `/combine`) to download |
| **Site-named output** | Detects the website from URLs/emails in the dump or the file name → `netflix.com_combined_2026-09-19.txt` |
| Nested zips | Automatically walks zips-inside-zips (up to 3 levels) |
| Keep-list | Emails and phone numbers only |
| Drop-list | URLs, bare domains, host:port, IPv4:port, invalid lines |
| De-duplication | Within a file **and** across everything you've sent |
| Combine | `/combine` sends the combined, deduped file again on demand |
| Safe | In-memory only, per-chat isolation, size/entry caps against zip bombs |
| Free hosting | Dockerfile + Render blueprint (free plan, always available) |

---

## Commands

- `/combine` — download the combined, deduped file
- `/stats` — how many unique lines are stored for this chat
- `/clear` — wipe this chat's stored lines
- `/help` — usage help

---

## Run locally (5 minutes)

1. **Create a bot** with [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. **Find your numeric user id** by messaging [@userinfobot](https://t.me/userinfobot)
   (optional, but recommended so only you can use it).
3. Install and configure:

   ```bash
   cd telegram-combo-cleaner-bot
   npm install
   cp .env.example .env
   # edit .env and paste BOT_TOKEN (and optionally ALLOWED_USER_ID)
   ```

4. Start it:

   ```bash
   npm start
   ```

5. In Telegram, open your bot and either `/start`, or **forward it a `.zip`**.
   Send a few, then tap **📦 Get combined file** (or `/combine`).

> Local runs default to **long-polling**, so you don't need a public URL.

---

## Deploy free in the cloud

Free hosts sleep idle apps. This bot uses **long-polling by default**, which works
even behind a plain health endpoint; on hosts that give a public HTTPS URL you can
switch to **webhook mode** by setting `PUBLIC_URL`.

### Option A — Render.com (free plan) ✅ recommended

Render's free plan requires no credit card and stays available — no Fly.io needed.

1. Push this project to a GitHub repo.
2. On [render.com](https://render.com): **New + → Blueprint**, pick the repo.
   Render reads `render.yaml` (Docker, free plan, health check on `/healthz`).
3. When prompted, set environment variables:
   - `BOT_TOKEN` = your token
   - `ALLOWED_USER_ID` = your numeric id (optional)
   - `PUBLIC_URL` = `https://<your-service>.onrender.com` (no trailing slash) → webhook mode
4. Deploy. The logs should show `Bot started as @yourbot`.

> **Free-plan sleep:** Render free web services spin down after ~15 minutes of no
> inbound HTTP traffic. Any Telegram message wakes the bot, but the first reply may
> take ~30–60s. To keep it always warm, point a free pinger
> ([UptimeRobot](https://uptimerobot.com) or [cron-job.org](https://cron-job.org))
> at `https://<your-service>.onrender.com/healthz` every 10 minutes.

### Option B — Any Docker host

```bash
docker build -t combo-cleaner-bot .
docker run -d --name combo-bot \
  -e BOT_TOKEN=123456:ABC... \
  -e ALLOWED_USER_ID=123456789 \
  -p 8080:8080 \
  combo-cleaner-bot
```

### Notes on free tiers

- **Telegram file limit:** bots can download files up to **20 MB**. For bigger sets,
  split the source into several zips and send them all — the bot merges them.
- **Ephemeral memory:** storage is in RAM. If the host restarts/sleeps, the batch is
  lost — the next file you send starts a fresh batch.
- **Idle sleep:** Render free web services sleep after inactivity. Send any message
  to wake the bot (first reply may take ~30–60s), or keep it warm with an uptime pinger.

---

## How the cleaning works

For each line the bot scans for every `login:password` candidate (separator is `:`
or `|`), keeps the first valid one, and:

1. **Drops** URL/domain/host tokens, scheme prefixes and other junk
2. **Keeps** the line when the login is:
   - an **email** (`user@example.com`), or
   - a **phone number** (7–15 digits, `+`, spaces, dashes, dots, parentheses allowed), or
   - a **plain username** (`john.doe42`) when no email/number exists on the line
3. Normalizes to `login:password` and de-duplicates.

### How the site name is detected

The output file is named after the website the dump is for. Detection scores
candidate domains from (strongest to weakest):

1. **URLs in the dump** (`https://site.com/...`) — +3 per match
2. **A domain in the file name** (`hulu.com_dumps.txt`) — +3
3. **Domains leading lines** (`site.com:user:pass`) — +2
4. **A brand word in the file name** (`spotify_combo.zip` → `spotify`) — +2
5. **Email domains** (`user@site.com`) — +1

Freemail providers (gmail.com, yahoo.com, hotmail.com, …) are treated as login
providers, not the target site: they're discounted 75% and never used as the
site name on their own. If nothing is detected, the original file name is used.

---

## Development

```bash
npm test        # runs the cleaner, extractor and site-detection unit tests (node:test)
```

Project layout:

```
src/
  index.js      entrypoint: polling/webhook + health server, access control
  bot.js        Telegram handlers (documents, /combine, /stats, /clear)
  cleaner.js    line-level keep/drop + normalization + dedupe
  extractor.js  zip walking (incl. nested) + safety caps -> cleanText
  sites.js      website detection + output-file naming
  store.js      per-chat in-memory accumulation with caps
  messages.js   HTML-safe message templates (banners, progress bars)
test/
  cleaner.test.js
  extractor.test.js
  sites.test.js
  store.test.js
```

---

## Important disclaimer

Combolists frequently contain **other people's personal data**. Depending on where
you live, processing or storing such data can be illegal (e.g. GDPR). Use this bot
only on data you are **legally permitted** to process — for example your own breach
dumps that you are authorised to triage. You are responsible for how you use it.