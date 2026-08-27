/**
 * PostgreSQL access for the Scenario Controller.
 *
 * Two rules shape this file:
 *
 *  1. The controller must keep working when PostgreSQL is deliberately broken
 *     (scenarios 04 and 05). Every call is defensive, the pool is tiny and
 *     timeouts are short, so a dead database degrades the controller instead of
 *     hanging it.
 *  2. Scenario history must survive that outage. Events are buffered in memory
 *     (and on the demo disk) while PostgreSQL is unavailable, then flushed once
 *     it returns.
 */

import { Pool, type PoolClient } from 'pg';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { log, errorFields } from './logger.js';

export interface ScenarioEvent {
  occurredAt: string;
  scenarioId: string;
  scenarioName?: string;
  state: string;
  component?: string;
  severity?: string;
  correlationId?: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface ConnectionStats {
  reachable: boolean;
  activeConnections: number;
  maxConnections: number;
  percentUsed: number;
  scenarioConnections: number;
  latencyMs: number;
  error?: string;
}

const PENDING_FILE = () => join(config.disk.stateDir, 'pending-events.json');
const MAX_BUFFERED = 500;

let pool: Pool | undefined;
let pending: ScenarioEvent[] = [];
let recent: ScenarioEvent[] = [];

function getPool(): Pool | undefined {
  if (!config.postgres.host) return undefined;
  if (pool) return pool;
  pool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    password: config.postgres.password,
    max: config.postgres.poolSize,
    connectionTimeoutMillis: config.postgres.connectTimeoutMs,
    idleTimeoutMillis: 10_000,
    query_timeout: 8000,
    statement_timeout: 8000,
    application_name: 'sre-demo-controller',
    allowExitOnIdle: true,
  });
  // An idle-client error must never become an unhandled rejection.
  pool.on('error', (error) => log.warn('postgres pool error', errorFields(error)));
  return pool;
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const active = getPool();
  if (!active) throw new Error('PostgreSQL is not configured');
  const client = await active.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function loadPending(): void {
  try {
    mkdirSync(config.disk.stateDir, { recursive: true });
    const file = PENDING_FILE();
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as ScenarioEvent[];
      if (Array.isArray(parsed)) pending = parsed.slice(-MAX_BUFFERED);
    }
  } catch (error) {
    log.warn('could not load buffered events', errorFields(error));
  }
}

function persistPending(): void {
  try {
    mkdirSync(config.disk.stateDir, { recursive: true });
    writeFileSync(PENDING_FILE(), JSON.stringify(pending.slice(-MAX_BUFFERED)), 'utf8');
  } catch {
    // The demo disk may legitimately be full during scenario 01. In-memory
    // history is still available, so this is not worth failing a request over.
  }
}

export function initialiseEventStore(): void {
  loadPending();
}

/** Records a scenario event. Never throws; falls back to the local buffer. */
export async function recordEvent(event: ScenarioEvent): Promise<void> {
  recent = [event, ...recent].slice(0, 200);
  try {
    await withClient((client) =>
      client.query(
        `INSERT INTO scenario_events
           (occurred_at, scenario_id, scenario_name, state, component, severity, correlation_id, message, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          event.occurredAt,
          event.scenarioId,
          event.scenarioName ?? null,
          event.state,
          event.component ?? null,
          event.severity ?? null,
          event.correlationId ?? null,
          event.message,
          event.detail ? JSON.stringify(event.detail) : null,
        ],
      ),
    );
    await flushPending();
  } catch (error) {
    pending = [...pending, event].slice(-MAX_BUFFERED);
    persistPending();
    log.warn('scenario event buffered locally', {
      buffered: pending.length,
      ...errorFields(error),
    });
  }
}

/** Replays locally buffered events once PostgreSQL is reachable again. */
export async function flushPending(): Promise<number> {
  if (pending.length === 0) return 0;
  const batch = [...pending];
  try {
    await withClient(async (client) => {
      for (const event of batch) {
        await client.query(
          `INSERT INTO scenario_events
             (occurred_at, scenario_id, scenario_name, state, component, severity, correlation_id, message, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            event.occurredAt,
            event.scenarioId,
            event.scenarioName ?? null,
            event.state,
            event.component ?? null,
            event.severity ?? null,
            event.correlationId ?? null,
            event.message,
            event.detail ? JSON.stringify(event.detail) : null,
          ],
        );
      }
    });
    pending = [];
    persistPending();
    log.info('buffered scenario events flushed', { count: batch.length });
    return batch.length;
  } catch {
    return 0;
  }
}

export interface TimelineEntry extends ScenarioEvent {
  source: 'database' | 'buffer';
}

/** Timeline for the UI. Merges durable rows with anything still buffered. */
export async function listEvents(scenarioId: string | undefined, limit = 100): Promise<TimelineEntry[]> {
  const buffered: TimelineEntry[] = [...pending, ...recent]
    .filter((event) => !scenarioId || event.scenarioId === scenarioId)
    .map((event) => ({ ...event, source: 'buffer' as const }));

  try {
    const rows = await withClient(async (client) => {
      const result = scenarioId
        ? await client.query(
            `SELECT occurred_at, scenario_id, scenario_name, state, component, severity, correlation_id, message, detail
               FROM scenario_events WHERE scenario_id = $1 ORDER BY occurred_at DESC LIMIT $2`,
            [scenarioId, limit],
          )
        : await client.query(
            `SELECT occurred_at, scenario_id, scenario_name, state, component, severity, correlation_id, message, detail
               FROM scenario_events ORDER BY occurred_at DESC LIMIT $1`,
            [limit],
          );
      return result.rows;
    });

    const durable: TimelineEntry[] = rows.map((row: any) => ({
      occurredAt: new Date(row.occurred_at).toISOString(),
      scenarioId: row.scenario_id,
      scenarioName: row.scenario_name ?? undefined,
      state: row.state,
      component: row.component ?? undefined,
      severity: row.severity ?? undefined,
      correlationId: row.correlation_id ?? undefined,
      message: row.message,
      detail: row.detail ?? undefined,
      source: 'database',
    }));

    return dedupe([...durable, ...buffered]).slice(0, limit);
  } catch {
    return dedupe(buffered).slice(0, limit);
  }
}

function dedupe(entries: TimelineEntry[]): TimelineEntry[] {
  const seen = new Set<string>();
  const result: TimelineEntry[] = [];
  for (const entry of entries.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))) {
    const key = `${entry.occurredAt}|${entry.scenarioId}|${entry.state}|${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

/**
 * Connection census used both for telemetry and for scenario 04 verification.
 * pg_stat_activity plus the max_connections setting is exactly the evidence an
 * investigating agent is expected to find.
 */
export async function getConnectionStats(): Promise<ConnectionStats> {
  const started = Date.now();
  try {
    return await withClient(async (client) => {
      const result = await client.query<{
        total: string;
        scenario: string;
        max_connections: string;
      }>(
        `SELECT (SELECT count(*) FROM pg_stat_activity)::text                                   AS total,
                (SELECT count(*) FROM pg_stat_activity
                  WHERE application_name LIKE 'sre-demo-scenario%')::text                       AS scenario,
                current_setting('max_connections')                                              AS max_connections`,
      );
      const row = result.rows[0];
      const active = Number.parseInt(row?.total ?? '0', 10);
      const max = Number.parseInt(row?.max_connections ?? String(config.postgres.maxConnections), 10);
      return {
        reachable: true,
        activeConnections: active,
        maxConnections: max,
        percentUsed: max > 0 ? Math.round((active / max) * 1000) / 10 : 0,
        scenarioConnections: Number.parseInt(row?.scenario ?? '0', 10),
        latencyMs: Date.now() - started,
      };
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      reachable: false,
      activeConnections: 0,
      maxConnections: config.postgres.maxConnections,
      percentUsed: 0,
      scenarioConnections: 0,
      latencyMs: Date.now() - started,
      error: err.message,
    };
  }
}

/**
 * Terminates ONLY sessions this lab created, matched on application_name.
 * Unrelated sessions are never touched — that constraint is the whole point of
 * giving the scenario its own connection label.
 */
export async function terminateScenarioSessions(): Promise<number> {
  try {
    return await withClient(async (client) => {
      const result = await client.query<{ terminated: string }>(
        `SELECT count(*)::text AS terminated
           FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                  WHERE application_name LIKE 'sre-demo-scenario%'
                    AND pid <> pg_backend_pid()) AS killed`,
      );
      return Number.parseInt(result.rows[0]?.terminated ?? '0', 10);
    });
  } catch (error) {
    log.warn('could not terminate scenario sessions', errorFields(error));
    return 0;
  }
}

export function pendingEventCount(): number {
  return pending.length;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = undefined;
  }
}
