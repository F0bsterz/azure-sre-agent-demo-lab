/**
 * Lab health aggregation and the synthetic monitoring loop.
 *
 * The loop is what publishes the sre_demo_* custom metrics on a short cadence,
 * which is what lets the Azure Monitor alert rules fire within a few minutes
 * instead of at the mercy of infrastructure metric latency.
 */

import { config } from './config.js';
import { log, errorFields } from './logger.js';
import { getConnectionStats, flushPending, pendingEventCount } from './db.js';
import { diskUsage, httpProbe, tcpProbe, tlsProbe } from './probes.js';
import { runnerStatus } from './runner.js';
import { getNodePool, azureConfigured } from './azure.js';
import { telemetry, METRICS } from './telemetry.js';
import { activeScenarios } from './scenarios/index.js';

export type HealthState = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

export interface ComponentHealth {
  name: string;
  state: HealthState;
  detail: string;
  metrics?: Record<string, number | string | boolean | null>;
}

export interface LabStatus {
  collectedAt: string;
  overall: HealthState;
  components: ComponentHealth[];
  activeIncident: {
    scenarioId: string;
    name: string;
    state: string;
    activatedAt?: string;
    elapsedSeconds?: number;
    expiresAt?: string;
    severity: string;
  } | null;
  telemetry: {
    applicationInsightsConfigured: boolean;
    bufferedEvents: number;
  };
  environment: {
    suffix: string;
    resourceGroup: string;
    location: string;
    aksCluster: string;
    magic8ballUrl: string;
    magic8ballHttpsUrl: string;
    magic8ballPublicUrl: string;
  };
}

function worst(states: HealthState[]): HealthState {
  if (states.includes('UNHEALTHY')) return 'UNHEALTHY';
  if (states.includes('DEGRADED')) return 'DEGRADED';
  if (states.includes('UNKNOWN')) return 'UNKNOWN';
  return 'HEALTHY';
}

export async function labStatus(): Promise<LabStatus> {
  const [disk, pg, tcp, runner, magic8Http, magic8Tls] = await Promise.all([
    diskUsage().catch(() => undefined),
    getConnectionStats(),
    tcpProbe(config.postgres.host, config.postgres.port),
    runnerStatus(),
    httpProbe(`${config.magic8ball.httpUrl}/healthz`),
    tlsProbe(config.magic8ball.httpsUrl),
  ]);

  const nodePool =
    azureConfigured() && config.aks.clusterName ? await getNodePool().catch(() => undefined) : undefined;

  const components: ComponentHealth[] = [];

  components.push({
    name: 'App VM',
    state: !disk ? 'UNKNOWN' : disk.percentUsed >= 85 ? 'UNHEALTHY' : disk.percentUsed >= 70 ? 'DEGRADED' : 'HEALTHY',
    detail: disk
      ? `${config.disk.mountPath} ${disk.percentUsed}% used, ${(disk.freeBytes / 1024 ** 3).toFixed(2)} GB free`
      : 'Demo disk usage unavailable',
    metrics: disk
      ? {
          percentUsed: disk.percentUsed,
          freeGb: Math.round((disk.freeBytes / 1024 ** 3) * 100) / 100,
          totalGb: Math.round((disk.totalBytes / 1024 ** 3) * 100) / 100,
        }
      : undefined,
  });

  components.push({
    name: 'PostgreSQL',
    state: !tcp.reachable
      ? 'UNHEALTHY'
      : !pg.reachable
        ? 'UNHEALTHY'
        : pg.percentUsed >= 80
          ? 'DEGRADED'
          : 'HEALTHY',
    detail: !tcp.reachable
      ? `TCP 5432 unreachable: ${tcp.error ?? 'no route'}`
      : pg.reachable
        ? `${pg.activeConnections}/${pg.maxConnections} connections (${pg.percentUsed}%)`
        : `Query failed: ${pg.error ?? 'unknown'}`,
    metrics: {
      tcpReachable: tcp.reachable,
      activeConnections: pg.activeConnections,
      maxConnections: pg.maxConnections,
      percentUsed: pg.percentUsed,
      latencyMs: pg.latencyMs,
    },
  });

  components.push({
    name: 'AKS',
    state: !runner.reachable
      ? 'UNKNOWN'
      : runner.pendingPods > 0
        ? 'DEGRADED'
        : 'HEALTHY',
    detail: runner.reachable
      ? `${nodePool?.count ?? runner.nodeCount} node(s), ${runner.pendingPods} pending pod(s)`
      : `scenario-runner unreachable: ${runner.error ?? 'unknown'}`,
    metrics: {
      nodeCount: nodePool?.count ?? runner.nodeCount,
      pendingPods: runner.pendingPods,
      nodeVmSize: nodePool?.vmSize ?? null,
      runnerReachable: runner.reachable,
    },
  });

  components.push({
    name: 'Magic 8 Ball',
    state: magic8Http.ok ? (magic8Http.latencyMs > 2000 ? 'DEGRADED' : 'HEALTHY') : 'UNHEALTHY',
    detail: magic8Http.ok
      ? `HTTP ${magic8Http.statusCode} in ${magic8Http.latencyMs}ms, ${runner.magic8ball.readyReplicas}/${runner.magic8ball.desiredReplicas} replicas ready`
      : `HTTP check failed: ${magic8Http.error ?? magic8Http.statusCode}`,
    metrics: {
      httpOk: magic8Http.ok,
      statusCode: magic8Http.statusCode ?? null,
      latencyMs: magic8Http.latencyMs,
      variant: runner.magic8ball.variant ?? null,
      image: runner.magic8ball.image ?? null,
      readyReplicas: runner.magic8ball.readyReplicas,
    },
  });

  components.push({
    name: 'TLS',
    state: magic8Tls.valid ? ((magic8Tls.daysRemaining ?? 999) < 14 ? 'DEGRADED' : 'HEALTHY') : 'UNHEALTHY',
    detail: magic8Tls.valid
      ? `Valid until ${magic8Tls.notAfter} (${magic8Tls.daysRemaining} days)`
      : (magic8Tls.reason ?? 'TLS validation failed'),
    metrics: {
      valid: magic8Tls.valid,
      expired: magic8Tls.expired,
      daysRemaining: magic8Tls.daysRemaining ?? null,
      notAfter: magic8Tls.notAfter ?? null,
    },
  });

  const active = activeScenarios();
  const incident = active[0];

  return {
    collectedAt: new Date().toISOString(),
    overall: worst(components.map((component) => component.state)),
    components,
    activeIncident: incident
      ? {
          scenarioId: incident.id,
          name: incident.name,
          state: incident.state,
          activatedAt: incident.activatedAt,
          elapsedSeconds: incident.activatedAt
            ? Math.floor((Date.now() - Date.parse(incident.activatedAt)) / 1000)
            : undefined,
          expiresAt: incident.expiresAt,
          severity: incident.severity,
        }
      : null,
    telemetry: {
      applicationInsightsConfigured: telemetry.enabled,
      bufferedEvents: pendingEventCount(),
    },
    environment: {
      suffix: config.labSuffix,
      resourceGroup: config.azure.resourceGroup,
      location: config.azure.location,
      aksCluster: config.aks.clusterName,
      magic8ballUrl: config.magic8ball.httpUrl,
      magic8ballHttpsUrl: config.magic8ball.httpsUrl,
      magic8ballPublicUrl: config.magic8ball.publicUrl,
    },
  };
}

/** Publishes the sre_demo_* metric family on a short, demo-friendly cadence. */
export function startProbeLoop(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const [disk, pg, tcp, magic8Http, magic8Tls, runner] = await Promise.all([
        diskUsage().catch(() => undefined),
        getConnectionStats(),
        tcpProbe(config.postgres.host, config.postgres.port),
        httpProbe(`${config.magic8ball.httpUrl}/healthz`),
        tlsProbe(config.magic8ball.httpsUrl),
        runnerStatus(),
      ]);

      if (disk) {
        telemetry.trackMetric(METRICS.diskPercentUsed, disk.percentUsed, { mount: disk.mountPath });
      }

      telemetry.trackMetric(METRICS.postgresActiveConnections, pg.activeConnections);
      telemetry.trackMetric(METRICS.postgresConnectionPercent, pg.percentUsed);
      telemetry.trackMetric(METRICS.postgresConnectivity, tcp.reachable && pg.reachable ? 1 : 0);
      telemetry.trackMetric(METRICS.postgresLatencyMs, pg.latencyMs);
      telemetry.trackDependency({
        name: 'postgres health probe',
        type: 'PostgreSQL',
        target: config.postgres.host,
        data: `SELECT pg_stat_activity census on ${config.postgres.database}`,
        durationMs: pg.latencyMs,
        success: tcp.reachable && pg.reachable,
        resultCode: tcp.reachable && pg.reachable ? '200' : '503',
      });

      telemetry.trackMetric(METRICS.magic8ballHttpSuccess, magic8Http.ok ? 1 : 0);
      telemetry.trackMetric(METRICS.magic8ballLatencyMs, magic8Http.latencyMs);
      telemetry.trackDependency({
        name: 'magic8ball health probe',
        type: 'HTTP',
        target: 'magic8ball',
        data: `${config.magic8ball.httpUrl}/healthz`,
        durationMs: magic8Http.latencyMs,
        success: magic8Http.ok,
        resultCode: String(magic8Http.statusCode ?? 0),
      });

      telemetry.trackMetric(METRICS.magic8ballTlsValid, magic8Tls.valid ? 1 : 0);
      if (typeof magic8Tls.daysRemaining === 'number') {
        telemetry.trackMetric(METRICS.magic8ballTlsDaysRemaining, magic8Tls.daysRemaining);
      }

      telemetry.trackMetric(METRICS.aksPendingPods, runner.pendingPods);
      if (runner.nodeCount > 0) telemetry.trackMetric(METRICS.aksNodeCount, runner.nodeCount);

      const active = activeScenarios();
      telemetry.trackMetric(METRICS.scenarioActive, active.length > 0 ? 1 : 0, {
        'scenario.id': active[0]?.id ?? 'none',
      });

      if (pg.reachable) await flushPending();
    } catch (error) {
      log.warn('probe loop iteration failed', errorFields(error));
    }
  };

  void tick();
  const handle = setInterval(() => void tick(), config.telemetry.probeIntervalMs);
  handle.unref();
  return handle;
}
