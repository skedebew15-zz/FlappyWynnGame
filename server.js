// ═══════════════════════════════════════════════════════
//  FLAPPY WYNN — Zero-Dependency Server with Anti-Cheat
//  No npm install needed! Just: node server.js
// ═══════════════════════════════════════════════════════

const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ── Data paths ──
const DATA_DIR  = path.join(__dirname, 'data');
const LB_FILE   = path.join(DATA_DIR, 'leaderboard.json');
const LOG_FILE  = path.join(DATA_DIR, 'submissions.log');
const PUBLIC    = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadLB() {
  try { return JSON.parse(fs.readFileSync(LB_FILE, 'utf8')); }
  catch { return []; }
}
function saveLB(data) {
  fs.writeFileSync(LB_FILE, JSON.stringify(data, null, 2));
}
function appendLog(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}
function uuid() {
  return crypto.randomUUID();
}

// ── MIME types ──
const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── Rate Limiting ──
const rateMap = new Map();
function checkRate(ip, max, windowMs) {
  const now = Date.now();
  const key = ip;
  let entry = rateMap.get(key);
  if (!entry || now - entry.start > windowMs) {
    entry = { start: now, count: 0 };
    rateMap.set(key, entry);
  }
  entry.count++;
  return entry.count <= max;
}
// Cleanup every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateMap) {
    if (now - v.start > 120000) rateMap.delete(k);
  }
}, 120000);

// ── Session cooldowns ──
const sessionCooldowns = new Map();

// ── Anti-Cheat Constants ──
const AC = {
  MIN_DURATION:     3000,
  MAX_DURATION:     600000,
  MAX_RATE:         0.8,
  MAX_SCORE:        500,
  COOLDOWN_MS:      5000,
};

// ── Validation ──
function validate(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return { ok: false, errors: ['Invalid body'] };

  const { name, xHandle, score, sessionId, gameDurationMs, pipeTimestamps } = body;

  if (!name || typeof name !== 'string' || !name.trim()) errors.push('Missing name');
  if (typeof score !== 'number' || !Number.isInteger(score)) errors.push('Invalid score');
  if (!sessionId || typeof sessionId !== 'string') errors.push('Missing sessionId');
  if (typeof gameDurationMs !== 'number') errors.push('Missing duration');
  if (!Array.isArray(pipeTimestamps)) errors.push('Missing pipeTimestamps');

  if (errors.length) return { ok: false, errors };

  const cleanName = name.trim().substring(0, 20);
  const cleanX = (xHandle || '').trim().replace(/^@/, '').substring(0, 20);

  if (score < 0 || score > AC.MAX_SCORE) errors.push('Score out of range');
  if (gameDurationMs < AC.MIN_DURATION) errors.push('Game too short');
  if (gameDurationMs > AC.MAX_DURATION) errors.push('Game too long');
  if (pipeTimestamps.length !== score) errors.push('Pipe/score mismatch');

  const durSec = gameDurationMs / 1000;
  const rate = score / durSec;
  if (score > 0 && rate > AC.MAX_RATE) errors.push('Score rate too high');

  // Pipe timing
  if (pipeTimestamps.length > 1) {
    for (let i = 1; i < pipeTimestamps.length; i++) {
      if (pipeTimestamps[i] - pipeTimestamps[i-1] < 500) {
        errors.push('Pipes too close'); break;
      }
    }
  }

  // Cooldown
  const last = sessionCooldowns.get(sessionId);
  if (last && Date.now() - last < AC.COOLDOWN_MS) errors.push('Cooldown active');

  return {
    ok: errors.length === 0,
    errors,
    cleanName,
    cleanX,
    meta: { durSec: durSec.toFixed(1), rate: rate.toFixed(3) }
  };
}

// ── Parse JSON body ──
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── Response helpers ──
function getAllowedOrigin(req) {
  const configured = process.env.ALLOWED_ORIGIN;
  const origin = req.headers.origin;
  if (!configured) return '*';
  return origin === configured ? configured : configured;
}

function json(res, status, data, req) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': getAllowedOrigin(req),
    'Vary': 'Origin',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function serveStatic(req, res) {
  let filePath = path.join(PUBLIC, req.url === '/' ? '/index.html' : req.url);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fallback to index.html for SPA
      fs.readFile(path.join(PUBLIC, 'index.html'), (err2, html) => {
        if (err2) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': (ext === '.html' || path.basename(filePath) === 'api-config.js')
      ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '0.0.0.0';
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(); return;
  }

  // ── API Routes ──

  // GET /api/session
  if (req.method === 'GET' && url.pathname === '/api/session') {
    if (!checkRate(ip, 30, 10000)) return json(res, 429, { ok: false, error: 'Rate limit' }, req);
    return json(res, 200, { ok: true, sessionId: uuid() }, req);
  }

  // POST /api/submit
  if (req.method === 'POST' && url.pathname === '/api/submit') {
    if (!checkRate(ip, 10, 60000)) return json(res, 429, { ok: false, error: 'Too many submissions' }, req);

    let body;
    try { body = await parseBody(req); }
    catch { return json(res, 400, { ok: false, error: 'Invalid JSON' }, req); }

    const v = validate(body);
    if (!v.ok) {
      appendLog({ ts: new Date().toISOString(), ip, action: 'REJECTED', reason: v.errors, name: body?.name, score: body?.score });
      return json(res, 400, { ok: false, error: 'Validation failed', details: v.errors }, req);
    }

    sessionCooldowns.set(body.sessionId, Date.now());

    const lb = loadLB();
    const entry = {
      id: uuid(),
      name: v.cleanName,
      x: v.cleanX,
      score: body.score,
      ts: Date.now(),
      date: new Date().toISOString().slice(0, 10),
      ip: ip.replace(/^::ffff:/, ''),
      duration: v.meta.durSec,
      rate: v.meta.rate,
    };
    lb.push(entry);
    lb.sort((a, b) => b.score - a.score);
    if (lb.length > 500) lb.length = 500;
    saveLB(lb);

    const rank = lb.findIndex(e => e.id === entry.id) + 1;
    appendLog({ ts: entry.ts, ip: entry.ip, action: 'ACCEPTED', name: v.cleanName, score: body.score, rank, ...v.meta });

    return json(res, 200, { ok: true, rank, totalPlayers: lb.length }, req);
  }

  // GET /api/leaderboard
  if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
    if (!checkRate(ip, 60, 10000)) return json(res, 429, { ok: false, error: 'Rate limit' }, req);

    const lb = loadLB();
    const today = new Date().toISOString().slice(0, 10);
    const filter = url.searchParams.get('filter') || 'all';
    let filtered = filter === 'today' ? lb.filter(e => e.date === today) : lb;

    const top = filtered.slice(0, 50).map((e, i) => ({
      rank: i + 1, name: e.name, x: e.x || '', score: e.score, ts: e.ts
    }));

    return json(res, 200, { ok: true, filter, total: filtered.length, entries: top }, req);
  }

  // GET /api/health
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, uptime: process.uptime(), totalScores: loadLB().length }, req);
  }

  // ── Static files ──
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🟣 Flappy WYNN API Server running on http://localhost:' + PORT);
  console.log('');
  console.log('  📊 Leaderboard: http://localhost:' + PORT + '/api/leaderboard');
  console.log('  ❤️  Health:      http://localhost:' + PORT + '/api/health');
  console.log('  🎮 Game:         http://localhost:' + PORT);
  console.log('');
  console.log('  Zero dependencies — no npm install needed!');
  console.log('');
});
