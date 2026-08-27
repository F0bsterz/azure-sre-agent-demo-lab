/**
 * HTTP API for the Scenario Controller.
 *
 * /api/health is intentionally dependency-free. It answers from process state
 * alone so that monitoring can distinguish "the controller is down" from "the
 * controller is up and reporting that something else is down" — the latter
 * being the normal condition during a scenario.
 */

import { Router, type Request, type Response } from 'express';
import { config } from './config.js';
import { log, errorFields } from './logger.js';
import { labStatus } from './health.js';
import { listEvents } from './db.js';
import { allScenarios, blockingScenario, getScenario, resetLab } from './scenarios/index.js';
import { AksCapacityScenario } from './scenarios/aks-capacity.js';
import { telemetry } from './telemetry.js';

const buildInfo = {
  service: 'scenario-controller',
  version: process.env['APP_VERSION'] ?? '0.1.0',
  imageTag: process.env['IMAGE_TAG'] ?? 'local',
  gitCommit: process.env['GIT_COMMIT'] ?? 'unknown',
  buildTimestamp: process.env['BUILD_TIMESTAMP'] ?? 'unknown',
};

const startedAt = new Date().toISOString();

function fail(res: Response, error: unknown, status = 500): void {
  const err = error instanceof Error ? error : new Error(String(error));
  log.error('request failed', errorFields(err));
  telemetry.trackException(err);
  res.status(status).json({ error: err.message });
}

export function createRouter(): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      ...buildInfo,
      startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      telemetryConfigured: telemetry.enabled,
    });
  });

  router.get('/version', (_req: Request, res: Response) => res.json(buildInfo));

  router.get('/lab/status', async (_req: Request, res: Response) => {
    try {
      res.json(await labStatus());
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/lab/timeline', async (req: Request, res: Response) => {
    try {
      const scenarioId = typeof req.query['scenarioId'] === 'string' ? req.query['scenarioId'] : undefined;
      const limit = Math.min(Number.parseInt(String(req.query['limit'] ?? '100'), 10) || 100, 500);
      res.json({ entries: await listEvents(scenarioId, limit) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/lab/reset', async (_req: Request, res: Response) => {
    try {
      log.info('lab reset requested');
      res.json(await resetLab());
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/scenarios', async (_req: Request, res: Response) => {
    try {
      const statuses = await Promise.all(
        allScenarios().map(async (scenario) => ({
          ...(await scenario.status()),
          investigationPrompt: scenario.investigationPrompt,
          telemetryMetrics: scenario.telemetryMetrics,
        })),
      );
      res.json({
        scenarios: statuses,
        policy: {
          oneAtATime: !config.scenarios.allowConcurrent,
          timeoutMinutes: config.scenarios.timeoutMinutes,
        },
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/scenarios/:id/status', async (req: Request, res: Response) => {
    const scenario = getScenario(req.params['id'] ?? '');
    if (!scenario) return res.status(404).json({ error: 'unknown scenario' });
    try {
      res.json({
        ...(await scenario.status()),
        investigationPrompt: scenario.investigationPrompt,
        telemetryMetrics: scenario.telemetryMetrics,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/scenarios/:id/telemetry', async (req: Request, res: Response) => {
    const scenario = getScenario(req.params['id'] ?? '');
    if (!scenario) return res.status(404).json({ error: 'unknown scenario' });
    try {
      res.json(await scenario.telemetry());
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/scenarios/:id/activate', async (req: Request, res: Response) => {
    const scenario = getScenario(req.params['id'] ?? '');
    if (!scenario) return res.status(404).json({ error: 'unknown scenario' });

    const blocker = blockingScenario(scenario.id);
    if (blocker) {
      return res.status(409).json({
        error: `Scenario ${blocker.id} (${blocker.name}) is already active. Only one scenario runs at a time by default.`,
        blockedBy: blocker.id,
      });
    }

    try {
      res.json(await scenario.activate());
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/scenarios/:id/verify', async (req: Request, res: Response) => {
    const scenario = getScenario(req.params['id'] ?? '');
    if (!scenario) return res.status(404).json({ error: 'unknown scenario' });
    try {
      res.json(await scenario.verify());
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/scenarios/:id/reset', async (req: Request, res: Response) => {
    const scenario = getScenario(req.params['id'] ?? '');
    if (!scenario) return res.status(404).json({ error: 'unknown scenario' });
    try {
      res.json(await scenario.reset());
    } catch (error) {
      fail(res, error);
    }
  });

  // Lets the demonstrator perform the expected scenario 02 remediation from the
  // dashboard when they are not driving it through Azure SRE Agent.
  router.post('/scenarios/02/scale', async (req: Request, res: Response) => {
    const scenario = getScenario('02');
    if (!(scenario instanceof AksCapacityScenario)) {
      return res.status(404).json({ error: 'scaling is not available for this scenario' });
    }
    const requested = Number.parseInt(String((req.body as { nodeCount?: unknown })?.nodeCount ?? '2'), 10);
    if (!Number.isFinite(requested)) return res.status(400).json({ error: 'nodeCount must be a number' });
    try {
      res.json(await scenario.scaleTo(requested));
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
