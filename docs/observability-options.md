# Observabilidad — Opciones Free Tier Porcelain

> Fase2 `jenkins-observability-prod-live` — 2 opciones logs + gateway BE siempre free tier.

## Opcion A — Grafana Cloud Loki OTLP (recomendada prod si queres persistencia)

**Cuando usar:** necesitas retencion 14d, busqueda Loki, dashboards Cloud, alertas.

**Costo:** Free tier Grafana Cloud: 10k series Prometheus, 50GB logs, 50GB traces, 14d retencion, 30d metrics. 0 USD, 0 RAM en Render. Vendor lock Cloud (14d).

**Pasos:**
1. Crear cuenta Grafana Cloud free (grafana.com) → Stack `prod-us-central-0` (o tu region).
2. En Cloud → **Connections → OpenTelemetry → OTLP endpoint** copia `Instance ID` y crea API Key (MetricsPublisher). Base64 de `instanceId:apiKey` → valor `GRAFANA_CLOUD_API_KEY`.
3. Local: `export GRAFANA_CLOUD_API_KEY="<base64>"` (o en `.env`, **sync:false**, nunca commit).
4. Render: Dashboard → service `yadinstore-backend` y `otel-collector` (si deploys collector) → Environment → añade `GRAFANA_CLOUD_API_KEY` sync:false. Re-deploy.
5. Verifica `ci-cd-infra/docker/otel/otel-config.yaml` exporters `otlphttp/grafana_cloud` apunta a `https://otlp-gateway-prod-us-central-0.grafana.net/otlp` con `Authorization: Basic ${GRAFANA_CLOUD_API_KEY}` y pipelines exportan `debug,otlphttp/grafana_cloud`.
6. BE prod: `application-prod.yml:104` `logging.structured.format.console: ecs` ya emite ECS JSON `traceId,level,message,causeChain` sin PII (password=***, 250c). OTel Collector forwardea a Loki.
7. Verificacion: `curl -H "Authorization: Basic $GRAFANA_CLOUD_API_KEY" https://otlp-gateway-prod-us-central-0.grafana.net/otlp/v1/metrics` → 200; en Grafana Cloud Explore → Loki `{app="yadinstore"} |= "ERROR" | json | traceId="abc"` filtra; Prometheus `outbox_pending` <5s lag.

**Env var:**
```
GRAFANA_CLOUD_API_KEY=<base64 instanceId:token> # sync:false, Render + local .env
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-us-central-0.grafana.net/otlp # opcional override
```

**Free tier limites:** 50GB logs 14d, ILM 14d auto, sampling INFO 100% DEBUG off prod, lag Cloud <5s, quota 10k series (nuestros 4 metrics << limite).

---

## Opcion B — Ultra Free Ring 100 (default Fase2, sin Cloud)

**Cuando usar:** quieres 0 costo, 0 vendor, 0 config, <50MB, free tier siempre, demo/local, volatil aceptado.

**Como funciona:** `back-end/src/main/java/com/yadinstore/shared/infrastructure/web/ObservabilityController.java` + `ObservabilityLogBuffer.java` (ring 100, como `yadinstore-jenkins-obs-live/server.js:28` ring 200).
- `GET /api/v1/observability/metrics` → agregados `{outbox:{pending,published,failed}, kafka:{errors}, http:{p95}}` sin PII/email/token, desde `OutboxEventDocumentRepository.countByStatus(PENDING)` + `MeterRegistry` + `http.server.requests` max, CORS Pages-only `https://ypmanrique2.github.io`, rate-limit 10/min.
- `GET /api/v1/observability/logs?traceId=&level=&limit=50` → ring 100 volatile, filter level/traceId, sanitize 250 `password=*** token=*** secret=*** ***@***`, last 100 entries newest first, <50MB RAM, sin Cloud, sin DB.

**Persistencia:** volatil — Render free sleep 15m pierde ring (igual que jenkins-obs-live). Ventana ring 100 logs ~400s si 1 log/4s. Mitigado UptimeRobot 5m en jenkins-obs-live, pero BE ring igual se pierde. **ILM no aplica** (no hay indice), **UptimeRobot no necesita** para BE metrics (Grafana Cloud persist es alternativa).

**Costo:** 0, sin env vars, sin Cloud.

**Verificacion local sin Cloud:**
```bash
# metrics sin token (permitAll agregados)
curl http://localhost:8080/api/v1/observability/metrics | jq .data
# → {"outbox":{"pending":0,"published":0,"failed":0},"kafka":{"errors":0},"http":{"p95":0}}

# logs filtro
curl "http://localhost:8080/api/v1/observability/logs?level=ERROR&limit=2" | jq .logs
# → [{"level":"ERROR","traceId":"demo-trace-abc123","causeChain":"KafkaException: password=*** -> TimeoutException..."}]

# rate-limit 11 req/min → 11ª 429
for i in {1..11}; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/v1/observability/metrics; done
```

---

## Tabla Tradeoffs

| Opcion | Costo | Persistencia | Lag | Complejidad | Privacidad |
|--------|-------|--------------|-----|-------------|------------|
| **A Grafana Cloud Loki OTLP** | 0 free tier (50GB/14d, 10k series) | 14d Cloud, survives sleep, UptimeRobot opcional | <5s (OTel batch + Cloud) | Media: Cloud cuenta + API key + otel-config.yaml + ECS Loki parser | Alta: Cloud vendor, datos en EU/US, retencion 14d borra solo |
| **B Ultra free ring 100** | 0 siempre, sin Cloud | Volatil (sleep pierde), ventana ~400s, 100 entries | <2s (in-memory) | Baja: 0 config, solo BE, CORS Pages-only, 10/min RL | Alta: local-only, sin exfiltracion, sanitize 250 password=***, ***@***, volatil = GDPR friendly |

**Recomendacion Fase2:** default **B** para free tier porcelain (0 Cloud, 0 env, funciona offline), habilitar **A** cuando quieras persistencia (añade `GRAFANA_CLOUD_API_KEY` sync:false y deja debug). Ambas coexisten: `otel-config.yaml` exporta `debug,otlphttp/grafana_cloud` — sin key cae a debug+ring, con key Cloud persiste sin perder ring.

## Gateway BE

`application.yml:166` `management.endpoints.web.exposure.include: health,metrics,prometheus` (local/docker) pero `application-prod.yml:74` solo `health` (404 prometheus directo). Gateway `/api/v1/observability/**` permitAll agregados en `SecurityConfig.java:310` (tradeoff permitAll vs VIEWER comentado para Fase3) proxyea metrics sin exponer prometheus.

