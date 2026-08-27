/**
 * Application Insights telemetry for Magic 8 Ball.
 *
 * Emits envelopes directly to the ingestion endpoint. AppRoleName is set to
 * "magic8ball", which is exactly what the scenario 03 alert rule filters on,
 * and every item carries the deployed version, image tag and git commit so an
 * error-rate spike can be correlated with a specific rollout.
 */

import { hostname } from 'node:os';

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
  return {
    instrumentationKey,
    ingestionEndpoint: (parts.get('ingestionendpoint') ?? 'https://dc.services.visualstudio.com/').replace(
      /\/+$/,
      '',
    ),
  };
}

function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${Math.floor(safe / 86_400_000)}.${pad(Math.floor((safe % 86_400_000) / 3_600_000))}:${pad(
    Math.floor((safe % 3_600_000) / 60_000),
  )}:${pad(Math.floor((safe % 60_000) / 1000))}.${pad(safe % 1000, 3)}0000`;
}

class Telemetry {
  private parsed: Parsed | undefined;
  private queue: Record<string, unknown>[] = [];
  private readonly roleInstance = hostname();
  private roleName = 'magic8ball';
  private baseProperties: Record<string, string> = {};
  private flushing = false;

  configure(connectionString: string, roleName: string, baseProperties: Record<string, string>): void {
    this.parsed = parseConnectionString(connectionString);
    this.roleName = roleName;
    this.baseProperties = baseProperties;
    if (this.parsed) {
      const timer = setInterval(() => void this.flush(), 5000);
      timer.unref();
    }
  }

  get enabled(): boolean {
    return this.parsed !== undefined;
  }

  private push(name: string, baseType: string, baseData: Record<string, unknown>): void {
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
    if (this.queue.length > 1000) this.queue = this.queue.slice(-1000);
    if (this.queue.length >= 50) void this.flush();
  }

  private props(extra?: Record<string, string>): Record<string, string> {
    return { ...this.baseProperties, ...(extra ?? {}) };
  }

  trackMetric(name: string, value: number, properties?: Record<string, string>): void {
    this.push('Metric', 'MetricData', {
      metrics: [{ name, value, count: 1, kind: 0 }],
      properties: this.props(properties),
    });
  }

  trackEvent(name: string, properties?: Record<string, string>): void {
    this.push('Event', 'EventData', { name, properties: this.props(properties) });
  }

  trackRequest(input: {
    name: string;
    url: string;
    durationMs: number;
    responseCode: string;
    success: boolean;
    properties?: Record<string, string>;
  }): void {
    this.push('Request', 'RequestData', {
      id: `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`,
      name: input.name,
      url: input.url,
      duration: formatDuration(input.durationMs),
      responseCode: input.responseCode,
      success: input.success,
      properties: this.props(input.properties),
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
  }): void {
    this.push('RemoteDependency', 'RemoteDependencyData', {
      id: `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`,
      name: input.name,
      type: input.type,
      target: input.target,
      data: input.data,
      duration: formatDuration(input.durationMs),
      success: input.success,
      resultCode: input.resultCode ?? (input.success ? '200' : '500'),
      properties: this.props(input.properties),
    });
  }

  trackException(error: unknown, properties?: Record<string, string>): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.push('Exception', 'ExceptionData', {
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
      properties: this.props(properties),
    });
  }

  async flush(): Promise<void> {
    if (!this.parsed || this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await fetch(`${this.parsed.ingestionEndpoint}/v2/track`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-json-stream' },
        body: batch.map((item) => JSON.stringify(item)).join('\n'),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      this.queue.unshift(...batch.slice(0, 400));
    } finally {
      this.flushing = false;
    }
  }
}

export const telemetry = new Telemetry();
