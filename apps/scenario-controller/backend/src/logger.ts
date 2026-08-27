/**
 * Structured logging.
 *
 * One JSON object per line on stdout. Docker's journald/syslog path carries it
 * to the Azure Monitor Agent, so scenario fields stay queryable in Log
 * Analytics alongside the Application Insights telemetry.
 */

import type { ScenarioContext } from './telemetry.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const levelRank: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minimum = levelRank[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? levelRank.info;

function emit(level: Level, message: string, fields?: Record<string, unknown>, scenario?: ScenarioContext): void {
  if (levelRank[level] < minimum) return;
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    service: 'scenario-controller',
    message,
    ...fields,
  };
  if (scenario) {
    if (scenario.scenarioId) record['scenario.id'] = scenario.scenarioId;
    if (scenario.scenarioName) record['scenario.name'] = scenario.scenarioName;
    if (scenario.scenarioState) record['scenario.state'] = scenario.scenarioState;
    if (scenario.scenarioStartedAt) record['scenario.startedAt'] = scenario.scenarioStartedAt;
    if (scenario.scenarioComponent) record['scenario.component'] = scenario.scenarioComponent;
    if (scenario.correlationId) record['scenario.correlationId'] = scenario.correlationId;
  }
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>, scenario?: ScenarioContext) =>
    emit('debug', message, fields, scenario),
  info: (message: string, fields?: Record<string, unknown>, scenario?: ScenarioContext) =>
    emit('info', message, fields, scenario),
  warn: (message: string, fields?: Record<string, unknown>, scenario?: ScenarioContext) =>
    emit('warn', message, fields, scenario),
  error: (message: string, fields?: Record<string, unknown>, scenario?: ScenarioContext) =>
    emit('error', message, fields, scenario),
};

export function errorFields(error: unknown): Record<string, unknown> {
  const err = error instanceof Error ? error : new Error(String(error));
  return { errorType: err.name, errorMessage: err.message };
}
