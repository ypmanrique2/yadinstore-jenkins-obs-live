// ================================================================
// yadinstore-jenkins-obs-live/server.js — Zero-dependency Node HTTP
//
// Clone de `yadinstore-cicd-demo/docker-live/server.js:22-116`
// adaptado para Jenkins + obs live prod (free tier Render).
//
// Patrón BE-KD: agente local (jenkins-obs-agent.ps1) lee
// `docker events --filter container=yadin-jenkins` + Jenkins
// http://localhost:8081/api/json (queue/executors/jobs) + metrics
// dummy `outbox_pending` y POSTea acá; dashboard pollea
// GET /api/jenkins/live cada 2s.
//
// 3 streams live (BE-KD aesthetic):
//   - jenkins: queue, executors, jobs lastBuild (poll 2s via agente)
//   - docker: containers (docker ps) + events container
//   - metrics: obs.outboxPending/kafkaErrors + BE live Micrometer outbox.pending/published/failed + p95 histogram (poll 2s dashboard → backend /api/v1/observability/*)
//   Dashboard BE-KD style: metrics cards + logs tabla con esc() + traceId mono, hist true verde, pending>0 amber, errors>0 red
//
// Endpoints:
//   POST /api/jenkins/events    batch|single build/docker events (token)
//   POST /api/jenkins/snapshot  { jenkins, containers, obs } (token)
//   POST /api/jenkins/metrics   alias obs.metrics (token)
//   POST /api/obs/metrics       alias (token)
//   GET  /api/jenkins/live      -> {events,containers,jenkins,obs,lastSeen,serverTime} (public)
//   GET  /jenkins-dashboard.html (+ /) -> dashboard static (public)
//   OPTIONS 204 CORS Pages-only
//
// Auth: si DOCKER_LIVE_TOKEN (o JENKINS_LIVE_TOKEN) definida, POSTs
// exigen header `x-live-token` timingSafeEqual. GETs públicos.
// CORS prod Pages-only (no *): https://ypmanrique2.github.io
// Rate-limit POST 10/min/IP (429 Retry-After).
// ================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.DOCKER_LIVE_TOKEN || process.env.JENKINS_LIVE_TOKEN || process.env.JENKINS_OBS_TOKEN || '';
const MAX_EVENTS = 200;
const RATE_LIMIT_MAX = 10; // POSTs por minuto por IP
const RATE_WINDOW_MS = 60 * 1000;
const ALLOWED_ORIGINS = [
  'https://ypmanrique2.github.io',
  'https://yadinstore-jenkins-obs-live.onrender.com'
];
const ALLOWED_ORIGIN = ALLOWED_ORIGINS[0]; // keep for log

// --- Estado en memoria (ring + 3 streams) ---
const state = {
  events: [], // ring MAX_EVENTS: docker events + jenkins builds
  containers: [], // último snapshot docker ps
  jenkins: { queue: 0, executors: { busy: 0, idle: 0 }, jobs: [] }, // stream jenkins
  obs: { outboxPending: 0, kafkaPublishErrors: 0, serverTime: null }, // stream metrics dummy
  lastSeen: null, // ISO del último POST del agente
};

const rateMap = new Map(); // ip -> { count, resetAt }

function json(res, code, obj, extraHeaders) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders };
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let data = '';
  req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
  req.on('end', () => {
    if (!data) return cb(null, {});
    try { cb(null, JSON.parse(data)); }
    catch (err) { cb(err); }
  });
}

function sanitizeCause(s) {
  if (!s) return s;
  let v = String(s).slice(0, 250);
  // oculta secretos (password, token, secret, api_key, email) igual que KafkaActivityController:250
  v = v.replace(/password\s*=\s*[^&\s,;]+/gi, 'password=***');
  v = v.replace(/passwd\s*=\s*[^&\s,;]+/gi, 'passwd=***');
  v = v.replace(/secret\s*=\s*[^&\s,;]+/gi, 'secret=***');
  v = v.replace(/token\s*=\s*[^&\s,;]+/gi, 'token=***');
  v = v.replace(/api[_-]?key\s*=\s*[^&\s,;]+/gi, 'api_key=***');
  v = v.replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '***@***');
  return v;
}

function authorized(req) {
  if (TOKEN === '') return true;
  const got = String(req.headers['x-live-token'] || '');
  if (got.length !== TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN));
  } catch (_) {
    return got === TOKEN;
  }
}

function rateLimited(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateMap.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    json(res, 429, { error: 'rate_limited', retryAfter }, { 'Retry-After': String(retryAfter) });
    return true;
  }
  return false;
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (origin.startsWith('http://localhost')) return true;
  if (origin.startsWith('http://127.0.0.1')) return true;
  if (origin === 'https://localhost' || origin === 'capacitor://localhost') return true;
  return false;
}
function setCors(req, res) {
  const origin = req.headers.origin || '';
  // Pages-only + jenkins-obs-live + localhost: refleja origin permitido; si no permitido, fallback ALLOWED_ORIGIN (no *)
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!origin) {
    // same-origin o curl sin Origin — no se exige CORS, pero deja header para probes
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  } else {
    // Producto: Pages-only, no * — refleja fallback seguro (no wildcard)
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-live-token, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // POST /api/jenkins/events — evento único o lote (build/docker events)
  if (req.method === 'POST' && (url.pathname === '/api/jenkins/events' || url.pathname === '/api/docker/events')) {
    if (rateLimited(req, res)) return;
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    return readBody(req, (err, body) => {
      if (err) return json(res, 400, { error: 'JSON inválido' });
      // body puede ser [...] o {events:[...]} o evento único {...}
      let batch = [];
      if (Array.isArray(body)) batch = body;
      else if (Array.isArray(body.events)) batch = body.events;
      else if (body && typeof body === 'object' && Object.keys(body).length > 0) batch = [body];
      for (const ev of batch) {
        const sanitized = { ...ev };
        if (sanitized.causeChain) sanitized.causeChain = sanitizeCause(sanitized.causeChain);
        if (sanitized.cause) sanitized.cause = sanitizeCause(sanitized.cause);
        sanitized.receivedAt = new Date().toISOString();
        state.events.push(sanitized);
      }
      if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
      state.lastSeen = new Date().toISOString();
      json(res, 200, { ok: true, stored: batch.length, total: state.events.length });
    });
  }

  // POST /api/jenkins/snapshot — snapshot jenkins + docker + metrics
  if (req.method === 'POST' && (url.pathname === '/api/jenkins/snapshot' || url.pathname === '/api/docker/snapshot')) {
    if (rateLimited(req, res)) return;
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    return readBody(req, (err, body) => {
      if (err) return json(res, 400, { error: 'JSON inválido' });
      // Soporta {jenkins:{...}, containers:[...], obs:{...}} o {containers:[...]} legacy
      if (body.jenkins && typeof body.jenkins === 'object') {
        const j = body.jenkins;
        state.jenkins.queue = Number(j.queue ?? state.jenkins.queue) || 0;
        if (j.executors) {
          state.jenkins.executors.busy = Number(j.executors.busy ?? 0) || 0;
          state.jenkins.executors.idle = Number(j.executors.idle ?? 0) || 0;
        }
        if (Array.isArray(j.jobs)) {
          state.jenkins.jobs = j.jobs.map((job) => ({
            name: String(job.name || '?').slice(0, 120),
            lastBuild: job.lastBuild ? {
              number: Number(job.lastBuild.number ?? job.lastBuild.build ?? 0) || 0,
              result: sanitizeCause(String(job.lastBuild.result || 'UNKNOWN').slice(0, 20)),
              timestamp: Number(job.lastBuild.timestamp ?? job.lastBuild.ts ?? 0) || 0,
              duration: Number(job.lastBuild.duration ?? 0) || 0,
            } : null,
          })).slice(0, 50);
        }
        if (j.status) state.jenkins.status = sanitizeCause(String(j.status).slice(0, 80));
        if (j.causeChain) state.jenkins.causeChain = sanitizeCause(j.causeChain);
      }
      if (Array.isArray(body.containers)) state.containers = body.containers.slice(0, 100);
      else if (Array.isArray(body)) state.containers = body.slice(0, 100);
      if (body.obs && typeof body.obs === 'object') {
        if (body.obs.outboxPending != null) state.obs.outboxPending = Number(body.obs.outboxPending) || 0;
        if (body.obs.kafkaPublishErrors != null) state.obs.kafkaPublishErrors = Number(body.obs.kafkaPublishErrors) || 0;
      }
      if (body.outboxPending != null) state.obs.outboxPending = Number(body.outboxPending) || 0;
      state.lastSeen = new Date().toISOString();
      json(res, 200, { ok: true, jenkins: state.jenkins, containers: state.containers.length, obs: state.obs });
    });
  }

  // POST /api/jenkins/metrics alias /api/obs/metrics — métricas dummy (outboxPending etc)
  if (req.method === 'POST' && (url.pathname === '/api/jenkins/metrics' || url.pathname === '/api/obs/metrics')) {
    if (rateLimited(req, res)) return;
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });
    return readBody(req, (err, body) => {
      if (err) return json(res, 400, { error: 'JSON inválido' });
      const src = body.metrics || body.obs || body;
      if (src.outboxPending != null) state.obs.outboxPending = Number(src.outboxPending) || 0;
      if (src.kafkaPublishErrors != null) state.obs.kafkaPublishErrors = Number(src.kafkaPublishErrors) || 0;
      if (src.outbox_pending != null) state.obs.outboxPending = Number(src.outbox_pending) || 0;
      state.lastSeen = new Date().toISOString();
      json(res, 200, { ok: true, obs: state.obs });
    });
  }

  // GET /api/jenkins/live — poll dashboard (público, healthCheck)
  if (req.method === 'GET' && (url.pathname === '/api/jenkins/live' || url.pathname === '/api/docker/live')) {
    return json(res, 200, {
      events: state.events,
      containers: state.containers,
      jenkins: state.jenkins,
      obs: { ...state.obs, serverTime: new Date().toISOString() },
      lastSeen: state.lastSeen,
      serverTime: new Date().toISOString(),
    });
  }

  // GET /health alias
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, lastSeen: state.lastSeen, serverTime: new Date().toISOString() });
  }

  // HEAD /api/jenkins/live, /api/docker/live, /health — UptimeRobot HEAD (200 sin body, evita 404 x-render-routing no-server)
  if (req.method === 'HEAD' && (url.pathname === '/api/jenkins/live' || url.pathname === '/api/docker/live' || url.pathname === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end();
    return;
  }

  // GET /jenkins-dashboard.html (+ /)
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/jenkins-dashboard.html' || url.pathname === '/dashboard.html')) {
    const file = path.join(__dirname, 'jenkins-dashboard.html');
    return fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('jenkins-dashboard.html no encontrado'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; connect-src 'self' https://yadinstore-jenkins-obs-live.onrender.com https://yadinstore-backend.onrender.com https://ypmanrique2.github.io http://localhost:* http://127.0.0.1:*; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'" });
      res.end(data);
    });
  }

  // GET /yadinstore-topology-3d.html (+ /topology alias) — porcelain copy from yadinStore-Spec, CSP compat iframe, same-origin
  if (req.method === 'GET' && (url.pathname === '/yadinstore-topology-3d.html' || url.pathname === '/topology')) {
    const file = path.join(__dirname, 'yadinstore-topology-3d.html');
    return fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('yadinstore-topology-3d.html no encontrado'); return; }
      // CSP: allow archify inline scripts/styles + Google Fonts (archify uses JetBrains Mono), same-origin iframe embedding
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https://yadinstore-jenkins-obs-live.onrender.com https://yadinstore-backend.onrender.com https://ypmanrique2.github.io http://localhost:* http://127.0.0.1:*; frame-ancestors 'self' https://yadinstore-jenkins-obs-live.onrender.com https://ypmanrique2.github.io http://localhost:* http://127.0.0.1:*",
        'X-Frame-Options': 'ALLOWALL',
        'Cache-Control': 'public, max-age=300'
      });
      res.end(data);
    });
  }

  // GET /yadinstore-topology-3d-candidate.json — raw candidate source for live signal-flow (optional, for future Kubernetes live)
  if (req.method === 'GET' && (url.pathname === '/yadinstore-topology-3d-candidate.json' || url.pathname === '/topology.json' || url.pathname === '/candidate.json')) {
    const file = path.join(__dirname, 'yadinstore-topology-3d-candidate.json');
    return fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'candidate not found' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' });
      res.end(data);
    });
  }

  // HEAD for topology + candidate (UptimeRobot / probes)
  if (req.method === 'HEAD' && (url.pathname === '/yadinstore-topology-3d.html' || url.pathname === '/topology' || url.pathname === '/yadinstore-topology-3d-candidate.json' || url.pathname === '/topology.json')) {
    const ct = url.pathname.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': ct });
    res.end();
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[jenkins-obs-live] escuchando en :${PORT} (token auth: ${TOKEN ? 'ON' : 'OFF'}, origin: ${ALLOWED_ORIGIN})`);
});
