/**
 * Scenario contract.
 *
 * Adding a seventh scenario means implementing this interface and registering
 * it — the controller, the API surface and the React dashboard all work off
 * this shape, so nothing else has to change.
 */

export const SCENARIO_STATES = [
  'IDLE',
  'INJECTING',
  'ACTIVE',
  'DETECTED',
  'MITIGATING',
  'RECOVERED',
  'RESETTING',
] as const;

export type ScenarioState = (typeof SCENARIO_STATES)[number];

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface ScenarioResult {
  scenarioId: string;
  state: ScenarioState;
  message: string;
  /** False when the call was a no-op because the scenario was already in that state. */
  changed: boolean;
  detail?: Record<string, unknown>;
}

export interface ScenarioStatus {
  id: string;
  name: string;
  description: string;
  component: string;
  severity: Severity;
  state: ScenarioState;
  activatedAt?: string;
  elapsedSeconds?: number;
  expiresAt?: string;
  correlationId?: string;
  telemetryHealthy: boolean;
  lastError?: string;
  lastAction?: string;
  lastActionAt?: string;
}

export interface ScenarioTelemetry {
  scenarioId: string;
  collectedAt: string;
  /** Headline numbers rendered on the scenario card. */
  metrics: Record<string, number | string | boolean | null>;
  /** Free-form evidence an operator or SRE Agent would look at. */
  observations: string[];
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  scenarioId: string;
  /** True when the environment matches the state the scenario claims to be in. */
  passed: boolean;
  faultPresent: boolean;
  checks: VerificationCheck[];
  verifiedAt: string;
}

export interface SreScenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly component: string;
  readonly severity: Severity;
  /** Prompt suggested to Azure SRE Agent for this incident. */
  readonly investigationPrompt: string;
  /** Metric names in AppMetrics that carry this scenario's signal. */
  readonly telemetryMetrics: string[];

  activate(): Promise<ScenarioResult>;
  status(): Promise<ScenarioStatus>;
  telemetry(): Promise<ScenarioTelemetry>;
  verify(): Promise<VerificationResult>;
  reset(): Promise<ScenarioResult>;
}
