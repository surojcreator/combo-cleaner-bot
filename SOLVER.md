# Turnstile solver — sitekey 0x4AAAAAAD2cidQytY73HEYU

Upstream: https://github.com/B00H0O/cloudflare-solver (cloned to `solver-upstream/`, gitignored).
Your key is already in `.env` as `TURNSTILE_SITEKEY`. You still must set `TURNSTILE_URL`
(the page where the widget lives) — the solver needs BOTH on every call.

## 1. Start the solver (Linux only — Windows Chrome fails CF)

Option A — same Linux box / VPS / Railway / Render that runs the bot:

```bash
cd solver-upstream
docker build -t turnstile-solver .
docker run -d -p 407:407 --restart unless-stopped turnstile-solver
curl http://localhost:407/health
```

Option B — this Windows machine: run the two docker commands inside WSL2
(Docker Engine in WSL2, NOT Docker Desktop), keep `SOLVER_URL=http://localhost:407`.

Scale-out: `docker compose up -d --scale solver=4` (ports 407-410).

## 2. Set the page URL

In `.env`:

```ini
TURNSTILE_URL=https://the-site.com/page-with-widget
```

## 3. Solve

```bash
npm run solver -- https://the-site.com/page-with-widget
# or: node scripts/solve-turnstile.js https://the-site.com/page-with-widget
```

Direct curl (same thing the client does):

```bash
curl -X POST http://localhost:407/turnstile \
  -H "content-type: application/json" \
  -d '{"url":"https://the-site.com/page-with-widget","sitekey":"0x4AAAAAAD2cidQytY73HEYU"}'
```

Optional `cdata` / `action` / `proxy` fields are supported via `src/solver.js`
(`SOLVER_PROXY` env). IUAM pages: `POST /iuam {"url":"..."}`.

## Node usage

```js
const { solveTurnstile } = require("./src/solver");
const { token } = await solveTurnstile({ url: process.env.TURNSTILE_URL });
// replay: send `token` as cf-turnstile-response with the SAME ip + UA
```
