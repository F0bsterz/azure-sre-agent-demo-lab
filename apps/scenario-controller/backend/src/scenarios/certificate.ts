/**
 * Scenario 06 — TLS certificate expiration.
 *
 * A small internal demo CA issues two server certificates for the same Magic 8
 * Ball endpoint: one valid, one already expired. Activating the scenario swaps
 * the Kubernetes TLS secret to the expired pair and reloads the workload.
 *
 * The synthetic checker trusts the demo CA on purpose. Without that, every
 * failure would read as "unknown issuer" and the exercise would be about trust
 * stores. With it, the only thing wrong is the validity window, so the
 * investigation lands squarely on certificate expiry — while the pods stay
 * Ready and the application stays healthy on plain HTTP, which is precisely the
 * confusing signal this scenario is meant to teach.
 */

import { config } from '../config.js';
import { httpProbe, tlsProbe } from '../probes.js';
import { runnerStatus, setCertificateVariant } from '../runner.js';
import { telemetry, METRICS } from '../telemetry.js';
import { BaseScenario } from './base.js';
import type { ScenarioTelemetry, Severity, VerificationCheck, VerificationResult } from './types.js';

export class CertificateExpirationScenario extends BaseScenario {
  readonly id = '06';
  readonly name = 'Certificate Expiration';
  readonly description =
    'The Magic 8 Ball TLS certificate is replaced with an expired one. Pods stay Ready and the application is fine over HTTP, but every HTTPS client now fails validation.';
  readonly component = 'AKS — magic8ball TLS secret';
  readonly severity: Severity = 'high';
  readonly investigationPrompt =
    'Investigate why HTTPS health checks for Magic 8 Ball are failing even though the AKS pods appear healthy.';
  readonly telemetryMetrics = [METRICS.magic8ballTlsValid, METRICS.magic8ballTlsDaysRemaining];

  protected async inject(): Promise<Record<string, unknown>> {
    const result = await setCertificateVariant('expired');
    return { variant: 'expired', ...result };
  }

  protected async clear(): Promise<Record<string, unknown>> {
    const result = await setCertificateVariant('valid');
    return { variant: 'valid', ...result };
  }

  async telemetry(): Promise<ScenarioTelemetry> {
    const [tls, http, status] = await Promise.all([
      tlsProbe(config.magic8ball.httpsUrl),
      httpProbe(`${config.magic8ball.httpUrl}/healthz`),
      runnerStatus(),
    ]);

    telemetry.trackMetric(METRICS.magic8ballTlsValid, tls.valid ? 1 : 0, undefined, this.context());
    if (typeof tls.daysRemaining === 'number') {
      telemetry.trackMetric(METRICS.magic8ballTlsDaysRemaining, tls.daysRemaining, undefined, this.context());
    }

    return {
      scenarioId: this.id,
      collectedAt: new Date().toISOString(),
      metrics: {
        tlsValid: tls.valid,
        tlsExpired: tls.expired,
        daysRemaining: tls.daysRemaining ?? null,
        notAfter: tls.notAfter ?? null,
        notBefore: tls.notBefore ?? null,
        subject: tls.subject ?? null,
        issuer: tls.issuer ?? null,
        certificateVariant: status.certificate.variant ?? 'unknown',
        httpHealthy: http.ok,
        podsReady: status.magic8ball.readyReplicas,
        failureReason: tls.reason ?? null,
      },
      observations: [
        tls.valid
          ? `Certificate is valid until ${tls.notAfter} (${tls.daysRemaining} days remaining).`
          : `TLS validation failed: ${tls.reason ?? 'unknown reason'}.`,
        `Certificate subject ${tls.subject ?? 'unknown'} issued by ${tls.issuer ?? 'unknown'} — the demo CA is trusted by the checker, so issuer is not the problem.`,
        `Plain HTTP health check returned ${http.statusCode ?? 'no response'}, and ${status.magic8ball.readyReplicas} pod(s) are Ready: the application itself is healthy.`,
        'Signature to look for: healthy pods and healthy application, failing HTTPS handshake, certificate notAfter in the past.',
      ],
    };
  }

  async verify(): Promise<VerificationResult> {
    const [tls, http, status] = await Promise.all([
      tlsProbe(config.magic8ball.httpsUrl),
      httpProbe(`${config.magic8ball.httpUrl}/healthz`),
      runnerStatus(),
    ]);
    const shouldBeFaulted = this.state !== 'IDLE' && this.state !== 'RESETTING';

    const checks: VerificationCheck[] = [
      {
        name: shouldBeFaulted ? 'Expired certificate installed' : 'Valid certificate installed',
        passed: shouldBeFaulted ? tls.expired : tls.valid,
        detail: `Certificate notAfter=${tls.notAfter ?? 'unknown'}; ${tls.reason ?? 'validation succeeded'}.`,
      },
      {
        name: shouldBeFaulted ? 'HTTPS validation failing' : 'HTTPS handshake succeeds',
        passed: shouldBeFaulted ? !tls.valid : tls.valid,
        detail: tls.valid ? 'TLS handshake completed and chain validated against the demo CA.' : (tls.reason ?? 'failed'),
      },
      {
        name: 'Application remains healthy over HTTP',
        passed: http.ok,
        detail: `HTTP health check returned ${http.statusCode ?? 'no response'} in ${http.latencyMs}ms.`,
      },
      {
        name: 'Pods remain Ready',
        passed: status.magic8ball.readyReplicas >= 1,
        detail: `${status.magic8ball.readyReplicas}/${status.magic8ball.desiredReplicas} replicas Ready.`,
      },
    ];

    return {
      scenarioId: this.id,
      passed: checks.every((check) => check.passed),
      faultPresent: tls.expired && !tls.valid,
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }
}
