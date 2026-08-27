/**
 * Scenario Controller entry point.
 *
 * Serves the React operations console and the scenario API from a single
 * container on the App VM. Living on the VM rather than in AKS is deliberate:
 * the control plane has to stay reachable when the cluster, the database or the
 * network path to them is the thing that is broken.
 */

import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log, errorFields } from './logger.js';
import { telemetry } from './telemetry.js';
import { createRouter } from './routes.js';
import { startProbeLoop } from './health.js';
import { closePool, initialiseEventStore } from './db.js';
import { rearmTimeouts } from './scenarios/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const staticRoot = join(here, 'public');

telemetry.configure(config.telemetry.connectionString, config.telemetry.roleName, {
  'lab.suffix': config.labSuffix,
  'lab.environment': config.environmentName,
  'service.version': process.env['APP_VERSION'] ?? '0.1.0',
  'service.imageTag': process.env['IMAGE_TAG'] ?? 'local',
  'service.gitCommit': process.env['GIT_COMMIT'] ?? 'unknown',
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// Request telemetry, so controller traffic appears in AppRequests alongside the
// Magic 8 Ball application.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    telemetry.trackRequest({
      name: `${req.method} ${req.route?.path ?? req.path}`,
      url: `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`,
      durationMs: Date.now() - started,
      responseCode: String(res.statusCode),
      success: res.statusCode < 500,
    });
  });
  next();
});

app.use('/api', createRouter());

// Kubernetes-style aliases, handy for uniform probing across both apps.
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.get('/readyz', (_req, res) => res.json({ status: 'ready' }));

if (existsSync(staticRoot)) {
  app.use(express.static(staticRoot, { index: 'index.html', maxAge: '1h' }));
  // SPA fallback: anything that is not an API route renders the console.
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(staticRoot, 'index.html')));
} else {
  log.warn('frontend bundle not found; serving API only', { staticRoot });
}

initialiseEventStore();
rearmTimeouts();
startProbeLoop();

const server = app.listen(config.port, () => {
  log.info('scenario controller listening', {
    port: config.port,
    resourceGroup: config.azure.resourceGroup,
    aksCluster: config.aks.clusterName,
    telemetryConfigured: telemetry.enabled,
  });
});

async function shutdown(signal: string): Promise<void> {
  log.info('shutting down', { signal });
  server.close();
  await telemetry.flush();
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', errorFields(reason));
  telemetry.trackException(reason);
});
process.on('uncaughtException', (error) => {
  // Stay alive: the control plane going down mid-incident is worse than the bug.
  log.error('uncaught exception', errorFields(error));
  telemetry.trackException(error);
});
