import type {
  LabResetSummary,
  LabStatus,
  ScenarioListResponse,
  ScenarioTelemetry,
  TimelineEntry,
  VerificationResult,
} from './types';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await response.text();
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      if (text) message = text.slice(0, 300);
    }
    throw new Error(message);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const api = {
  labStatus: () => request<LabStatus>('/lab/status'),
  scenarios: () => request<ScenarioListResponse>('/scenarios'),
  timeline: (scenarioId?: string, limit = 60) =>
    request<{ entries: TimelineEntry[] }>(
      `/lab/timeline?limit=${limit}${scenarioId ? `&scenarioId=${scenarioId}` : ''}`,
    ),
  telemetry: (id: string) => request<ScenarioTelemetry>(`/scenarios/${id}/telemetry`),
  activate: (id: string) => request<{ message: string }>(`/scenarios/${id}/activate`, { method: 'POST' }),
  verify: (id: string) => request<VerificationResult>(`/scenarios/${id}/verify`, { method: 'POST' }),
  reset: (id: string) => request<{ message: string }>(`/scenarios/${id}/reset`, { method: 'POST' }),
  resetLab: () => request<LabResetSummary>('/lab/reset', { method: 'POST' }),
  scaleAks: (nodeCount: number) =>
    request<{ count: number }>('/scenarios/02/scale', {
      method: 'POST',
      body: JSON.stringify({ nodeCount }),
    }),
};
