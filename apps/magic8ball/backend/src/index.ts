/**
 * Magic 8 Ball service: React UI, JSON API, HTTP and HTTPS listeners.
 *
 * One image serves both variants. FAULT_MODE=bad turns on the scenario 03
 * regression — a deterministic share of HTTP 500s plus multi-second latency —
 * so "stable" and "bad" differ only by build metadata and this flag. That keeps
 * the rollback a genuine image change with a genuine version delta to
 * correlate, which is what the investigation is meant to find.
 *
 * TLS is terminated here from a mounted Kubernetes secret rather than by an
 * ingress controller: it keeps the lab cheap, and it makes scenario 06 a simple
 * secret swap plus rollout restart.
 */

import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telemetry } from './telemetry.js';
import { closePool, databaseHealthy, recentAnswers, saveAnswer } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const staticRoot = join(here, 'public');

const build = {
  service: 'magic8ball',
  version: process.env['APP_VERSION'] ?? '0.1.0',
  imageTag: process.env['IMAGE_TAG'] ?? 'local',
  gitCommit: process.env['GIT_COMMIT'] ?? 'unknown',
  buildTimestamp: process.env['BUILD_TIMESTAMP'] ?? 'unknown',
  variant: (process.env['FAULT_MODE'] === 'bad' ? 'bad' : 'stable') as 'stable' | 'bad',
};

const faultMode = build.variant === 'bad';
const errorRate = Math.min(1, Math.max(0, Number.parseFloat(process.env['FAULT_ERROR_RATE'] ?? '0.42')));
const slowMinMs = Number.parseInt(process.env['FAULT_LATENCY_MIN_MS'] ?? '3000', 10);
const slowMaxMs = Number.parseInt(process.env['FAULT_LATENCY_MAX_MS'] ?? '5000', 10);

const httpPort = Number.parseInt(process.env['PORT'] ?? '8080', 10);
const httpsPort = Number.parseInt(process.env['HTTPS_PORT'] ?? '8443', 10);
const tlsDir = process.env['TLS_DIR'] ?? '/etc/magic8ball/tls';

const ANSWERS: { text: string; sentiment: 'positive' | 'neutral' | 'negative' }[] = [
  { text: 'It is certain', sentiment: 'positive' },
  { text: 'Without a doubt', sentiment: 'positive' },
  { text: 'Yes definitely', sentiment: 'positive' },
  { text: 'Most likely', sentiment: 'positive' },
  { text: 'Signs point to yes', sentiment: 'positive' },
  { text: 'Reply hazy, try again', sentiment: 'neutral' },
  { text: 'Ask again later', sentiment: 'neutral' },
  { text: 'Cannot predict now', sentiment: 'neutral' },
  { text: 'Concentrate and ask again', sentiment: 'neutral' },
  { text: "Don't count on it", sentiment: 'negative' },
  { text: 'My reply is no', sentiment: 'negative' },
  { text: 'Very doubtful', sentiment: 'negative' },
  { text: 'Outlook not so good', sentiment: 'negative' },
];

telemetry.configure(process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] ?? '', 'magic8ball', {
  'service.version': build.version,
  'service.imageTag': build.imageTag,
  'service.gitCommit': build.gitCommit,
  'service.buildTimestamp': build.buildTimestamp,
  'service.variant': build.variant,
  'lab.suffix': process.env['LAB_SUFFIX'] ?? 'local',
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    telemetry.trackRequest({
      name: `${req.method} ${req.path}`,
      url: `${req.protocol}://${req.get('host') ?? 'magic8ball'}${req.originalUrl}`,
      durationMs: Date.now() - started,
      responseCode: String(res.statusCode),
      success: res.statusCode < 500,
      properties: { 'deployment.variant': build.variant, 'deployment.imageTag': build.imageTag },
    });
  });
  next();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Liveness stays honest even in the bad build: the process really is running.
// The regression shows up on the request path, which is where a real one would.
app.get('/healthz', (_req, res) => res.json({ status: 'ok', variant: build.variant }));

app.get('/readyz', async (_req, res) => {
  const dbOk = await databaseHealthy();
  // Readiness does not depend on the database. Losing history is a degradation,
  // not an outage, and taking pods out of service would mask scenarios 04/05.
  res.json({ status: 'ready', database: dbOk ? 'available' : 'unavailable', variant: build.variant });
});

app.get('/api/version', (_req, res) => res.json(build));

app.get('/api/history', async (_req, res) => {
  const rows = await recentAnswers(10);
  if (rows === undefined) {
    return res.status(200).json({ available: false, reason: 'database unavailable', answers: [] });
  }
  res.json({ available: true, answers: rows });
});

app.post('/api/answer', async (req, res) => {
  const started = Date.now();
  const question = String((req.body as { question?: unknown })?.question ?? '').slice(0, 500).trim();

  if (!question) {
    return res.status(400).json({ error: 'A question is required.' });
  }

  if (faultMode) {
    // Deterministic enough to demo, random enough to look like a real regression.
    if (Math.random() < errorRate) {
      const error = new Error('Unhandled exception in answer pipeline: oracle backend returned null');
      telemetry.trackException(error, {
        'deployment.variant': build.variant,
        'deployment.imageTag': build.imageTag,
        'fault.injected': 'true',
      });
      telemetry.trackEvent('magic8ball_regression_error', {
        'deployment.variant': build.variant,
        'deployment.gitCommit': build.gitCommit,
      });
      return res.status(500).json({
        error: 'Internal server error',
        requestId: `${Date.now().toString(16)}`,
        version: build.version,
      });
    }
    await sleep(slowMinMs + Math.random() * Math.max(0, slowMaxMs - slowMinMs));
  }

  const choice = ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
  if (!choice) return res.status(500).json({ error: 'no answer available' });

  const latencyMs = Date.now() - started;
  const persisted = await saveAnswer({
    question,
    answer: choice.text,
    sentiment: choice.sentiment,
    appVersion: build.version,
    imageTag: build.imageTag,
    latencyMs,
  });

  telemetry.trackMetric('sre_demo_magic8ball_answer_latency_ms', latencyMs, {
    'deployment.variant': build.variant,
  });

  res.json({
    question,
    answer: choice.text,
    sentiment: choice.sentiment,
    latencyMs,
    persisted,
    version: build.version,
    imageTag: build.imageTag,
    variant: build.variant,
  });
});

if (existsSync(staticRoot)) {
  app.use(express.static(staticRoot, { index: 'index.html', maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(staticRoot, 'index.html')));
}

const httpServer = app.listen(httpPort, () => {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'magic8ball',
      message: 'http listener started',
      port: httpPort,
      variant: build.variant,
      version: build.version,
      gitCommit: build.gitCommit,
    })}\n`,
  );
});

// HTTPS is optional so the service still starts if the TLS secret is missing;
// scenario 06 then shows up as a failed handshake rather than a crash loop.
let httpsServer: ReturnType<typeof createHttpsServer> | undefined;
const certPath = join(tlsDir, 'tls.crt');
const keyPath = join(tlsDir, 'tls.key');
if (existsSync(certPath) && existsSync(keyPath)) {
  try {
    httpsServer = createHttpsServer(
      { cert: readFileSync(certPath), key: readFileSync(keyPath) },
      app,
    );
    httpsServer.listen(httpsPort, () => {
      process.stdout.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'info',
          service: 'magic8ball',
          message: 'https listener started',
          port: httpsPort,
        })}\n`,
      );
    });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: 'magic8ball',
        message: 'failed to start https listener',
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
}

async function shutdown(): Promise<void> {
  httpServer.close();
  httpsServer?.close();
  await telemetry.flush();
  await closePool();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('unhandledRejection', (reason) => telemetry.trackException(reason));
