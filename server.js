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
const RATE_LIMIT_MAX = 15; // POSTs por minuto por IP (fix 429: snapshot 10s=6/min + events burst)
const RATE_WINDOW_MS = 60 * 1000;
const ALLOWED_ORIGINS = [
  'https://ypmanrique2.github.io',
  'https://yadinstore-jenkins-obs-live.onrender.com'
];
const ALLOWED_ORIGIN = ALLOWED_ORIGINS[0]; // keep for log

// --- Estado en memoria (ring + 4 streams: jenkins/docker/metrics/k8s) ---
const state = {
  events: [], // ring MAX_EVENTS: docker events + jenkins builds
  containers: [], // último snapshot docker ps
  jenkins: { queue: 0, executors: { busy: 0, idle: 0 }, jobs: [] }, // stream jenkins
  obs: { outboxPending: 0, kafkaPublishErrors: 0, serverTime: null }, // stream metrics dummy
  k8s: { status: 'unknown', context: 'k3d-yadinstore', nodesReady: '—', podsRunning: '—', lastKubectlOk: false, ts: null }, // stream k8s/k3d (agente kubectl)
  lastSeen: null, // ISO del último POST del agente
};

const KAFKA_ACTIVITY_URL = (process.env.KAFKA_ACTIVITY_URL || '').trim() || 'https://yadinstore-backend.onrender.com/api/v1/kafka/activity';
const KAFKA_RATE_LIMIT_MAX = 30; // GET /api/jd/kafka por minuto por IP (bucket separado)
const KAFKA_TIMEOUT_MS = 15000; // 15s para cold start Render free tier (30-60s wake) + retry 25s = cobre 40s total - v2
const rateMap = new Map(); // ip -> { count, resetAt }
const rateMapKafka = new Map(); // bucket separado para GET /api/jd/kafka

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
  const nl = v.indexOf('\n');
  if (nl > 0) v = v.slice(0, nl);
  // oculta secretos (password, token, secret, api_key, email) igual que KafkaActivityController:250
  v = v.replace(/password\s*=\s*[^&\s,;]+/gi, 'password=***');
  v = v.replace(/passwd\s*=\s*[^&\s,;]+/gi, 'passwd=***');
  v = v.replace(/secret\s*=\s*[^&\s,;]+/gi, 'secret=***');
  v = v.replace(/token\s*=\s*[^&\s,;]+/gi, 'token=***');
  v = v.replace(/api[_-]?key\s*=\s*[^&\s,;]+/gi, 'api_key=***');
  v = v.replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '***@***');
  v = v.replace(/\b[\w-]+\.aivencloud\.com:\d+\b/g, '***');
  v = v.replace(/\b[\w-]+\.aivencloud\.com\b/g, '***');
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

function rateLimitedKafka(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  let entry = rateMapKafka.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateMapKafka.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count > KAFKA_RATE_LIMIT_MAX) {
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
      // K8s/k3d — allowlist estricta, solo agregados (sin PII), compatible hacia atrás (si no viene, mantiene unknown)
      if (body.k8s && typeof body.k8s === 'object') {
        const k = body.k8s;
        const ctx = String(k.context || 'k3d-yadinstore').slice(0, 64);
        const nodesReady = String(k.nodesReady || '—').slice(0, 16);
        const podsRunning = String(k.podsRunning || '—').slice(0, 16);
        const lastKubectlOk = Boolean(k.lastKubectlOk);
        const status = String(k.status || (lastKubectlOk ? 'ok' : 'unknown')).slice(0, 20).toLowerCase();
        state.k8s = { status: status === 'ok' || status === 'degraded' ? status : (lastKubectlOk ? 'ok' : 'unknown'), context: ctx, nodesReady, podsRunning, lastKubectlOk, ts: new Date().toISOString() };
      } else if (body.k8s === null) {
        // agente explícitamente resetea
        state.k8s = { status: 'unknown', context: 'k3d-yadinstore', nodesReady: '—', podsRunning: '—', lastKubectlOk: false, ts: new Date().toISOString() };
      }
      state.lastSeen = new Date().toISOString();
      json(res, 200, { ok: true, jenkins: state.jenkins, containers: state.containers.length, obs: state.obs, k8s: state.k8s });
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

  // GET /api/jenkins/live — poll dashboard (público, healthCheck) — incluye k8s
  if (req.method === 'GET' && (url.pathname === '/api/jenkins/live' || url.pathname === '/api/docker/live')) {
    return json(res, 200, {
      events: state.events,
      containers: state.containers,
      jenkins: state.jenkins,
      obs: { ...state.obs, serverTime: new Date().toISOString() },
      k8s: state.k8s,
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
      if (err) return json(res, 500, { error: 'jenkins-dashboard.html no encontrado' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; connect-src 'self' https://yadinstore-jenkins-obs-live.onrender.com https://yadinstore-backend.onrender.com https://ypmanrique2.github.io http://localhost:* http://127.0.0.1:*; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'" });
      res.end(data);
    });
  }

  // GET /yadinstore-topology-3d.html (+ /topology alias) — porcelain copy from yadinStore-Spec, CSP compat iframe, same-origin
  if (req.method === 'GET' && (url.pathname === '/yadinstore-topology-3d.html' || url.pathname === '/topology')) {
    const file = path.join(__dirname, 'yadinstore-topology-3d.html');
    return fs.readFile(file, (err, data) => {
      if (err) return json(res, 500, { error: 'yadinstore-topology-3d.html no encontrado' });
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

  // GET /api/jd/kafka — adapter hexagonal server-side fetch a BE (KAFKA_ACTIVITY_URL), siempre 200 idempotente
  // Fix cold start Render free tier 30-60s: timeout 15s + UN reintento tras 25s si 503 hibernate o timeout (como keep-warm.yml), cache:no-store, 200 fallback amarillo
  if (req.method === 'GET' && url.pathname === '/api/jd/kafka') {
    if (rateLimitedKafka(req, res)) return;
    let limit = parseInt(url.searchParams.get('limit') || '100', 10);
    if (isNaN(limit) || limit < 1) limit = 1;
    if (limit > 200) limit = 200;
    const urlEnv = (KAFKA_ACTIVITY_URL || '').trim();
    if (!urlEnv) {
      return json(res, 200, { status: 'not-configured', cluster: { clusterId: '', brokers: [] }, topics: [], consumerGroups: [], lag: 0, serverTime: new Date().toISOString(), message: sanitizeCause('KAFKA_BOOTSTRAP_SERVERS no definido — el broker no está activado en este entorno') });
    }
    function parseKafkaPayload(j) {
      let payload = j;
      if (j && j.data && typeof j.data === 'object') payload = j.data;
      if (payload && payload.data && typeof payload.data === 'object') payload = payload.data;
      return payload;
    }
    function buildOkResponse(payload) {
      const statusRaw = String(payload.status || 'unavailable').toLowerCase();
      const status = statusRaw === 'ok' ? 'ok' : (statusRaw === 'not-configured' ? 'not-configured' : 'unavailable');
      let cluster = payload.cluster || { clusterId: '', brokers: [] };
      let topics = Array.isArray(payload.topics) ? payload.topics : [];
      let groups = Array.isArray(payload.consumerGroups) ? payload.consumerGroups : (Array.isArray(payload.groups) ? payload.groups : []);
      topics = topics.slice(0, limit);
      groups = groups.slice(0, limit);
      let lag = 0;
      if (typeof payload.lag === 'number') lag = Number(payload.lag);
      else if (groups.length) lag = groups.reduce((s, g) => s + Number(g.lag ?? g.totalLag ?? 0), 0);
      const message = sanitizeCause(String(payload.message || (status === 'ok' ? 'Conectado' : status)));
      return { status, cluster, topics, consumerGroups: groups, lag, serverTime: new Date().toISOString(), message };
    }
    function isHibernatePayload(payload, httpStatus) {
      if (httpStatus === 503) return true;
      const msg = String((payload && (payload.message || payload.error)) || '').toLowerCase();
      return msg.includes('hibernate') || msg.includes('wake') || msg.includes('cold start') || msg.includes('timeoutexception');
    }
    async function fetchOnce(signal) {
      return fetch(urlEnv, { signal, headers: { 'Accept': 'application/json' }, cache: 'no-store' });
    }
    const sig = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(KAFKA_TIMEOUT_MS) : undefined;
    let ctrl;
    let tid;
    if (!sig) { ctrl = new AbortController(); tid = setTimeout(() => ctrl.abort(), KAFKA_TIMEOUT_MS); }
    fetchOnce(sig || ctrl.signal).then(async (up) => {
      if (tid) clearTimeout(tid);
      let payload;
      try {
        const j = await up.json();
        payload = parseKafkaPayload(j);
      } catch (e) {
        // si 503 con body no-json, tratar como hibernate retry — sleep 25s para wake 30-60s
        if (up.status === 503) {
          await new Promise(r => setTimeout(r, 25000));
          const sig2 = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(KAFKA_TIMEOUT_MS) : undefined;
          let ctrl2; let tid2;
          if (!sig2) { ctrl2 = new AbortController(); tid2 = setTimeout(() => ctrl2.abort(), KAFKA_TIMEOUT_MS); }
          try {
            const up2 = await fetchOnce(sig2 || ctrl2.signal);
            if (tid2) clearTimeout(tid2);
            const j2 = await up2.json();
            const p2 = parseKafkaPayload(j2);
            return json(res, 200, buildOkResponse(p2));
          } catch (e2) {
            if (tid2) clearTimeout(tid2);
            const isTimeout2 = e2 && (e2.name === 'AbortError' || e2.name === 'TimeoutError');
            const raw2 = isTimeout2 ? 'BE durmiendo (free tier) — reintenta en 30s: TimeoutException: ' + (e2.message || 'timeout ' + KAFKA_TIMEOUT_MS + 'ms') : sanitizeCause(e2.message || String(e2));
            return json(res, 200, { status: 'unavailable', cluster: { clusterId: '', brokers: [] }, topics: [], consumerGroups: [], lag: 0, serverTime: new Date().toISOString(), message: raw2 });
          }
        }
        return json(res, 200, { status: 'unavailable', cluster: { clusterId: '', brokers: [] }, topics: [], consumerGroups: [], lag: 0, serverTime: new Date().toISOString(), message: sanitizeCause(e.message || 'unavailable') });
      }
      if (isHibernatePayload(payload, up.status)) {
        await new Promise(r => setTimeout(r, 25000));
        const sig2 = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(KAFKA_TIMEOUT_MS) : undefined;
        let ctrl2; let tid2;
        if (!sig2) { ctrl2 = new AbortController(); tid2 = setTimeout(() => ctrl2.abort(), KAFKA_TIMEOUT_MS); }
        try {
          const up2 = await fetchOnce(sig2 || ctrl2.signal);
          if (tid2) clearTimeout(tid2);
          const j2 = await up2.json();
          const p2 = parseKafkaPayload(j2);
          return json(res, 200, buildOkResponse(p2));
        } catch (e2) {
          if (tid2) clearTimeout(tid2);
          const isTimeout2 = e2 && (e2.name === 'AbortError' || e2.name === 'TimeoutError');
          const raw2 = isTimeout2 ? 'BE durmiendo (free tier) — reintenta en 30s: TimeoutException: ' + (e2.message || 'timeout ' + KAFKA_TIMEOUT_MS + 'ms') : sanitizeCause(e2.message || String(e2));
          return json(res, 200, { status: 'unavailable', cluster: { clusterId: '', brokers: [] }, topics: [], consumerGroups: [], lag: 0, serverTime: new Date().toISOString(), message: raw2 });
        }
      }
      return json(res, 200, buildOkResponse(payload));
    }).catch(async (e) => {
      if (tid) clearTimeout(tid);
      const isTimeout = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
      if (isTimeout) {
        await new Promise(r => setTimeout(r, 25000));
        const sig2 = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(KAFKA_TIMEOUT_MS) : undefined;
        let ctrl2; let tid2;
        if (!sig2) { ctrl2 = new AbortController(); tid2 = setTimeout(() => ctrl2.abort(), KAFKA_TIMEOUT_MS); }
        try {
          const up2 = await fetchOnce(sig2 || ctrl2.signal);
          if (tid2) clearTimeout(tid2);
          const j2 = await up2.json();
          const p2 = parseKafkaPayload(j2);
          return json(res, 200, buildOkResponse(p2));
        } catch (e2) {
          if (tid2) clearTimeout(tid2);
          const isTimeout2 = e2 && (e2.name === 'AbortError' || e2.name === 'TimeoutError');
          const raw2 = isTimeout2 ? 'BE durmiendo (free tier) — reintenta en 30s: TimeoutException: ' + (e2.message || 'timeout ' + KAFKA_TIMEOUT_MS + 'ms') : sanitizeCause(e2.message || String(e2));
          return json(res, 200, { status: 'unavailable', cluster: { clusterId: '', brokers: [] }, topics: [], consumerGroups: [], lag: 0, serverTime: new Date().toISOString(), message: raw2 });
        }
      }
      const raw = sanitizeCause(e.message || String(e));
      return json(res, 200, { status: 'unavailable', cluster: { clusterId: '', brokers: [] }, topics: [], consumerGroups: [], lag: 0, serverTime: new Date().toISOString(), message: raw });
    });
    return;
  }

  if (req.method === 'HEAD' && url.pathname === '/api/jd/kafka') {
    if (rateLimitedKafka(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end();
    return;
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
