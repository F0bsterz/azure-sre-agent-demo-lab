/** Shapes returned by the Scenario Controller API. */

export type HealthState = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

export type ScenarioState =
  | 'IDLE'
  | 'INJECTING'
  | 'ACTIVE'
  | 'DETECTED'
  | 'MITIGATING'
  | 'RECOVERED'
  | 'RESETTING';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

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
  investigationPrompt: string;
  telemetryMetrics: string[];
}

export interface ScenarioListResponse {
  scenarios: ScenarioStatus[];
  policy: { oneAtATime: boolean; timeoutMinutes: number };
}

export interface ScenarioTelemetry {
  scenarioId: string;
  collectedAt: string;
  metrics: Record<string, number | string | boolean | null>;
  observations: string[];
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  scenarioId: string;
  passed: boolean;
  faultPresent: boolean;
  checks: VerificationCheck[];
  verifiedAt: string;
}

export interface TimelineEntry {
  occurredAt: string;
  scenarioId: string;
  scenarioName?: string;
  state: string;
  component?: string;
  severity?: string;
  correlationId?: string;
  message: string;
  detail?: Record<string, unknown>;
  source: 'database' | 'buffer';
}

export interface LabResetSummary {
  startedAt: string;
  completedAt: string;
  allCleared: boolean;
  results: {
    scenarioId: string;
    name: string;
    cleared: boolean;
    detail?: Record<string, unknown>;
    error?: string;
  }[];
}
