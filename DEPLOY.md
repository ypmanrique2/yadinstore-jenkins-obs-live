# Deploy — yadinstore-jenkins-obs-live (Render free tier)

> **Servicio Node zero-deps** clone `yadinstore-cicd-demo/docker-live/server.js:22` → Render free `yadinstore-jenkins-obs-live` (ring 200, `healthCheckPath: /api/jenkins/live`, `DOCKER_LIVE_TOKEN sync:false`). Tiempo deploy &lt;5 min + UptimeRobot 5m.

## 1. Crear repo GitHub `ypmanrique2/yadinstore-jenkins-obs-live`

Opción A — nuevo repo dedicado (recomendado, `rootDir` no necesario):

```bash
# en https://github.com/new → owner ypmanrique2, name yadinstore-jenkins-obs-live, visibility Public/Private (free tier ambos), NO inicializar con README
# luego en esta carpeta (ya inicializada git por T103):
git remote add origin https://github.com/ypmanrique2/yadinstore-jenkins-obs-live.git
git branch -M main
git push -u origin main
```

Opción B — monorepo `yadinstore-cicd-demo` (si prefieres un solo repo): descomenta `rootDir: yadinstore-jenkins-obs-live` en `render.yaml:25` y pushea a `yadinstore-cicd-demo`. Blueprint detectará subdir.

> Repo local ya está inicializado en `C:\GITHUB\YadinStore\yadinstore-jenkins-obs-live\` con commit `feat(jenkins-live): docs Pages + deploy ready (T102-103)` — solo falta `remote add` + `push` manual (no push automático por seguridad, fase porcelain).

Archivos incluidos (T101):
```
server.js                 ~226 líneas zero-deps (ring 200, CORS Pages-only, 10/min RL, sanitize 250)
jenkins-dashboard.html    ~168 líneas clone docker-dashboard poll 2s alive 15s esc()+textContent
jenkins-obs-agent.ps1     ~180 líneas 3 jobs docker events + Jenkins :8081/api/json + :9090/query
render.yaml               33 líneas plan:free healthCheckPath /api/jenkins/live sync:false
DEPLOY.md                 este archivo
```

## 2. Conectar Render Blueprint

1. https://dashboard.render.com → **New +** → **Blueprint** → conectar GitHub → elegir `ypmanrique2/yadinstore-jenkins-obs-live` (o `yadinstore-cicd-demo` si opción B).
2. Render lee `render.yaml` → previsualiza servicio `yadinstore-jenkins-obs-live` `runtime: node` `plan: free` `buildCommand: ""` `startCommand: node server.js` `healthCheckPath: /api/jenkins/live`.
3. **Apply** → Render clona, hace `node server.js`, chequea `GET /api/jenkins/live → 200` en &lt;30s. Logs: `[jenkins-obs-live] escuchando en :10000 (token auth: OFF/ON, origin: https://ypmanrique2.github.io)`.
4. URL asignada: `https://yadinstore-jenkins-obs-live.onrender.com` (confirmar en dashboard). Endpoints:
   - `GET  /api/jenkins/live` público
   - `GET  /jenkins-dashboard.html`
   - `POST /api/jenkins/events|snapshot|metrics` con `x-live-token`

> Clone patrón `yadinstore-cicd-demo-live` (BE-KD): mismo flujo, diferente path vivo.

## 3. Env var `DOCKER_LIVE_TOKEN` (`sync:false`)

En Render → Service → **Environment** → `DOCKER_LIVE_TOKEN` (o `JENKINS_LIVE_TOKEN` alias) → **Generate Random Value** o pegar secreto (ej. `openssl rand -base64 24`) → Save → **Deploy**.

- `sync:false` → no se commitea en `render.yaml` (cero secrets en repo, Spec exige).
- Agente local debe usar mismo token:

```powershell
.\jenkins-obs-agent.ps1 -Endpoint https://yadinstore-jenkins-obs-live.onrender.com -Token "xxx"
# o
$env:DOCKER_LIVE_TOKEN="xxx"; .\jenkins-obs-agent.ps1
```

Test:

```bash
# sin token → 401
curl -X POST https://yadinstore-jenkins-obs-live.onrender.com/api/jenkins/events -H "Content-Type: application/json" -d '[{}]' | jq .error
# → unauthorized

# con token → 200
curl -X POST https://yadinstore-jenkins-obs-live.onrender.com/api/jenkins/events -H "x-live-token: xxx" -H "Content-Type: application/json" -d '[{"job":"test"}]' | jq
# → {"ok":true,"stored":1,"total":1}
```

## 4. UptimeRobot — anti-sleep free tier (5 min)

Render free duerme ~15m sin tráfico (cold 30s, ring volatiliza).

1. https://uptimerobot.com → **Add New Monitor** → Type **HTTP(s)** → Friendly Name `yadinstore-jenkins-obs-live` → URL `https://yadinstore-jenkins-obs-live.onrender.com/api/jenkins/live` → Monitoring Interval **5 minutes** → Create.
2. Segundo monitor igual para `yadinstore-cicd-demo-live` y `yadinstore-backend` si aún no existen (2-3 monitors 5m = ~26k req/mes c/u, OK).
3. Verificar green en <5m: `GET /api/jenkins/live` debe dar `200` con `serverTime` fresco. Si red, revisar `healthCheckPath` en dashboard (debe ser `/api/jenkins/live`).

> Quota Render 750h/mes ×2 servicios con UptimeRobot ~100% uptime; si >70% usage pausar jenkins-obs-live en horas valle (roadmap).

## 5. Verificación post-deploy (T104 local sin deploy simula, prod tras steps 1-4)

```bash
# prod vivo
curl https://yadinstore-jenkins-obs-live.onrender.com/api/jenkins/live | jq '.serverTime, .lastSeen'
curl https://yadinstore-jenkins-obs-live.onrender.com/jenkins-dashboard.html | grep -q "Jenkins en vivo" && echo "dashboard 200"

# CORS Pages-only
curl -s -D - https://yadinstore-jenkins-obs-live.onrender.com/api/jenkins/live -H "Origin: https://ypmanrique2.github.io" | grep -i access-control-allow-origin
# → Access-Control-Allow-Origin: https://ypmanrique2.github.io

# Agente prod
pwsh ./jenkins-obs-agent.ps1 -Endpoint https://yadinstore-jenkins-obs-live.onrender.com -Token "xxx"
# → [events] enviados: N / [snapshot] queue: ...

# Rate-limit 10/min IP → 11ª 429
for i in {1..11}; do curl -s -w "%{http_code} " -X POST https://yadinstore-jenkins-obs-live.onrender.com/api/jenkins/events -H "x-live-token: xxx" -H "Content-Type: application/json" -d '[{}]' -o /dev/null; done; echo
```

Y Pages (tras T102): `https://ypmanrique2.github.io/yadinstore-cicd-demo/` badge ONLINE &lt;15s + docs `jenkins-live.html` fetch `https://yadinstore-jenkins-obs-live.onrender.com/api/jenkins/live`.

## 6. Pasos manuales pendientes (porcelain — no push automático)

- [ ] `gh repo create ypmanrique2/yadinstore-jenkins-obs-live --public --source=. --push` **o** crear en github.com/new + `git remote add origin ...` + `git push -u origin main` (esta carpeta).
- [ ] Render Blueprint Apply + `DOCKER_LIVE_TOKEN` env + deploy green.
- [ ] UptimeRobot 5m `GET /api/jenkins/live`.
- [ ] `git` en `yadinstore-cicd-demo` (T102): `git add index.html docs/jenkins-live.md docs/observability-live.md` + `git commit -m "feat(jenkins-live): docs Pages + deploy ready (T102-103)"` + `git push origin main` (tras review).
- [ ] Verificar Pages: `https://ypmanrique2.github.io/yadinstore-cicd-demo/docs/jenkins-live.html` → 200 con `fetch.*api/jenkins/live`.

Rollback: Render → Service → **Delete**, UptimeRobot → **Delete monitor**, `git revert` del commit, Pages sin badge.

## Notas

- `render.yaml:28 healthCheckPath /api/jenkins/live` **público** (sin token) para Render healthchecks.
- `env DOCKER_LIVE_TOKEN sync:false` — único secret, no se versiona.
- Zero-deps, &lt;50MB, `autoDeploy:true`, `NODE_ENV=production`, CSP `default-src 'self'`.
- Ref: `avance_21-08-2026.md §7` (T101 clone) y §8 (ES descartado Cloud roadmap), Spec #676 Delta1/2, Design #677 ADR-013/014.
