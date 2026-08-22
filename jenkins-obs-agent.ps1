# ================================================================
# jenkins-obs-agent.ps1 — Agente local Jenkins+obs (Windows)
#
# Fork de `yadinstore-cicd-demo/docker-live/docker-agent.ps1:17`
# adaptado para 3 streams:
#   1) docker events --filter container=yadin-jenkins (streaming)
#   2) Jenkins http://localhost:8081/api/json (queue + executors + jobs)
#   3) (futuro) metrics scrape http://localhost:8080/actuator/prometheus
#      o http://localhost:9090/api/v1/query?query=outbox_pending
#
# Hace batch cada 2s POST a Render `yadinstore-jenkins-obs-live`
# con header `x-live-token` (si DOCKER_LIVE_TOKEN definida).
# No crashea si Jenkins/Docker caído: envía snapshot parcial
# `status:unavailable causeChain sanitizado`.
#
# Uso:
#   .\jenkins-obs-agent.ps1                                          # contra Render (sin token demo)
#   .\jenkins-obs-agent.ps1 -Endpoint http://localhost:3000 -Token secret
#   .\jenkins-obs-agent.ps1 -Endpoint https://yadinstore-jenkins-obs-live.onrender.com -Token $env:DOCKER_LIVE_TOKEN
#
# Requiere: Docker Desktop (opcional, solo para stream), Jenkins 8081 opcional.
# ================================================================

param(
    [string]$Endpoint = "https://yadinstore-jenkins-obs-live.onrender.com",
    [string]$Token = "",
    [int]$SnapshotIntervalSec = 5,
    [int]$BatchIntervalSec = 2,
    [string]$JenkinsUrl = "http://localhost:8081",
    [string]$PrometheusUrl = "http://localhost:9090",
    [string]$ActuatorUrl = "http://localhost:8080"
)

$ErrorActionPreference = "Continue"

function Sanitize-Cause([string]$s) {
    if (-not $s) { return $s }
    $v = $s.Substring(0, [Math]::Min(250, $s.Length))
    $v = $v -replace 'password\s*=\s*[^&\s,;]+', 'password=***'
    $v = $v -replace 'secret\s*=\s*[^&\s,;]+', 'secret=***'
    $v = $v -replace 'token\s*=\s*[^&\s,;]+', 'token=***'
    $v = $v -replace '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', '***@***'
    return $v
}

$headers = @{ "Content-Type" = "application/json" }
if ($Token) { $headers["x-live-token"] = $Token }

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " jenkins-obs-agent -> $Endpoint" -ForegroundColor Cyan
Write-Host " Jenkins: $JenkinsUrl | Docker: yadin-jenkins | Metrics: $ActuatorUrl / $PrometheusUrl" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Batch cada ${BatchIntervalSec}s, snapshot ${SnapshotIntervalSec}s. Ctrl+C para salir." -ForegroundColor Green
if ($Token) { Write-Host " Token auth: ON" -ForegroundColor Yellow } else { Write-Host " Token auth: OFF (demo)" -ForegroundColor DarkGray }

$hasDocker = $false
if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker version > $null 2>&1
    if ($LASTEXITCODE -eq 0) { $hasDocker = $true; Write-Host " Docker: OK" -ForegroundColor Green }
    else { Write-Host " Docker: no corriendo (solo Jenkins stream)" -ForegroundColor Yellow }
} else {
    Write-Host " docker CLI no encontrado — solo Jenkins/metrics stream" -ForegroundColor Yellow
}

$eventBatch = [System.Collections.Generic.List[string]]::new()
$snapshotTimer = [System.Diagnostics.Stopwatch]::StartNew()
$eventsJob = $null
if ($hasDocker) {
    # Streaming docker events filtrado a yadin-jenkins (si no existe, no emite pero no falla)
    $eventsJob = Start-Job -ScriptBlock { param($filter) docker events --format json --filter type=container --filter container=yadin-jenkins 2>$null } -ArgumentList "yadin-jenkins"
}

try {
    while ($true) {
        # 1) Recolectar docker events del job
        if ($eventsJob) {
            $lines = Receive-Job $eventsJob -Keep 2>$null
            if ($lines) {
                foreach ($line in $lines) {
                    if ($line -and $line.Trim()) { $eventBatch.Add($line) }
                }
            }
        }

        # 2) Fetch Jenkins queue/executors/jobs (cada BatchIntervalSec, no crashea si cae)
        $jenkinsSnapshot = $null
        try {
            $jenkinsJson = Invoke-RestMethod -Method Get -Uri "$JenkinsUrl/api/json?tree=jobs[name,lastBuild[number,result,timestamp,duration],queueItem],primaryView,overallLoad[busyExecutors,totalExecutors]" -TimeoutSec 5 -ErrorAction Stop
            # overallLoad puede no existir en versiones viejas; fallback a nodes
            $busy = 0; $idle = 0; $queue = 0
            if ($jenkinsJson.overallLoad) { $busy = [int]($jenkinsJson.overallLoad.busyExecutors ?? 0); $idle = [int](($jenkinsJson.overallLoad.totalExecutors ?? 0) - $busy) }
            # queue items
            try {
                $q = Invoke-RestMethod -Method Get -Uri "$JenkinsUrl/queue/api/json?tree=items[id,task[name]]" -TimeoutSec 3 -ErrorAction SilentlyContinue
                if ($q.items) { $queue = @($q.items).Count }
            } catch { $queue = 0 }
            $jobs = @()
            if ($jenkinsJson.jobs) {
                foreach ($j in $jenkinsJson.jobs) {
                    $jobs += @{ name = $j.name; lastBuild = if ($j.lastBuild) { @{ number = $j.lastBuild.number; result = $j.lastBuild.result; timestamp = $j.lastBuild.timestamp; duration = $j.lastBuild.duration } } else { $null } }
                }
            }
            if (-not $busy -and -not $idle) {
                # fallback: estimar 2 executors por defecto si no hay overallLoad
                $busy = 0; $idle = 2
            }
            $jenkinsSnapshot = @{ queue = $queue; executors = @{ busy = $busy; idle = $idle }; jobs = $jobs }
        } catch {
            $cause = Sanitize-Cause $_.Exception.Message
            $jenkinsSnapshot = @{ queue = 0; executors = @{ busy = 0; idle = 0 }; jobs = @(); status = "unavailable"; causeChain = $cause }
            Write-Host "  [jenkins] unavailable: $cause" -ForegroundColor Yellow
        }

        # 3) Fetch metrics dummy (prometheus/actuator) cada SnapshotIntervalSec
        $obsSnapshot = $null
        if ($snapshotTimer.Elapsed.TotalSeconds -ge $SnapshotIntervalSec) {
            $snapshotTimer.Restart()
            $outboxPending = 0
            # Intento 1: actuator prometheus local (docker profile)
            try {
                $prom = Invoke-RestMethod -Method Get -Uri "$ActuatorUrl/actuator/prometheus" -TimeoutSec 3 -ErrorAction SilentlyContinue
                if ($prom -match 'outbox_pending\s+([0-9.]+)') { $outboxPending = [int][double]$Matches[1] }
            } catch {}
            # Intento 2: prometheus query API (ci-cd-infra)
            if ($outboxPending -eq 0) {
                try {
                    $q = Invoke-RestMethod -Method Get -Uri "$PrometheusUrl/api/v1/query?query=outbox_pending" -TimeoutSec 3 -ErrorAction SilentlyContinue
                    if ($q.data.result -and $q.data.result[0].value[1]) { $outboxPending = [int][double]$q.data.result[0].value[1] }
                } catch {}
            }
            # Dummy si no hay métrica real (estructura ok para fase1)
            $obsSnapshot = @{ outboxPending = $outboxPending; kafkaPublishErrors = 0 }

            # Docker ps snapshot periódico
            if ($hasDocker) {
                try {
                    $containers = @(docker ps --format json 2>$null | ForEach-Object { $_ | ConvertFrom-Json })
                    if ($containers -or $true) {
                        $payload = @{ jenkins = $jenkinsSnapshot; containers = $containers; obs = $obsSnapshot } | ConvertTo-Json -Depth 6 -Compress
                        try {
                            Invoke-RestMethod -Method Post -Uri "$Endpoint/api/jenkins/snapshot" -Headers $headers -Body $payload -TimeoutSec 10 | Out-Null
                            Write-Host "  [snapshot] queue:$($jenkinsSnapshot.queue) busy:$($jenkinsSnapshot.executors.busy) idle:$($jenkinsSnapshot.executors.idle) containers:$($containers.Count) outbox:$outboxPending" -ForegroundColor DarkGray
                        } catch {
                            Write-Host "  [snapshot] error: $($_.Exception.Message)" -ForegroundColor Yellow
                        }
                    }
                } catch {
                    Write-Host "  [snapshot] docker ps error: $($_.Exception.Message)" -ForegroundColor Yellow
                }
            } else {
                # Sin docker, igual POST snapshot jenkins+obs
                $payload = @{ jenkins = $jenkinsSnapshot; obs = $obsSnapshot } | ConvertTo-Json -Depth 6 -Compress
                try {
                    Invoke-RestMethod -Method Post -Uri "$Endpoint/api/jenkins/snapshot" -Headers $headers -Body $payload -TimeoutSec 10 | Out-Null
                    Write-Host "  [snapshot] queue:$($jenkinsSnapshot.queue) busy:$($jenkinsSnapshot.executors.busy) outbox:$outboxPending (sin docker)" -ForegroundColor DarkGray
                } catch {
                    Write-Host "  [snapshot] error: $($_.Exception.Message)" -ForegroundColor Yellow
                }
            }
        } else {
            # En intervalos no-snapshot, igual refrescar jenkins snapshot liviano cada BatchIntervalSec
            if ($jenkinsSnapshot) {
                $payload = @{ jenkins = $jenkinsSnapshot } | ConvertTo-Json -Depth 6 -Compress
                try {
                    Invoke-RestMethod -Method Post -Uri "$Endpoint/api/jenkins/snapshot" -Headers $headers -Body $payload -TimeoutSec 10 | Out-Null
                    Write-Host "  [jenkins] queue:$($jenkinsSnapshot.queue) jobs:$($jenkinsSnapshot.jobs.Count)" -ForegroundColor DarkGray
                } catch {
                    Write-Host "  [jenkins] post error: $($_.Exception.Message)" -ForegroundColor Yellow
                }
            }
        }

        # 4) POST batch de events (si hay)
        if ($eventBatch.Count -gt 0) {
            $events = $eventBatch | ForEach-Object { $_ | ConvertFrom-Json }
            # Enriquecer con type=docker si falta
            $enriched = $events | ForEach-Object { if (-not $_.type) { $_ | Add-Member -NotePropertyName type -NotePropertyValue "docker" -PassThru } else { $_ } }
            $payload = $enriched | ConvertTo-Json -Depth 6 -Compress
            # Si el servidor espera [...] directo:
            try {
                Invoke-RestMethod -Method Post -Uri "$Endpoint/api/jenkins/events" -Headers $headers -Body $payload -TimeoutSec 10 | Out-Null
                Write-Host "  [events] enviados: $($eventBatch.Count)" -ForegroundColor DarkGray
            } catch {
                Write-Host "  [events] error: $($_.Exception.Message)" -ForegroundColor Yellow
            }
            $eventBatch.Clear()
        }

        Start-Sleep -Seconds $BatchIntervalSec
    }
} finally {
    if ($eventsJob) { Stop-Job $eventsJob -ErrorAction SilentlyContinue; Remove-Job $eventsJob -ErrorAction SilentlyContinue }
}
