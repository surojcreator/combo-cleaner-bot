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
| **Large local files** | Put files on the mounted disk and run `/process /var/data/file.txt`; text files stream without Telegram's 20 MB limit |
| **Persistent output/search** | Complete cleaned output goes to `/var/data/processed`; `/lsearch term` searches the newest output without loading it into RAM |
| **ULP search relay** | `/ulp htzone.co.il [day\|month\|year]` drives an external searcher bot (`@DumpNews14Bot` by default): query → `hist:full:<scope>`, **7 s before every try**, answers forwarded back |
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

- `/ulp <query> [day|month|year]` — 🔎 relay a search to the searcher bot, results forwarded back
- `/process /var/data/file.txt` — process a server-side file without uploading through Telegram
- `/process local` — process the newest file directly under `/var/data`
- `/save` — reply to a forwarded document in the shared group; download it to `/var/data` through the user account and process it
- `/lsearch <query>` — search the newest full output under `/var/data/processed`
- `/combine` — download the combined, deduped file
- `/storage` (or `/files`, `/disk`) — 💾 manage server disk storage, inspect raw & cleaned files, and delete files with buttons
- `/stats` — how many unique lines are stored for this chat
- `/clear` — wipe this chat's stored lines
- `/help` — usage help

---

## 📂 Large files on `/var/data`

Telegram bots can only download files up to 20 MB. For a large file, upload it
to the server by SCP, SFTP, your host's file manager, or another direct transfer,
then tell the bot to read it locally:

```text
/process /var/data/big-dump.txt
```

Or process the newest file directly under the mount:

```text
/process local
```

### Save a forwarded Telegram file directly to the mounted disk

For files larger than the Bot API download limit, use a private group shared by
the bot and the MTProto account:

1. Create a private Telegram group.
2. Add `@ulpsorter69bot` and the user account represented by `TELEGRAM_SESSION`.
3. Forward the document into that group.
4. Reply directly to the document with:

```text
/save
```

The user account fetches the replied-to message and streams its media directly
to `LOCAL_PROCESS_ROOT` (`/var/data` by default). The bot then automatically
runs the same local processing pipeline as `/process` and writes full cleaned
output under `/var/data/processed`.

### Batch Save Multiple Forwarded Telegram Files

When you have multiple `.zip` or text files forwarded into a group or chat, you can process them all in a single batch command:

```text
/batchsave [limit]
# or
/savebatch 20
```

1. Select and forward 5, 10, or 20 files at once into your private group or chat.
2. Send `/batchsave` (default scans the 10 most recent files, or specify up to 50, e.g. `/batchsave 25`).
3. The MTProto userbot reads each document in chronological order, streams each directly to `/var/data`, cleans each into the batch, displays live progress with file counts, and summarizes the aggregate results with an instant `[ 📦 Get combined file ]` button!

### Inspect Installed Custom Emoji Packs

Inspect all custom emoji packs installed on your Telegram account (in addition to the 599 standard animated stickers):

```text
/emojis
# or
/packs
```

---

This bypasses the Bot API's 20 MB download limit, but not Telegram's own
user-file upload limit. A 50 GB file still cannot travel through Telegram; use
SCP/SFTP/direct server upload for that size, then run `/process`.

Plain `.txt`, `.csv`, `.tsv`, `.log`, `.lst`, `.list`, and `.dat` files are
streamed line-by-line, so a 50 GB input does not need 50 GB of RAM. The complete
cleaned stream is written persistently to `/var/data/processed/*.txt`. The bot's
RAM batch remains capped and deduplicated for `/combine`, while the disk output
keeps the full cleaned stream. Search the newest disk output with:

```text
/lsearch htzone.co.il
```

`/process` runs as a background job so a multi-hour file does not hold a webhook
request open. Only one local job may run per Telegram chat at a time.

> **Large zip warning:** the current zip reader (`adm-zip`) loads the archive in
> memory and is capped at 4 GB. For a 50 GB archive, extract it into `/var/data`
> first, then `/process` the resulting text file. The 50 GB streaming path is for
> plain text data, not a single giant zip.

Environment paths:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOCAL_PROCESS_ROOT` | `/var/data` | directory used by `/process local` |
| `LOCAL_PROCESSED_ROOT` | `/var/data/processed` | persistent cleaned outputs searched by `/lsearch` |
| `PROCESS_MAX_ZIP_BYTES` | `4294967296` (4 GiB) | admission cap for RAM-bound zip processing; does not affect streamed text |

For safety, `/process` refuses paths outside `LOCAL_PROCESS_ROOT`, including
symlink or `..` escapes. Set `ALLOWED_USER_ID` as well, because this command
gives its authorized user controlled access to files inside the mounted root.

---

## 🔎 ULP search relay — `/ulp`

Ask this bot to run a search on an external **ULP searcher bot** (default
`@DumpNews14Bot`) and relay everything that bot answers back into your chat:

```text
/ulp htzone.co.il          # query only — scope defaults to day
/ulp htzone.co.il month    # scopes: day | month | year
```

Exactly what happens, in order — all of it paced:

| # | Step | Detail |
| --- | --- | --- |
| 1 | **write the query** | `htzone.co.il` is sent to the searcher bot exactly as you typed it |
| 2 | **history request** | right after, `hist:full:<scope>` goes out (`hist:full:day`, `:month`, `:year`) |
| 3 | **wait 12 s before every try** | every message — and every retry — waits `SEARCH_STEP_DELAY_MS` (default `12000`) first |
| 4 | **forward the results** | every answer the searcher sends back is forwarded into the chat that asked; files arrive with a **🧼 Clean into batch** button |

The launch card carries scope buttons (**🗓 Day / 🗓 Month / 🗓 Year**, re-run the
same query) plus **🔁 Run again** and **🛑 Stop**. A run keeps relaying for
`SEARCH_WINDOW_MS` (5 min) and closes itself; result messages are de-duplicated
by message id and capped per run, retries are capped too, and late answers are
still routed to whoever searched last.

### ⚠️ One-time setup — bot-to-bot messaging

Telegram only delivers *private* messages between bots when **Bot-to-Bot
Communication** is enabled for **both** bots in @BotFather. Until then the API
answers `USER_BOT_TO_BOT_DISABLED` and the relay replies with the exact fix:

1. @BotFather → `/mybots` → **your bot** → **Bot Settings** → **Bot-to-Bot Communication** → **Enable**
2. the owner of `@DumpNews14Bot` must enable it for that bot too
3. tap **🔁 Run again**

If it stays off, the same message tells you how to do it **by hand**: send the
query, wait 7 s, send `hist:full:<scope>`, then forward the answers to this bot —
files are cleaned into the batch as usual, so nothing is lost.

### 🐇 The bypass when the other owner can't be reached

This is the normal case for third-party search bots: their owner will never flip
the switch, so bot-to-bot stays sealed forever. The relay can instead go through
**your own account** (MTProto, via the `teleproto` package): the query and the
history request are sent to the searcher as *you*, with the same 7 s pacing and
the same caps — and every answer is shared back into the chat that asked, where
it lands with the usual **🧼 Clean into batch** button. No other owner needed.

Setup (one time, ~5 minutes):

1. Create an app at [my.telegram.org](https://my.telegram.org) → copy `api_id` and `api_hash`.
2. Put the values in local `.env`, then run `npm run userbot:login:qr`. In the
   Telegram mobile app, open **Settings → Devices → Link Desktop Device** and
   scan the terminal QR. This avoids SMS. If the account has 2FA, enter its
   password when prompted. The script saves `TELEGRAM_SESSION` into `.env` and
   prints it once for Render. The older SMS flow remains `npm run userbot:login`.
3. Add the three secrets to your environment — locally in `.env`, on Render in the
   dashboard (**Environment → Secrets**):
   `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`.
4. Restart. The logs show `Userbot: connected as your account, listening to @DumpNews14Bot …`
   and the launch card reads 👤 **Sender — your account**.

Keep `SEARCH_TRANSPORT=auto` (uses the account whenever it's connected, Bot API
otherwise), or force a path with `userbot` / `bot`. Forwarded results keep their
original author; if a result can't be forwarded (protected content) it arrives as
a marked `#ulp` copy instead.

> ⚠️ **Be honest with yourself here:** an account session is a full login as you —
> never commit it, and lock the bot with `ALLOWED_USER_ID`. Automating your own
> account also sits in a grey zone of Telegram's rules, so keep pacing human
> (the relay does: 7 s between tries, capped retries) and consider a **secondary
> account** just for the relay instead of your main one.

### Relay settings

| Env var | Default | Meaning |
| --- | --- | --- |
| `SEARCH_BOT_USERNAME` | `DumpNews14Bot` | searcher bot that receives the query |
| `SEARCH_STEP_DELAY_MS` | `12000` | wait before **every** try — the 12 s rule |
| `SEARCH_RESULT_WAIT_MS` | `20000` | how long to wait for an answer before retrying |
| `SEARCH_MAX_TRIES` | `3` | how often the query + history pair may repeat |
| `SEARCH_HIST_TEMPLATE` | `hist:full:{scope}` | history request; `{scope}` = `day`/`month`/`year` |
| `SEARCH_WINDOW_MS` | `300000` | how long a run keeps relaying results |
| `SEARCH_TRANSPORT` | `auto` | `auto` / `userbot` / `bot` — the account bypass or Bot API only |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_SESSION` | — | account bypass login (`npm run userbot:login`) |

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
npm test        # cleaner, extractor, sites, store, search-relay and end-to-end ULP flow tests (node:test)
```

Project layout:

```
src/
  index.js      entrypoint: polling/webhook + health server, access control
  bot.js        Telegram handlers (documents, /combine, /stats, /clear, /ulp relay)
  searchbot.js  ULP search relay: query + hist:full steps, 7s pacing, retries, run state
  userbot.js    MTProto account bypass (teleproto): sends as you, shares results back
  cleaner.js    line-level keep/drop + normalization + dedupe
  extractor.js  zip walking (incl. nested) + safety caps -> cleanText
  sites.js      website detection + output-file naming
  store.js      per-chat in-memory accumulation with caps
  messages.js   HTML-safe message templates (banners, progress bars, relay cards)
test/
  cleaner.test.js
  extractor.test.js
  sites.test.js
  store.test.js
  searchbot.test.js   relay logic: scopes, steps, pacing, retries, run state
  ulp-flow.test.js    end-to-end /ulp flow against a fake Bot API server
  userbot.test.js     account transport: config, error mapping, result routing
```

---

## Important disclaimer

Combolists frequently contain **other people's personal data**. Depending on where
you live, processing or storing such data can be illegal (e.g. GDPR). Use this bot
only on data you are **legally permitted** to process — for example your own breach
dumps that you are authorised to triage. You are responsible for how you use it.