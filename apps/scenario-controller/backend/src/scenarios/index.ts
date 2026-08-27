/**
 * Scenario registry and lab-wide operations.
 *
 * Registering a new scenario is the only change needed to add one: the API
 * routes, the dashboard and the lab reset all iterate this list.
 */

import { config } from '../config.js';
import { log, errorFields } from '../logger.js';
import type { BaseScenario } from './base.js';
import { DiskCapacityScenario } from './disk.js';
import { AksCapacityScenario } from './aks-capacity.js';
import { BadDeploymentScenario } from './bad-deployment.js';
import { PostgresConnectionScenario } from './postgres-connections.js';
import { NetworkNsgScenario } from './network-nsg.js';
import { CertificateExpirationScenario } from './certificate.js';

const registry: BaseScenario[] = [
  new DiskCapacityScenario(),
  new AksCapacityScenario(),
  new BadDeploymentScenario(),
  new PostgresConnectionScenario(),
  new NetworkNsgScenario(),
  new CertificateExpirationScenario(),
];

export function allScenarios(): BaseScenario[] {
  return registry;
}

export function getScenario(id: string): BaseScenario | undefined {
  const normalised = id.padStart(2, '0');
  return registry.find((scenario) => scenario.id === normalised);
}

const BUSY_STATES = new Set(['INJECTING', 'ACTIVE', 'DETECTED', 'MITIGATING']);

export function activeScenarios(): BaseScenario[] {
  return registry.filter((scenario) => BUSY_STATES.has(scenario.state));
}

/**
 * Default safety rule: one fault at a time. Overlapping faults make an
 * investigation ambiguous, and a demo that cannot be reasoned about is worse
 * than no demo. ALLOW_CONCURRENT_SCENARIOS lifts this deliberately.
 */
export function blockingScenario(candidateId: string): BaseScenario | undefined {
  if (config.scenarios.allowConcurrent) return undefined;
  return activeScenarios().find((scenario) => scenario.id !== candidateId.padStart(2, '0'));
}

export interface LabResetSummary {
  startedAt: string;
  completedAt: string;
  results: {
    scenarioId: string;
    name: string;
    cleared: boolean;
    detail?: Record<string, unknown>;
    error?: string;
  }[];
  allCleared: boolean;
}

/**
 * Clears every scenario. Deliberately does not stop at the first failure: a
 * reset that abandons the remaining cleanup because one step failed would leave
 * the lab in a worse state than it found it.
 */
export async function resetLab(): Promise<LabResetSummary> {
  const startedAt = new Date().toISOString();
  const results: LabResetSummary['results'] = [];

  for (const scenario of registry) {
    try {
      const detail = await scenario.forceClear();
      results.push({ scenarioId: scenario.id, name: scenario.name, cleared: true, detail });
    } catch (error) {
      log.error('lab reset step failed', { scenarioId: scenario.id, ...errorFields(error) });
      results.push({
        scenarioId: scenario.id,
        name: scenario.name,
        cleared: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    results,
    allCleared: results.every((result) => result.cleared),
  };
}

/** Restores safety timeouts for scenarios that were active before a restart. */
export function rearmTimeouts(): void {
  for (const scenario of registry) scenario.rearmIfActive();
}
