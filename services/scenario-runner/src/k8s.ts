/**
 * Minimal Kubernetes API client.
 *
 * Uses the pod's own service account token and the cluster CA over plain REST
 * rather than a client library. The runner only needs a handful of verbs inside
 * one namespace, and its RBAC Role is written to match exactly those — keeping
 * the dependency surface and the permission surface equally small.
 */

import { readFileSync, existsSync } from 'node:fs';
import { request as httpsRequest, Agent } from 'node:https';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const HOST = process.env['KUBERNETES_SERVICE_HOST'] ?? 'kubernetes.default.svc';
const PORT = process.env['KUBERNETES_SERVICE_PORT'] ?? '443';

function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

const token = readIfPresent(`${SA_DIR}/token`)?.trim();
const caCert = readIfPresent(`${SA_DIR}/ca.crt`);

export const namespace =
  process.env['K8S_NAMESPACE'] ?? readIfPresent(`${SA_DIR}/namespace`)?.trim() ?? 'sre-demo';

// node:https rather than fetch: fetch (undici) ignores an https.Agent, so the
// cluster CA could not be applied and the API server would fail verification.
const agent = new Agent({ ca: caCert ? [caCert] : undefined, keepAlive: true });

function api<T>(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        agent,
        timeout: 20_000,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) } : {}),
          accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`kubernetes ${method} ${path} -> ${status}: ${text.slice(0, 600)}`));
            return;
          }
          try {
            resolve((text ? JSON.parse(text) : {}) as T);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`kubernetes ${method} ${path} timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const MERGE = 'application/strategic-merge-patch+json';

export interface K8sPod {
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec: {
    nodeName?: string;
    containers: { name: string; image: string; resources?: { requests?: Record<string, string> } }[];
  };
  status: {
    phase: string;
    conditions?: { type: string; status: string }[];
    containerStatuses?: { ready: boolean; restartCount: number; state?: Record<string, unknown> }[];
    reason?: string;
  };
}

export interface K8sDeployment {
  metadata: { name: string; annotations?: Record<string, string> };
  spec: {
    replicas?: number;
    template: {
      metadata?: { annotations?: Record<string, string> };
      spec: { containers: { name: string; image: string }[] };
    };
  };
  status?: { replicas?: number; readyReplicas?: number; availableReplicas?: number };
}

export interface K8sNode {
  metadata: { name: string };
  status: {
    allocatable?: Record<string, string>;
    capacity?: Record<string, string>;
    conditions?: { type: string; status: string }[];
  };
}

export interface K8sSecret {
  metadata: { name: string; annotations?: Record<string, string> };
  data?: Record<string, string>;
}

export const k8s = {
  listPods: () => api<{ items: K8sPod[] }>('GET', `/api/v1/namespaces/${namespace}/pods`),
  listNodes: () => api<{ items: K8sNode[] }>('GET', '/api/v1/nodes'),
  getDeployment: (name: string) =>
    api<K8sDeployment>('GET', `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`),
  patchDeployment: (name: string, patch: unknown) =>
    api<K8sDeployment>(
      'PATCH',
      `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
      patch,
      MERGE,
    ),
  getSecret: (name: string) => api<K8sSecret>('GET', `/api/v1/namespaces/${namespace}/secrets/${name}`),
  patchSecret: (name: string, patch: unknown) =>
    api<K8sSecret>('PATCH', `/api/v1/namespaces/${namespace}/secrets/${name}`, patch, MERGE),
};

/** Kubernetes CPU quantity ("2", "1930m") to millicores. */
export function cpuToMilli(value: string | undefined): number {
  if (!value) return 0;
  if (value.endsWith('m')) return Number.parseInt(value.slice(0, -1), 10) || 0;
  if (value.endsWith('n')) return Math.round((Number.parseInt(value.slice(0, -1), 10) || 0) / 1_000_000);
  if (value.endsWith('u')) return Math.round((Number.parseInt(value.slice(0, -1), 10) || 0) / 1000);
  return Math.round((Number.parseFloat(value) || 0) * 1000);
}

/** Kubernetes memory quantity ("8138128Ki", "512Mi", "1Gi") to mebibytes. */
export function memoryToMi(value: string | undefined): number {
  if (!value) return 0;
  const units: [string, number][] = [
    ['Ki', 1 / 1024],
    ['Mi', 1],
    ['Gi', 1024],
    ['Ti', 1024 * 1024],
    ['K', 1000 / (1024 * 1024)],
    ['M', 1_000_000 / (1024 * 1024)],
    ['G', 1_000_000_000 / (1024 * 1024)],
  ];
  for (const [suffix, factor] of units) {
    if (value.endsWith(suffix)) {
      return Math.round((Number.parseFloat(value.slice(0, -suffix.length)) || 0) * factor);
    }
  }
  return Math.round((Number.parseFloat(value) || 0) / (1024 * 1024));
}
