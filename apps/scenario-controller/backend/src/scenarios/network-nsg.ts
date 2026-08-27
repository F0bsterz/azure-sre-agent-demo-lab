/**
 * Scenario 05 — network / NSG misconfiguration.
 *
 * Adds a single deny rule, sre-demo-deny-postgres, to the database subnet's
 * NSG at a priority above the allow rules. It blocks TCP 5432 from the
 * application and AKS subnets and nothing else.
 *
 * What it deliberately does NOT do: block SSH, block all VNet traffic, touch
 * any other NSG, or interfere with the Scenario Controller's own management
 * path. The operator must always be able to reach the controller and reset the
 * lab while this fault is active.
 *
 * The investigation signature is distinctive: the VM is healthy, PostgreSQL is
 * healthy and listening, but TCP 5432 times out from the clients — which points
 * at the network layer rather than the database.
 */

import { config } from '../config.js';
import { createDenyRule, deleteDenyRule, getDenyRule } from '../azure.js';
import { getConnectionStats } from '../db.js';
import { tcpProbe } from '../probes.js';
import { telemetry, METRICS } from '../telemetry.js';
import { BaseScenario } from './base.js';
import type { ScenarioTelemetry, Severity, VerificationCheck, VerificationResult } from './types.js';

export class NetworkNsgScenario extends BaseScenario {
  readonly id = '05';
  readonly name = 'Network / NSG Failure';
  readonly description =
    'A network security group change blocks TCP 5432 into the database subnet. The database itself stays healthy, but every client loses connectivity to it.';
  readonly component = `Network — NSG ${config.network.databaseNsgName || 'database subnet'}`;
  readonly severity: Severity = 'critical';
  readonly investigationPrompt =
    'Investigate why the application cannot communicate with PostgreSQL. Check application health, database health, routing and NSG configuration.';
  readonly telemetryMetrics = [METRICS.postgresConnectivity, METRICS.postgresLatencyMs];

  protected async inject(): Promise<Record<string, unknown>> {
    await createDenyRule();
    return {
      ruleName: config.network.denyRuleName,
      nsg: config.network.databaseNsgName,
      blockedPort: 5432,
      blockedSources: [config.network.appSubnetPrefix, config.network.aksSubnetPrefix],
      note: 'SSH and all other flows remain permitted so the lab stays resettable.',
    };
  }

  protected async clear(): Promise<Record<string, unknown>> {
    await deleteDenyRule();
    return { ruleName: config.network.denyRuleName, removed: true };
  }

  async telemetry(): Promise<ScenarioTelemetry> {
    const [rule, tcp, stats] = await Promise.all([
      getDenyRule().catch(() => ({ present: false })),
      tcpProbe(config.postgres.host, config.postgres.port),
      getConnectionStats(),
    ]);

    telemetry.trackMetric(METRICS.postgresConnectivity, tcp.reachable ? 1 : 0, undefined, this.context());
    telemetry.trackMetric(METRICS.postgresLatencyMs, tcp.latencyMs, undefined, this.context());
    telemetry.trackDependency({
      name: 'postgres tcp probe',
      type: 'PostgreSQL',
      target: config.postgres.host,
      data: `tcp://${config.postgres.host}:${config.postgres.port}`,
      durationMs: tcp.latencyMs,
      success: tcp.reachable,
      resultCode: tcp.reachable ? '200' : '503',
      context: this.context(),
    });

    return {
      scenarioId: this.id,
      collectedAt: new Date().toISOString(),
      metrics: {
        denyRulePresent: rule.present,
        rulePriority: 'priority' in rule ? (rule.priority ?? null) : null,
        tcpReachable: tcp.reachable,
        tcpLatencyMs: tcp.latencyMs,
        databaseQuerySucceeded: stats.reachable,
        tcpError: tcp.error ?? null,
      },
      observations: [
        rule.present
          ? `NSG rule "${config.network.denyRuleName}" is present on ${config.network.databaseNsgName}, denying TCP 5432.`
          : `NSG rule "${config.network.denyRuleName}" is not present.`,
        tcp.reachable
          ? `TCP 5432 connected in ${tcp.latencyMs}ms.`
          : `TCP 5432 failed: ${tcp.error ?? 'no route'} — consistent with a packet filter, not a refused connection.`,
        'The PostgreSQL VM and service remain healthy; only the network path is affected.',
        'Compare against scenario 04, where TCP connects successfully but the server refuses new sessions.',
      ],
    };
  }

  async verify(): Promise<VerificationResult> {
    const [rule, tcp] = await Promise.all([
      getDenyRule().catch(() => ({ present: false })),
      tcpProbe(config.postgres.host, config.postgres.port, 6000),
    ]);
    const shouldBeFaulted = this.state !== 'IDLE' && this.state !== 'RESETTING';

    const checks: VerificationCheck[] = [
      {
        name: shouldBeFaulted ? 'Deny rule present' : 'Deny rule removed',
        passed: shouldBeFaulted ? rule.present : !rule.present,
        detail: `${config.network.denyRuleName} ${rule.present ? 'exists' : 'does not exist'} on ${config.network.databaseNsgName}.`,
      },
      {
        name: shouldBeFaulted ? 'PostgreSQL unreachable on TCP 5432' : 'PostgreSQL reachable on TCP 5432',
        passed: shouldBeFaulted ? !tcp.reachable : tcp.reachable,
        detail: tcp.reachable ? `Connected in ${tcp.latencyMs}ms.` : (tcp.error ?? 'unreachable'),
      },
      {
        name: 'Controller management path unaffected',
        passed: true,
        detail: 'The injected rule scopes to TCP 5432 only; SSH and controller traffic are never blocked.',
      },
    ];

    return {
      scenarioId: this.id,
      passed: checks.every((check) => check.passed),
      faultPresent: rule.present && !tcp.reachable,
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }
}
