/**
 * Scenario 02 — AKS resource exhaustion.
 *
 * The cluster starts with one node and the cluster autoscaler is disabled, so
 * the pressure workload genuinely cannot be absorbed: pods go Pending, node CPU
 * and memory climb, and Magic 8 Ball degrades. The expected remediation is an
 * explicit node-pool scale from 1 to 2.
 *
 * Bounded by construction: the burner deployment carries CPU/memory requests
 * and limits, replica count is capped, and a ResourceQuota plus LimitRange on
 * the namespace mean it cannot escape its budget however many replicas are
 * requested.
 */

import { config } from '../config.js';
import { getNodePool, scaleNodePool, azureConfigured } from '../azure.js';
import { applyResourcePressure, removeResourcePressure, runnerStatus } from '../runner.js';
import { telemetry, METRICS } from '../telemetry.js';
import { BaseScenario } from './base.js';
import type { ScenarioTelemetry, Severity, VerificationCheck, VerificationResult } from './types.js';

const PRESSURE_REPLICAS = Number.parseInt(process.env['PRESSURE_REPLICAS'] ?? '6', 10);

export class AksCapacityScenario extends BaseScenario {
  readonly id = '02';
  readonly name = 'AKS Resource Exhaustion';
  readonly description =
    'A resource-hungry workload is deployed into the sre-demo namespace. The single-node cluster cannot satisfy the requests, pods stay Pending and Magic 8 Ball slows down.';
  readonly component = 'AKS — sre-demo namespace';
  readonly severity: Severity = 'high';
  readonly investigationPrompt =
    'Investigate why Magic 8 Ball is degraded and whether the AKS cluster has sufficient compute capacity.';
  readonly telemetryMetrics = [METRICS.aksPendingPods, METRICS.aksNodeCount, METRICS.magic8ballLatencyMs];

  protected async inject(): Promise<Record<string, unknown>> {
    const result = await applyResourcePressure(PRESSURE_REPLICAS);
    return { replicas: PRESSURE_REPLICAS, ...result };
  }

  protected async clear(): Promise<Record<string, unknown>> {
    const detail: Record<string, unknown> = {};
    try {
      detail['pressureRemoved'] = await removeResourcePressure();
    } catch (error) {
      detail['pressureRemoveError'] = error instanceof Error ? error.message : String(error);
    }

    // Return the node pool to the baseline, never below it.
    if (azureConfigured() && config.aks.clusterName) {
      try {
        const pool = await getNodePool();
        if (pool.count > config.aks.baselineNodeCount) {
          const scaled = await scaleNodePool(config.aks.baselineNodeCount);
          detail['nodePoolScaledTo'] = scaled.count;
        } else {
          detail['nodePoolAlreadyAtBaseline'] = pool.count;
        }
      } catch (error) {
        detail['nodePoolError'] = error instanceof Error ? error.message : String(error);
      }
    }
    return detail;
  }

  async telemetry(): Promise<ScenarioTelemetry> {
    const [status, pool] = await Promise.all([
      runnerStatus(),
      azureConfigured() && config.aks.clusterName
        ? getNodePool().catch(() => undefined)
        : Promise.resolve(undefined),
    ]);

    const capacity = status.nodeCapacity;
    const cpuPercent =
      capacity && capacity.allocatableCpuMilli > 0
        ? Math.round((capacity.requestedCpuMilli / capacity.allocatableCpuMilli) * 1000) / 10
        : null;
    const memPercent =
      capacity && capacity.allocatableMemoryMi > 0
        ? Math.round((capacity.requestedMemoryMi / capacity.allocatableMemoryMi) * 1000) / 10
        : null;

    telemetry.trackMetric(METRICS.aksPendingPods, status.pendingPods, undefined, this.context());
    if (pool) telemetry.trackMetric(METRICS.aksNodeCount, pool.count, undefined, this.context());

    return {
      scenarioId: this.id,
      collectedAt: new Date().toISOString(),
      metrics: {
        nodeCount: pool?.count ?? status.nodeCount,
        nodeVmSize: pool?.vmSize ?? null,
        pendingPods: status.pendingPods,
        pressureReplicasDesired: status.resourcePressure.desiredReplicas,
        pressureReplicasReady: status.resourcePressure.readyReplicas,
        magic8ballReady: status.magic8ball.readyReplicas,
        magic8ballDesired: status.magic8ball.desiredReplicas,
        requestedCpuPercent: cpuPercent,
        requestedMemoryPercent: memPercent,
        runnerReachable: status.reachable,
      },
      observations: [
        `Node pool "${config.aks.nodePool}" has ${pool?.count ?? status.nodeCount} node(s); baseline is ${config.aks.baselineNodeCount}.`,
        `${status.pendingPods} pod(s) are Pending in namespace ${config.aks.namespace}.`,
        capacity
          ? `Requested CPU ${capacity.requestedCpuMilli}m of ${capacity.allocatableCpuMilli}m allocatable; memory ${capacity.requestedMemoryMi}Mi of ${capacity.allocatableMemoryMi}Mi.`
          : 'Node capacity data unavailable from scenario-runner.',
        'Cluster autoscaler is disabled by design, so scheduling pressure requires an explicit node-pool scale.',
      ],
    };
  }

  async verify(): Promise<VerificationResult> {
    const status = await runnerStatus();
    const pool = azureConfigured() && config.aks.clusterName ? await getNodePool().catch(() => undefined) : undefined;
    const shouldBeFaulted = this.state !== 'IDLE' && this.state !== 'RESETTING';

    const checks: VerificationCheck[] = [
      {
        name: 'scenario-runner reachable',
        passed: status.reachable,
        detail: status.reachable ? 'Runner responded over the internal endpoint.' : (status.error ?? 'unreachable'),
      },
      {
        name: shouldBeFaulted ? 'Resource pressure workload present' : 'Resource pressure workload removed',
        passed: shouldBeFaulted ? status.resourcePressure.present : !status.resourcePressure.present,
        detail: `resource-burner desired=${status.resourcePressure.desiredReplicas} ready=${status.resourcePressure.readyReplicas}.`,
      },
      {
        name: shouldBeFaulted ? 'Cluster shows scheduling pressure' : 'No pods pending',
        passed: shouldBeFaulted ? status.pendingPods > 0 : status.pendingPods === 0,
        detail: `${status.pendingPods} pending pod(s).`,
      },
      {
        name: 'Node pool at or above baseline',
        passed: (pool?.count ?? config.aks.baselineNodeCount) >= config.aks.baselineNodeCount,
        detail: `Node count ${pool?.count ?? 'unknown'}, baseline ${config.aks.baselineNodeCount}.`,
      },
    ];

    if (!shouldBeFaulted) {
      checks.push({
        name: 'Magic 8 Ball replicas ready',
        passed: status.magic8ball.readyReplicas >= 1,
        detail: `${status.magic8ball.readyReplicas}/${status.magic8ball.desiredReplicas} ready.`,
      });
    }

    return {
      scenarioId: this.id,
      passed: checks.every((check) => check.passed),
      faultPresent: status.resourcePressure.present && status.pendingPods > 0,
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }

  /** Exposed so the runbook's expected remediation can be demonstrated from the UI. */
  async scaleTo(nodeCount: number): Promise<{ count: number }> {
    const pool = await scaleNodePool(nodeCount);
    await this.transition('MITIGATING', `AKS node pool scale to ${pool.count} requested.`, { nodeCount: pool.count });
    return { count: pool.count };
  }
}
