# OBSERVABILITY OPTIONS — yadinstore-jenkins-obs-live // BE Gateway

> Copia canonica de `docs/observability-options.md` — tabla tradeoffs para decision rapida Fase2 free tier porcelain.

| Opcion | Costo | Persistencia | Lag | Complejidad | Privacidad |
|--------|-------|--------------|-----|-------------|------------|
| **A Grafana Cloud Loki OTLP** | 0 free tier (50GB logs/metrics, 10k series, 14d) | 14d Cloud, survives Render sleep, ILM 14d, UptimeRobot opcional | <5s (OTel batch 2s + Cloud) | Media: cuenta Cloud + `GRAFANA_CLOUD_API_KEY` sync:false + `otel-config.yaml` otlphttp | Vendor Cloud (US/EU), retencion 14d auto-borrado |
| **B Ultra free ring 100** | 0 siempre, sin Cloud, sin env | Volatil sleep pierde, ventana 100 entries ~400s, <50MB | <2s in-memory | Baja: solo BE, 0 config, CORS Pages-only, RL 10/min | Local-only, sanitize 250 `password=***` `***@***`, volatil GDPR friendly |

**Detalle Opcion A:** `ci-cd-infra/docker/otel/otel-config.yaml` exporter `otlphttp/grafana_cloud` endpoint `https://otlp-gateway-prod-us-central-0.grafana.net/otlp` headers `Authorization: Basic ${GRAFANA_CLOUD_API_KEY}` (sync:false). Pipelines exportan `debug,otlphttp/grafana_cloud`. BE prod `application-prod.yml:104` ECS JSON `traceId,level,causeChain` sin PII. Grafana Cloud Explore Loki `level=ERROR`/`traceId`. Free 50GB/14d.

**Detalle Opcion B:** `ObservabilityController.java` + `ObservabilityLogBuffer.java` ring 100 (clone `server.js:28` ring 200), `GET /api/v1/observability/metrics` agregados `{outbox:{pending,published,failed},kafka:{errors},http:{p95}}` + `GET /api/v1/observability/logs?traceId=&level=&limit=50` filter traceId/level sanitize 250, CORS Pages-only `https://ypmanrique2.github.io`, RL 10/min, `SecurityConfig.java:310` permitAll agregados (tradeoff VIEWER comentado Fase3). Sin Cloud, sin DB, <50MB, ILM no aplica.

**Recomendacion:** default B para porcelain free tier (0 Cloud), habilitar A cuando necesites persistencia (añade env key, deja debug). Ambas coexisten: sin key funciona B, con key A persiste sin romper B.

**Verificacion:** `curl http://localhost:8080/api/v1/observability/metrics` → 200 `{"outbox":{"pending":0}}`; `curl "http://localhost:8080/api/v1/observability/logs?level=ERROR"` → 200 filtrado; 11 req/min → 429.

Ver `yadinStore-Spec/avance_21-08-2026.md` § Fase2 para appendice completo.

