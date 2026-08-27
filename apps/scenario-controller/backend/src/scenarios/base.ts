/**
 * Shared scenario machinery: persisted state, transitions, safety timeout.
 *
 * State is written to the demo disk so an operator who restarts the controller
 * mid-incident does not lose track of an active fault, and is mirrored in
 * memory so a full disk (scenario 01) cannot wedge the control plane.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { log, errorFields } from '../logger.js';
import { recordEvent } from '../db.js';
import { telemetry, METRICS, type ScenarioContext } from '../telemetry.js';
import type {
  ScenarioResult,
  ScenarioState,
  ScenarioStatus,
  ScenarioTelemetry,
  Severity,
  SreScenario,
  VerificationResult,
} from './types.js';

interface PersistedScenario {
  state: ScenarioState;
  activatedAt?: string;
  correlationId?: string;
  lastError?: string;
  lastAction?: string;
  lastActionAt?: string;
}

type StateFile = Record<string, PersistedScenario>;

const STATE_FILE = () => join(config.disk.stateDir, 'scenarios.json');

let memoryState: StateFile = {};
let loaded = false;

function loadState(): StateFile {
  if (loaded) return memoryState;
  loaded = true;
  try {
    const file = STATE_FILE();
    if (existsSync(file)) {
      memoryState = JSON.parse(readFileSync(file, 'utf8')) as StateFile;
    }
  } catch (error) {
    log.warn('could not read scenario state file, starting from IDLE', errorFields(error));
    memoryState = {};
  }
  return memoryState;
}

function saveState(): void {
  try {
    mkdirSync(config.disk.stateDir, { recursive: true });
    writeFileSync(STATE_FILE(), JSON.stringify(memoryState, null, 2), 'utf8');
  } catch {
    // Expected while the demo disk is intentionally near capacity. Memory wins.
  }
}

export function allScenarioStates(): StateFile {
  return { ...loadState() };
}

export abstract class BaseScenario implements SreScenario {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly component: string;
  abstract readonly severity: Severity;
  abstract readonly investigationPrompt: string;
  abstract readonly telemetryMetrics: string[];

  /** Injects the fault. Implementations must be idempotent. */
  protected abstract inject(): Promise<Record<string, unknown>>;
  /** Removes the fault. Implementations must be safe to run repeatedly. */
  protected abstract clear(): Promise<Record<string, unknown>>;

  abstract telemetry(): Promise<ScenarioTelemetry>;
  abstract verify(): Promise<VerificationResult>;

  private timeoutHandle: NodeJS.Timeout | undefined;

  protected get persisted(): PersistedScenario {
    const state = loadState();
    const existing = state[this.id];
    if (existing) return existing;
    const created: PersistedScenario = { state: 'IDLE' };
    state[this.id] = created;
    return created;
  }

  get state(): ScenarioState {
    return this.persisted.state;
  }

  get activatedAt(): string | undefined {
    return this.persisted.activatedAt;
  }

  get correlationId(): string | undefined {
    return this.persisted.correlationId;
  }

  protected context(): ScenarioContext {
    return {
      scenarioId: this.id,
      scenarioName: this.name,
      scenarioState: this.state,
      scenarioStartedAt: this.activatedAt,
      scenarioComponent: this.component,
      correlationId: this.correlationId,
    };
  }

  protected async transition(next: ScenarioState, message: string, detail?: Record<string, unknown>): Promise<void> {
    const record = this.persisted;
    record.state = next;
    if (next === 'ACTIVE' && !record.activatedAt) record.activatedAt = new Date().toISOString();
    if (next === 'IDLE') {
      record.activatedAt = undefined;
      record.correlationId = undefined;
      record.lastError = undefined;
    }
    record.lastAction = message;
    record.lastActionAt = new Date().toISOString();
    saveState();

    const context = this.context();
    log.info(message, { state: next, ...(detail ?? {}) }, context);
    telemetry.trackEvent(
      'sre_demo_scenario_transition',
      {
        'scenario.transitionTo': next,
        'scenario.message': message,
        ...Object.fromEntries(Object.entries(detail ?? {}).map(([k, v]) => [k, String(v)])),
      },
      context,
    );
    telemetry.trackMetric(
      METRICS.scenarioActive,
      next === 'ACTIVE' || next === 'DETECTED' || next === 'MITIGATING' ? 1 : 0,
      { 'scenario.id': this.id },
      context,
    );

    await recordEvent({
      occurredAt: new Date().toISOString(),
      scenarioId: this.id,
      scenarioName: this.name,
      state: next,
      component: this.component,
      severity: this.severity,
      correlationId: this.correlationId,
      message,
      detail,
    });
  }

  /**
   * Automatic safety net. An unattended fault self-resets so a lab left running
   * after a demo does not sit broken (or, for scenario 01, keep consuming disk).
   * One hour by default: long enough for an unhurried investigation, short
   * enough that a forgotten scenario does not persist.
   */
  private armTimeout(): void {
    this.clearTimeout();
    const minutes = config.scenarios.timeoutMinutes;
    if (minutes <= 0) return;
    this.timeoutHandle = setTimeout(() => {
      log.warn('scenario safety timeout reached, resetting automatically', { minutes }, this.context());
      void this.reset().catch((error) => log.error('automatic reset failed', errorFields(error)));
    }, minutes * 60_000);
    this.timeoutHandle.unref();
  }

  private clearTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
  }

  get expiresAt(): string | undefined {
    const activatedAt = this.activatedAt;
    if (!activatedAt || config.scenarios.timeoutMinutes <= 0) return undefined;
    return new Date(Date.parse(activatedAt) + config.scenarios.timeoutMinutes * 60_000).toISOString();
  }

  async activate(): Promise<ScenarioResult> {
    if (this.state === 'ACTIVE' || this.state === 'DETECTED' || this.state === 'MITIGATING') {
      return {
        scenarioId: this.id,
        state: this.state,
        message: 'Scenario is already active.',
        changed: false,
      };
    }

    this.persisted.correlationId = randomUUID();
    await this.transition('INJECTING', `Activating scenario ${this.id}: ${this.name}.`);
    try {
      const detail = await this.inject();
      await this.transition('ACTIVE', `Scenario ${this.id} is active. Fault injected into ${this.component}.`, detail);
      this.armTimeout();
      return { scenarioId: this.id, state: this.state, message: 'Fault injected.', changed: true, detail };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.persisted.lastError = err.message;
      telemetry.trackException(err, { 'scenario.phase': 'activate' }, this.context());
      await this.transition('IDLE', `Activation of scenario ${this.id} failed: ${err.message}`);
      throw err;
    }
  }

  async reset(): Promise<ScenarioResult> {
    if (this.state === 'IDLE') {
      // Still run the clear path: reset must be safe and effective to repeat,
      // including after a controller restart that lost track of the fault.
      const detail = await this.clear().catch(() => ({}));
      return {
        scenarioId: this.id,
        state: 'IDLE',
        message: 'Scenario already idle; cleanup re-verified.',
        changed: false,
        detail,
      };
    }

    await this.transition('RESETTING', `Resetting scenario ${this.id}.`);
    try {
      const detail = await this.clear();
      this.clearTimeout();
      await this.transition('IDLE', `Scenario ${this.id} reset. ${this.component} restored to baseline.`, detail);
      return { scenarioId: this.id, state: 'IDLE', message: 'Scenario reset.', changed: true, detail };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.persisted.lastError = err.message;
      telemetry.trackException(err, { 'scenario.phase': 'reset' }, this.context());
      await this.transition('ACTIVE', `Reset of scenario ${this.id} failed: ${err.message}`);
      throw err;
    }
  }

  /** Used by the lab-wide reset, which must not abort on the first failure. */
  async forceClear(): Promise<Record<string, unknown>> {
    const detail = await this.clear();
    this.clearTimeout();
    if (this.state !== 'IDLE') {
      await this.transition('IDLE', `Scenario ${this.id} cleared by lab reset.`, detail);
    }
    return detail;
  }

  async markDetected(note: string): Promise<void> {
    if (this.state === 'ACTIVE') await this.transition('DETECTED', note);
  }

  async status(): Promise<ScenarioStatus> {
    const record = this.persisted;
    const activatedAt = record.activatedAt;
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      component: this.component,
      severity: this.severity,
      state: record.state,
      activatedAt,
      elapsedSeconds: activatedAt ? Math.floor((Date.now() - Date.parse(activatedAt)) / 1000) : undefined,
      expiresAt: this.expiresAt,
      correlationId: record.correlationId,
      telemetryHealthy: telemetry.enabled,
      lastError: record.lastError,
      lastAction: record.lastAction,
      lastActionAt: record.lastActionAt,
    };
  }

  /** Restores the timeout guard for a scenario that was active before a restart. */
  rearmIfActive(): void {
    if (this.state === 'ACTIVE' || this.state === 'DETECTED' || this.state === 'MITIGATING') {
      this.armTimeout();
    }
  }
}
