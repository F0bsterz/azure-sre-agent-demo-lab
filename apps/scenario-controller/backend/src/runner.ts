/**
 * Client for scenario-runner, the small in-cluster agent that performs the
 * Kubernetes-local faults (resource pressure, image swap, certificate swap).
 *
 * It is reached over private networking on an internal load balancer and
 * authenticated with a shared bearer token, so nothing that can break the
 * cluster is exposed publicly.
 */

import { config } from './config.js';
import { log, errorFields } from './logger.js';
import { telemetry } from './telemetry.js';

export interface PodSummary {
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
  image?: string;
  reason?: string;
  node?: string;
}

export interface RunnerStatus {
  reachable: boolean;
  namespace: string;
  nodeCount: number;
  pendingPods: number;
  pods: PodSummary[];
  magic8ball: {
    image?: string;
    variant?: 'stable' | 'bad' | 'unknown';
    desiredReplicas: number;
    readyReplicas: number;
  };
  resourcePressure: {
    present: boolean;
    desiredReplicas: number;
    readyReplicas: number;
  };
  certificate: {
    variant?: 'valid' | 'expired' | 'unknown';
    notAfter?: string;
  };
  nodeCapacity?: {
    allocatableCpuMilli: number;
    allocatableMemoryMi: number;
    requestedCpuMilli: number;
    requestedMemoryMi: number;
  };
  error?: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!config.runner.url) throw new Error('scenario-runner URL is not configured');
  const started = Date.now();
  let success = false;
  let statusCode = '0';
  try {
    const response = await fetch(`${config.runner.url.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(config.runner.token ? { authorization: `Bearer ${config.runner.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.runner.timeoutMs),
    });
    statusCode = String(response.status);
    const text = await response.text();
    if (!response.ok) throw new Error(`scenario-runner ${method} ${path}: ${response.status} ${text.slice(0, 400)}`);
    success = true;
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    telemetry.trackDependency({
      name: `${method} ${path}`,
      type: 'HTTP',
      target: 'scenario-runner',
      data: `${method} ${config.runner.url}${path}`,
      durationMs: Date.now() - started,
      success,
      resultCode: statusCode,
    });
  }
}

export async function runnerStatus(): Promise<RunnerStatus> {
  try {
    return await call<RunnerStatus>('GET', '/status');
  } catch (error) {
    log.warn('scenario-runner unreachable', errorFields(error));
    return {
      reachable: false,
      namespace: config.aks.namespace,
      nodeCount: 0,
      pendingPods: 0,
      pods: [],
      magic8ball: { desiredReplicas: 0, readyReplicas: 0 },
      resourcePressure: { present: false, desiredReplicas: 0, readyReplicas: 0 },
      certificate: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function applyResourcePressure(replicas: number): Promise<Record<string, unknown>> {
  return call('POST', '/pressure/apply', { replicas });
}

export function removeResourcePressure(): Promise<Record<string, unknown>> {
  return call('POST', '/pressure/remove');
}

export function setMagic8BallVariant(variant: 'stable' | 'bad'): Promise<Record<string, unknown>> {
  return call('POST', '/deployment/variant', { variant });
}

export function setCertificateVariant(variant: 'valid' | 'expired'): Promise<Record<string, unknown>> {
  return call('POST', '/certificate/variant', { variant });
}

export function restartMagic8Ball(): Promise<Record<string, unknown>> {
  return call('POST', '/deployment/restart');
}
