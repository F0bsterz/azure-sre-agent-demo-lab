/**
 * scenario-runner — performs the Kubernetes-local faults for the demo lab.
 *
 * Reached only over an internal load balancer from the Scenario Controller and
 * authenticated with a shared bearer token; it is never exposed publicly. Its
 * RBAC Role is namespace-scoped and limited to the objects it touches, so a
 * compromise of this service cannot reach beyond the sre-demo namespace.
 *
 * Fault operations are expressed as scale and patch operations on objects that
 * already exist, rather than as create/delete. That makes every operation
 * idempotent, keeps the required permissions smaller, and means a reset can
 * never orphan a resource it forgot about.
 */

import express from 'express';
import { cpuToMilli, k8s, memoryToMi, namespace, type K8sPod } from './k8s.js';

const port = Number.parseInt(process.env['PORT'] ?? '8090', 10);
const authToken = process.env['RUNNER_TOKEN'] ?? '';

const MAGIC8BALL_DEPLOYMENT = process.env['MAGIC8BALL_DEPLOYMENT'] ?? 'magic8ball';
const BURNER_DEPLOYMENT = process.env['BURNER_DEPLOYMENT'] ?? 'resource-burner';
const TLS_SECRET = process.env['TLS_SECRET'] ?? 'magic8ball-tls';
const TLS_VALID_SECRET = process.env['TLS_VALID_SECRET'] ?? 'magic8ball-tls-valid';
const TLS_EXPIRED_SECRET = process.env['TLS_EXPIRED_SECRET'] ?? 'magic8ball-tls-expired';
const STABLE_IMAGE = process.env['MAGIC8BALL_STABLE_IMAGE'] ?? '';
const BAD_IMAGE = process.env['MAGIC8BALL_BAD_IMAGE'] ?? '';
/** Hard ceiling; the controller cannot request more than this however it asks. */
const MAX_BURNER_REPLICAS = Number.parseInt(process.env['MAX_BURNER_REPLICAS'] ?? '8', 10);

function log(level: string, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: 'scenario-runner',
    message,
    ...fields,
  });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.get('/healthz', (_req, res) => res.json({ status: 'ok', namespace }));
app.get('/readyz', (_req, res) => res.json({ status: 'ready' }));

// Everything below the health endpoints requires the shared token.
app.use((req, res, next) => {
  if (!authToken) return next();
  const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (provided !== authToken) return res.status(401).json({ error: 'unauthorized' });
  next();
});

function podReady(pod: K8sPod): boolean {
  return (pod.status.conditions ?? []).some(
    (condition) => condition.type === 'Ready' && condition.status === 'True',
  );
}

function pendingReason(pod: K8sPod): string | undefined {
  if (pod.status.phase !== 'Pending') return undefined;
  const waiting = pod.status.containerStatuses?.[0]?.state as
    | { waiting?: { reason?: string } }
    | undefined;
  return waiting?.waiting?.reason ?? pod.status.reason ?? 'Unschedulable';
}

app.get('/status', async (_req, res) => {
  try {
    const [pods, nodes, magic8ball, burner, tlsSecret] = await Promise.all([
      k8s.listPods(),
      k8s.listNodes(),
      k8s.getDeployment(MAGIC8BALL_DEPLOYMENT).catch(() => undefined),
      k8s.getDeployment(BURNER_DEPLOYMENT).catch(() => undefined),
      k8s.getSecret(TLS_SECRET).catch(() => undefined),
    ]);

    const readyNodes = nodes.items.filter((node) =>
      (node.status.conditions ?? []).some(
        (condition) => condition.type === 'Ready' && condition.status === 'True',
      ),
    );

    const allocatableCpuMilli = readyNodes.reduce(
      (sum, node) => sum + cpuToMilli(node.status.allocatable?.['cpu']),
      0,
    );
    const allocatableMemoryMi = readyNodes.reduce(
      (sum, node) => sum + memoryToMi(node.status.allocatable?.['memory']),
      0,
    );

    // Only scheduled pods consume capacity; Pending pods are what is left over.
    const scheduled = pods.items.filter((pod) => pod.spec.nodeName);
    const requestedCpuMilli = scheduled.reduce(
      (sum, pod) =>
        sum +
        pod.spec.containers.reduce(
          (inner, container) => inner + cpuToMilli(container.resources?.requests?.['cpu']),
          0,
        ),
      0,
    );
    const requestedMemoryMi = scheduled.reduce(
      (sum, pod) =>
        sum +
        pod.spec.containers.reduce(
          (inner, container) => inner + memoryToMi(container.resources?.requests?.['memory']),
          0,
        ),
      0,
    );

    const magicImage = magic8ball?.spec.template.spec.containers[0]?.image;
    const variant =
      magic8ball?.metadata.annotations?.['sre-demo/variant'] ??
      (magicImage && BAD_IMAGE && magicImage === BAD_IMAGE
        ? 'bad'
        : magicImage && STABLE_IMAGE && magicImage === STABLE_IMAGE
          ? 'stable'
          : 'unknown');

    res.json({
      reachable: true,
      namespace,
      nodeCount: readyNodes.length,
      pendingPods: pods.items.filter((pod) => pod.status.phase === 'Pending').length,
      pods: pods.items.map((pod) => ({
        name: pod.metadata.name,
        phase: pod.status.phase,
        ready: podReady(pod),
        restarts: pod.status.containerStatuses?.[0]?.restartCount ?? 0,
        image: pod.spec.containers[0]?.image,
        reason: pendingReason(pod),
        node: pod.spec.nodeName,
      })),
      magic8ball: {
        image: magicImage,
        variant,
        desiredReplicas: magic8ball?.spec.replicas ?? 0,
        readyReplicas: magic8ball?.status?.readyReplicas ?? 0,
      },
      resourcePressure: {
        present: (burner?.spec.replicas ?? 0) > 0,
        desiredReplicas: burner?.spec.replicas ?? 0,
        readyReplicas: burner?.status?.readyReplicas ?? 0,
      },
      certificate: {
        variant: tlsSecret?.metadata.annotations?.['sre-demo/cert-variant'] ?? 'unknown',
        notAfter: tlsSecret?.metadata.annotations?.['sre-demo/cert-not-after'],
      },
      nodeCapacity: { allocatableCpuMilli, allocatableMemoryMi, requestedCpuMilli, requestedMemoryMi },
    });
  } catch (error) {
    log('error', 'status failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/pressure/apply', async (req, res) => {
  const requested = Number.parseInt(String((req.body as { replicas?: unknown })?.replicas ?? '6'), 10);
  const replicas = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 6, MAX_BURNER_REPLICAS));
  try {
    const updated = await k8s.patchDeployment(BURNER_DEPLOYMENT, { spec: { replicas } });
    log('info', 'resource pressure applied', { replicas });
    res.json({ replicas: updated.spec.replicas, cappedAt: MAX_BURNER_REPLICAS });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/pressure/remove', async (_req, res) => {
  try {
    // Scaling to zero rather than deleting keeps the operation idempotent and
    // leaves the manifest in place for the next run.
    await k8s.patchDeployment(BURNER_DEPLOYMENT, { spec: { replicas: 0 } });
    log('info', 'resource pressure removed');
    res.json({ replicas: 0 });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/deployment/variant', async (req, res) => {
  const variant = String((req.body as { variant?: unknown })?.variant ?? '');
  if (variant !== 'stable' && variant !== 'bad') {
    return res.status(400).json({ error: 'variant must be "stable" or "bad"' });
  }
  const image = variant === 'bad' ? BAD_IMAGE : STABLE_IMAGE;
  if (!image) return res.status(500).json({ error: `no image configured for variant ${variant}` });

  try {
    const updated = await k8s.patchDeployment(MAGIC8BALL_DEPLOYMENT, {
      metadata: { annotations: { 'sre-demo/variant': variant } },
      spec: {
        template: {
          metadata: {
            annotations: {
              'sre-demo/variant': variant,
              'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
            },
          },
          spec: { containers: [{ name: 'magic8ball', image }] },
        },
      },
    });
    log('info', 'magic8ball variant changed', { variant, image });
    res.json({ variant, image: updated.spec.template.spec.containers[0]?.image });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/deployment/restart', async (_req, res) => {
  try {
    await k8s.patchDeployment(MAGIC8BALL_DEPLOYMENT, {
      spec: {
        template: {
          metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } },
        },
      },
    });
    res.json({ restarted: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/certificate/variant', async (req, res) => {
  const variant = String((req.body as { variant?: unknown })?.variant ?? '');
  if (variant !== 'valid' && variant !== 'expired') {
    return res.status(400).json({ error: 'variant must be "valid" or "expired"' });
  }
  const sourceName = variant === 'valid' ? TLS_VALID_SECRET : TLS_EXPIRED_SECRET;

  try {
    // Both certificate pairs are pre-loaded as separate secrets at deploy time,
    // so swapping is a copy between existing objects — no key material ever
    // passes through this service or the controller.
    const source = await k8s.getSecret(sourceName);
    if (!source.data?.['tls.crt'] || !source.data['tls.key']) {
      return res.status(500).json({ error: `secret ${sourceName} does not contain a certificate pair` });
    }

    await k8s.patchSecret(TLS_SECRET, {
      metadata: {
        annotations: {
          'sre-demo/cert-variant': variant,
          'sre-demo/cert-not-after': source.metadata.annotations?.['sre-demo/cert-not-after'] ?? '',
        },
      },
      data: { 'tls.crt': source.data['tls.crt'], 'tls.key': source.data['tls.key'] },
    });

    // The certificate is read at process start, so the workload must restart.
    await k8s.patchDeployment(MAGIC8BALL_DEPLOYMENT, {
      spec: {
        template: {
          metadata: {
            annotations: {
              'sre-demo/cert-variant': variant,
              'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
            },
          },
        },
      },
    });

    log('info', 'certificate variant changed', { variant, source: sourceName });
    res.json({ variant, source: sourceName, restarted: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.listen(port, () => log('info', 'scenario-runner listening', { port, namespace }));

process.on('SIGTERM', () => process.exit(0));
process.on('unhandledRejection', (reason) =>
  log('error', 'unhandled rejection', { error: String(reason) }),
);
