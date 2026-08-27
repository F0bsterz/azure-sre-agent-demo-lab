/**
 * Scenario 03 — bad application deployment.
 *
 * The same Magic 8 Ball image is built twice with different build metadata and
 * a fault flag. Activating the scenario rolls the Deployment onto the "bad"
 * variant, which returns HTTP 500 for a deterministic share of requests and
 * adds several seconds of latency to others.
 *
 * The image tag, application version, build timestamp and git commit SHA are
 * exposed on /api/version and attached to every telemetry item, so the
 * investigation can correlate an error-rate spike with a specific deployment
 * and a specific commit rather than stopping at "the app is failing".
 */

import { config } from '../config.js';
import { httpProbe } from '../probes.js';
import { runnerStatus, setMagic8BallVariant } from '../runner.js';
import { telemetry, METRICS } from '../telemetry.js';
import { BaseScenario } from './base.js';
import type { ScenarioTelemetry, Severity, VerificationCheck, VerificationResult } from './types.js';

interface VersionInfo {
  version?: string;
  imageTag?: string;
  gitCommit?: string;
  buildTimestamp?: string;
  variant?: string;
}

async function readVersion(): Promise<VersionInfo | undefined> {
  const probe = await httpProbe(`${config.magic8ball.httpUrl}/api/version`);
  if (!probe.ok || !probe.body) return undefined;
  try {
    return JSON.parse(probe.body) as VersionInfo;
  } catch {
    return undefined;
  }
}

/** Samples the live endpoint so verification reflects behaviour, not just the manifest. */
async function sampleErrorRate(samples = 12): Promise<{ total: number; failed: number; avgLatencyMs: number }> {
  const url = `${config.magic8ball.httpUrl}/api/answer`;
  let failed = 0;
  let totalLatency = 0;
  let total = 0;
  for (let index = 0; index < samples; index += 1) {
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: `synthetic probe ${index}` }),
        signal: AbortSignal.timeout(12_000),
      });
      await response.text().catch(() => '');
      if (!response.ok) failed += 1;
    } catch {
      failed += 1;
    }
    totalLatency += Date.now() - started;
    total += 1;
  }
  return { total, failed, avgLatencyMs: total > 0 ? Math.round(totalLatency / total) : 0 };
}

export class BadDeploymentScenario extends BaseScenario {
  readonly id = '03';
  readonly name = 'Bad Application Deployment';
  readonly description =
    'A regressed build of Magic 8 Ball is rolled out. It returns server errors for a large share of requests and adds multi-second latency to the rest.';
  readonly component = 'AKS — magic8ball Deployment';
  readonly severity: Severity = 'critical';
  readonly investigationPrompt =
    'Investigate the increase in HTTP 500 errors for Magic 8 Ball. Determine whether the incident correlates with a deployment or source-code change and propose a mitigation.';
  readonly telemetryMetrics = [METRICS.magic8ballHttpSuccess, METRICS.magic8ballLatencyMs];

  protected async inject(): Promise<Record<string, unknown>> {
    const before = await readVersion();
    const result = await setMagic8BallVariant('bad');
    return { previousVersion: before ?? null, ...result };
  }

  protected async clear(): Promise<Record<string, unknown>> {
    const result = await setMagic8BallVariant('stable');
    return { rolledBackTo: 'stable', ...result };
  }

  async telemetry(): Promise<ScenarioTelemetry> {
    const [status, version, health] = await Promise.all([
      runnerStatus(),
      readVersion(),
      httpProbe(`${config.magic8ball.httpUrl}/healthz`),
    ]);

    telemetry.trackMetric(METRICS.magic8ballHttpSuccess, health.ok ? 1 : 0, undefined, this.context());
    telemetry.trackMetric(METRICS.magic8ballLatencyMs, health.latencyMs, undefined, this.context());

    return {
      scenarioId: this.id,
      collectedAt: new Date().toISOString(),
      metrics: {
        deployedVariant: status.magic8ball.variant ?? version?.variant ?? 'unknown',
        deployedImage: status.magic8ball.image ?? null,
        appVersion: version?.version ?? null,
        gitCommit: version?.gitCommit ?? null,
        buildTimestamp: version?.buildTimestamp ?? null,
        readyReplicas: status.magic8ball.readyReplicas,
        desiredReplicas: status.magic8ball.desiredReplicas,
        healthEndpointOk: health.ok,
        healthLatencyMs: health.latencyMs,
      },
      observations: [
        `Deployed image: ${status.magic8ball.image ?? 'unknown'} (variant ${status.magic8ball.variant ?? 'unknown'}).`,
        version?.gitCommit
          ? `Build metadata reports version ${version.version} from commit ${version.gitCommit} built at ${version.buildTimestamp}.`
          : 'Build metadata unavailable from /api/version.',
        `Health endpoint returned ${health.statusCode ?? 'no response'} in ${health.latencyMs}ms.`,
        'Compare AppRequests failure rate before and after the deployment timestamp to confirm correlation.',
      ],
    };
  }

  async verify(): Promise<VerificationResult> {
    const [status, sample, version] = await Promise.all([runnerStatus(), sampleErrorRate(), readVersion()]);
    const failurePercent = sample.total > 0 ? Math.round((sample.failed / sample.total) * 1000) / 10 : 0;
    const shouldBeFaulted = this.state !== 'IDLE' && this.state !== 'RESETTING';

    const checks: VerificationCheck[] = [
      {
        name: shouldBeFaulted ? 'Bad variant deployed' : 'Stable variant deployed',
        passed: shouldBeFaulted ? status.magic8ball.variant === 'bad' : status.magic8ball.variant === 'stable',
        detail: `Deployment reports variant "${status.magic8ball.variant ?? 'unknown'}" (${status.magic8ball.image ?? 'no image'}).`,
      },
      {
        name: shouldBeFaulted ? 'Elevated HTTP failure rate observed' : 'HTTP failure rate normal',
        passed: shouldBeFaulted ? failurePercent >= 20 : failurePercent < 10,
        detail: `${sample.failed}/${sample.total} sampled requests failed (${failurePercent}%).`,
      },
      {
        name: 'Build metadata exposed for correlation',
        passed: Boolean(version?.gitCommit && version.imageTag),
        detail: version
          ? `version=${version.version} commit=${version.gitCommit} tag=${version.imageTag}`
          : '/api/version did not return build metadata.',
      },
      {
        name: 'Deployment is not permanently broken',
        passed: status.magic8ball.desiredReplicas > 0,
        detail: `${status.magic8ball.readyReplicas}/${status.magic8ball.desiredReplicas} replicas ready; rollback restores service.`,
      },
    ];

    if (!shouldBeFaulted) {
      checks.push({
        name: 'Latency back to normal',
        passed: sample.avgLatencyMs < 2000,
        detail: `Average sampled latency ${sample.avgLatencyMs}ms.`,
      });
    }

    return {
      scenarioId: this.id,
      passed: checks.every((check) => check.passed),
      faultPresent: status.magic8ball.variant === 'bad' && failurePercent >= 20,
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }
}
