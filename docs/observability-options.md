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

`application.yml:166` `management.endpoints.web.exposure.include: health,metrics,prometheus` (local/docker) pero `application-prod.yml:74` solo `health` (404 prometheus directo). Gateway `/api/v1/observability/**` **VIEWER gate** `hasAnyAuthority('ROLE_VIEWER','ROLE_ADMIN')` en `SecurityConfig.java:214` + `@PreAuthorize` en `ObservabilityController.java:77,123` (T301 cierra deuda Fase2 `permitAll`) proxyea metrics sin exponer prometheus — ver T303 dashboard RED con `${DS_PROMETHEUS}`.


---

## T303 Dashboard RED as-code (22-08 noche)

**Provisioning as-code** — `ci-cd-infra/`:

- `docker/grafana/provisioning/datasources/datasource.yml` → Prometheus `http://prometheus:9090` `uid:DS_PROMETHEUS` `isDefault:true` (Grafana 10.4.3 auto-provisiona, sin UI manual).
- `docker/grafana/provisioning/dashboards/dashboard.yml` → provider `YadinStore` `path:/var/lib/grafana/dashboards` `updateIntervalSeconds:10`.
- `monitoring/grafana/dashboards/observability-live.json` + `monitoring/grafana/dashboards/observability-live.json` (mirror) → 7 panels RED con datasource `${DS_PROMETHEUS}`:
  1. **Rate** `sum(rate(http_server_requests_seconds_count{application="yadinstore"}[5m]))` unit `reqps` thresholds 0/10/50.
  2. **Errors 5xx** `sum(rate(http_server_requests_seconds_count{application="yadinstore",status=~"5.."}[5m]))` thresholds 0/0.05/0.5.
  3. **p95** `histogram_quantile(0.95, sum(rate(http_server_requests_seconds_bucket{application="yadinstore"}[5m])) by (le))` unit `s` thresholds 0/0.25/0.5/1 — requiere `application.yml:177 percentiles-histogram true` (T302).
  4. **Gauge** `outbox_pending{application="yadinstore"}` unit `short` thresholds 0/5/10/20.
  5. **Counter** `outbox_published_total` `sum(rate(...[5m]))` + `increase` unit `ops`.
  6. **Counter** `outbox_failed_total` rate thresholds 0/0.01/0.1.
  7. **Counter** `kafka_publish_errors_total` rate thresholds 0/0.01/0.1.

Todos con `__inputs DS_PROMETHEUS`, `schemaVersion:39`, `refresh:5s`, `timezone:browser`.

**Verificación local:**

```bash
docker compose up -d prometheus grafana
curl http://localhost:9090/api/v1/query?query=outbox_pending | jq .data.result
# → pending gauge
curl http://localhost:9090/api/v1/query?query=histogram_quantile%280.95%2C%20sum%28rate%28http_server_requests_seconds_bucket%5B5m%5D%29%29%20by%20%28le%29%29 | jq
# → p95

# Grafana http://localhost:3000 admin/admin → Dashboards → YadinStore — Observability Live RED (7 panels)
python -c "import json; json.load(open('monitoring/grafana/dashboards/observability-live.json')); print('JSON OK panels=7')"
docker compose config | grep grafana -A2
# → provisioning:/etc/grafana/provisioning:ro + dashboards:/var/lib/grafana/dashboards:ro
```

**Gateway BE Fase3 (actualizado):** `SecurityConfig.java:214` `hasAnyAuthority('ROLE_VIEWER','ROLE_ADMIN')` + `@PreAuthorize` en `ObservabilityController.java:77,123` (T301) — Pages necesitará `Authorization: Bearer <VIEWER_JWT>` en T304.

**Free tier:** dashboard JSON `<14KB`, 7 panels `<10k series` Prometheus free tier, no rompe compose, no secrets.


