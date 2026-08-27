/**
 * Application Insights telemetry.
 *
 * This talks to the Application Insights ingestion endpoint directly rather
 * than through the SDK. The reason is control: the alert rules in
 * infra/bicep/modules/alerts.bicep query specific tables (AppMetrics,
 * AppRequests, AppDependencies, AppEvents) with specific metric names, and
 * emitting the envelopes explicitly guarantees those shapes. It also keeps the
 * runtime image free of transitive dependencies.
 *
 * Telemetry is best-effort by design: a lab whose control plane fell over
 * because its monitoring endpoint was unreachable would defeat the exercise.
 */

import { hostname } from 'node:os';

type Envelope = Record<string, unknown>;

export interface ScenarioContext {
  scenarioId?: string;
  scenarioName?: string;
  scenarioState?: string;
  scenarioStartedAt?: string;
  scenarioComponent?: string;
  correlationId?: string;
}

interface Parsed {
  instrumentationKey: string;
  ingestionEndpoint: string;
}

function parseConnectionString(value: string): Parsed | undefined {
  if (!value) return undefined;
  const parts = new Map<string, string>();
  for (const segment of value.split(';')) {
    const index = segment.indexOf('=');
    if (index <= 0) continue;
    parts.set(segment.slice(0, index).trim().toLowerCase(), segment.slice(index + 1).trim());
  }
  const instrumentationKey = parts.get('instrumentationkey');
  if (!instrumentationKey) return undefined;
  const endpoint = parts.get('ingestionendpoint') ?? 'https://dc.services.visualstudio.com/';
  return {
    instrumentationKey,
    ingestionEndpoint: endpoint.replace(/\/+$/, ''),
  };
}

/** Application Insights wants .NET TimeSpan format: d.hh:mm:ss.fffffff */
function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const days = Math.floor(safe / 86_400_000);
  const hours = Math.floor((safe % 86_400_000) / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${days}.${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}0000`;
}

function scenarioProperties(context?: ScenarioContext): Record<string, string> {
  if (!context) return {};
  const properties: Record<string, string> = {};
  if (context.scenarioId) properties['scenario.id'] = context.scenarioId;
  if (context.scenarioName) properties['scenario.name'] = context.scenarioName;
  if (context.scenarioState) properties['scenario.state'] = context.scenarioState;
  if (context.scenarioStartedAt) properties['scenario.startedAt'] = context.scenarioStartedAt;
  if (context.scenarioComponent) properties['scenario.component'] = context.scenarioComponent;
  if (context.correlationId) properties['scenario.correlationId'] = context.correlationId;
  return properties;
}

class Telemetry {
  private parsed: Parsed | undefined;
  private readonly queue: Envelope[] = [];
  private readonly roleInstance = hostname();
  private roleName = 'scenario-controller';
  private baseProperties: Record<string, string> = {};
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;

  configure(connectionString: string, roleName: string, baseProperties: Record<string, string> = {}): void {
    this.parsed = parseConnectionString(connectionString);
    this.roleName = roleName;
    this.baseProperties = baseProperties;
    if (this.parsed && !this.timer) {
      this.timer = setInterval(() => void this.flush(), 5000);
      this.timer.unref();
    }
  }

  get enabled(): boolean {
    return this.parsed !== undefined;
  }

  private envelope(name: string, baseType: string, baseData: Record<string, unknown>): void {
    if (!this.parsed) return;
    this.queue.push({
      name: `Microsoft.ApplicationInsights.${name}`,
      time: new Date().toISOString(),
      iKey: this.parsed.instrumentationKey,
      tags: {
        'ai.cloud.role': this.roleName,
        'ai.cloud.roleInstance': this.roleInstance,
        'ai.internal.sdkVersion': 'sre-demo-lab:0.1.0',
      },
      data: { baseType, baseData: { ver: 2, ...baseData } },
    });
    // Bound memory if the endpoint is unreachable for a long time.
    if (this.queue.length > 2000) this.queue.splice(0, this.queue.length - 2000);
    if (this.queue.length >= 50) void this.flush();
  }

  private properties(extra?: Record<string, string>, context?: ScenarioContext): Record<string, string> {
    return { ...this.baseProperties, ...scenarioProperties(context), ...(extra ?? {}) };
  }

  trackMetric(
    name: string,
    value: number,
    properties?: Record<string, string>,
    context?: ScenarioContext,
  ): void {
    this.envelope('Metric', 'MetricData', {
      metrics: [{ name, value, count: 1, kind: 0 }],
      properties: this.properties({ host: this.roleInstance, ...(properties ?? {}) }, context),
    });
  }

  trackEvent(name: string, properties?: Record<string, string>, context?: ScenarioContext): void {
    this.envelope('Event', 'EventData', {
      name,
      properties: this.properties(properties, context),
    });
  }

  trackRequest(input: {
    name: string;
    url: string;
    durationMs: number;
    responseCode: string;
    success: boolean;
    properties?: Record<string, string>;
    context?: ScenarioContext;
  }): void {
    this.envelope('Request', 'RequestData', {
      id: `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`,
      name: input.name,
      url: input.url,
      duration: formatDuration(input.durationMs),
      responseCode: input.responseCode,
      success: input.success,
      properties: this.properties(input.properties, input.context),
    });
  }

  trackDependency(input: {
    name: string;
    type: string;
    target: string;
    data: string;
    durationMs: number;
    success: boolean;
    resultCode?: string;
    properties?: Record<string, string>;
    context?: ScenarioContext;
  }): void {
    this.envelope('RemoteDependency', 'RemoteDependencyData', {
      id: `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`,
      name: input.name,
      type: input.type,
      target: input.target,
      data: input.data,
      duration: formatDuration(input.durationMs),
      success: input.success,
      resultCode: input.resultCode ?? (input.success ? '200' : '500'),
      properties: this.properties(input.properties, input.context),
    });
  }

  trackException(error: unknown, properties?: Record<string, string>, context?: ScenarioContext): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.envelope('Exception', 'ExceptionData', {
      exceptions: [
        {
          id: 1,
          typeName: err.name,
          message: err.message.slice(0, 4000),
          hasFullStack: Boolean(err.stack),
          stack: (err.stack ?? '').slice(0, 8000),
          parsedStack: [],
        },
      ],
      severityLevel: 3,
      properties: this.properties(properties, context),
    });
  }

  async flush(): Promise<void> {
    if (!this.parsed || this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      const response = await fetch(`${this.parsed.ingestionEndpoint}/v2/track`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-json-stream' },
        body: batch.map((item) => JSON.stringify(item)).join('\n'),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok && response.status >= 500) {
        // Transient ingestion problem: keep the batch for the next attempt.
        this.queue.unshift(...batch.slice(0, 500));
      }
    } catch {
      this.queue.unshift(...batch.slice(0, 500));
    } finally {
      this.flushing = false;
    }
  }
}

export const telemetry = new Telemetry();

/** Metric names shared with the alert rules. Keep in step with alerts.bicep. */
export const METRICS = {
  diskPercentUsed: 'sre_demo_disk_percent_used',
  postgresActiveConnections: 'sre_demo_postgres_active_connections',
  postgresConnectionPercent: 'sre_demo_postgres_connection_percent',
  postgresConnectivity: 'sre_demo_postgres_connectivity',
  postgresLatencyMs: 'sre_demo_postgres_latency_ms',
  magic8ballTlsValid: 'sre_demo_magic8ball_tls_valid',
  magic8ballTlsDaysRemaining: 'sre_demo_magic8ball_tls_days_remaining',
  magic8ballHttpSuccess: 'sre_demo_magic8ball_http_success',
  magic8ballLatencyMs: 'sre_demo_magic8ball_latency_ms',
  scenarioActive: 'sre_demo_scenario_active',
  aksNodeCount: 'sre_demo_aks_node_count',
  aksPendingPods: 'sre_demo_aks_pending_pods',
} as const;
