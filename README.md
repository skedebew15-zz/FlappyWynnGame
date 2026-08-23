# Flappy Wynn

Flappy Wynn is a browser Flappy Bird-style game with a server-verified leaderboard.

## Architecture

- **Frontend:** Vercel/static hosting
- **Backend:** Railway Node.js service
- **Leaderboard storage:** `data/leaderboard.json` on the Railway service
- **API:** `/api/session`, `/api/submit`, `/api/leaderboard`, `/api/health`

> For production, attach a Railway Volume mounted at `/app/data` so leaderboard data survives redeploys/restarts.

## 1. Deploy backend to Railway

Create a Railway service from this GitHub repository.

Start command:

```bash
npm start
```

Railway will provide a public URL such as:

```text
https://flappy-wynn-api-production.up.railway.app
```

Optional environment variable:

```text
ALLOWED_ORIGIN=https://your-vercel-domain.vercel.app
```

## 2. Persist leaderboard data

The server writes:

```text
data/leaderboard.json
data/submissions.log
```

Attach a Railway Volume and mount it at:

```text
/app/data
```

Without persistent storage, file-based leaderboard data can be lost when the service is recreated/redeployed.

## 3. Connect the Vercel frontend

Edit:

```text
public/api-config.js
```

Change:

```js
window.FLAPPY_WYNN_API_BASE = 'https://YOUR-RAILWAY-SERVICE.up.railway.app/api';
```

to your actual Railway API URL.

Then deploy the `public/` frontend to Vercel.

## API

### GET `/api/health`

Health check.

### GET `/api/session`

Creates a gameplay session.

### POST `/api/submit`

Submits a score. The existing anti-cheat validation checks:

- score range
- game duration
- score rate
- pipe/score count
- minimum pipe spacing
- submission cooldown
- IP rate limiting

### GET `/api/leaderboard?filter=all`

Global leaderboard.

### GET `/api/leaderboard?filter=today`

Today's leaderboard.

## Local development

```bash
npm start
```

Open:

```text
http://localhost:3000
```

The frontend automatically uses the local `/api` fallback if `api-config.js` is changed to:

```js
window.FLAPPY_WYNN_API_BASE = '';
```
