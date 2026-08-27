/**
 * Scenario 04 — PostgreSQL connection exhaustion.
 *
 * A leaker opens connections and deliberately never returns them, exactly as a
 * service with a broken pool would. Every leaked session sets
 * application_name = 'sre-demo-scenario-04', which does two jobs: it is the
 * clue that identifies the offender in pg_stat_activity, and it is the filter
 * that lets reset terminate only this lab's sessions and never an unrelated
 * one.
 *
 * The leak stops short of max_connections by a configurable headroom, on top of
 * PostgreSQL's own superuser_reserved_connections. That keeps an administrative
 * path open so the incident stays diagnosable and resettable.
 */

import { Client } from 'pg';
import { config } from '../config.js';
import { log, errorFields } from '../logger.js';
import { getConnectionStats, terminateScenarioSessions } from '../db.js';
import { tcpProbe } from '../probes.js';
import { telemetry, METRICS } from '../telemetry.js';
import { BaseScenario } from './base.js';
import type { ScenarioTelemetry, Severity, VerificationCheck, VerificationResult } from './types.js';

const APPLICATION_NAME = 'sre-demo-scenario-04';

export class PostgresConnectionScenario extends BaseScenario {
  readonly id = '04';
  readonly name = 'Database Connection Exhaustion';
  readonly description =
    'A service with a leaking connection pool opens PostgreSQL sessions and never releases them, driving connection usage towards max_connections until new clients are refused.';
  readonly component = 'PostgreSQL VM';
  readonly severity: Severity = 'critical';
  readonly investigationPrompt =
    'Investigate the database errors affecting the application. Determine whether PostgreSQL is healthy and identify why clients cannot establish connections.';
  readonly telemetryMetrics = [
    METRICS.postgresActiveConnections,
    METRICS.postgresConnectionPercent,
    METRICS.postgresConnectivity,
  ];

  private leaked: Client[] = [];
  private topUp: NodeJS.Timeout | undefined;

  private async targetLeakCount(): Promise<number> {
    const stats = await getConnectionStats();
    const max = stats.reachable ? stats.maxConnections : config.postgres.maxConnections;
    // Leave room for superuser_reserved_connections (3) plus our own headroom.
    const ceiling = max - 3 - config.scenarios.postgresLeakHeadroom;
    const existing = stats.reachable ? stats.activeConnections - stats.scenarioConnections : 0;
    return Math.max(0, ceiling - existing);
  }

  private async openOne(): Promise<boolean> {
    const client = new Client({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.scenarioUser || config.postgres.user,
      password: config.postgres.scenarioPassword || config.postgres.password,
      application_name: APPLICATION_NAME,
      connectionTimeoutMillis: config.postgres.connectTimeoutMs,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      // Begin a transaction and leave it open: idle in transaction is the
      // realistic signature of a leak, and it is visible in pg_stat_activity.
      await client.query('BEGIN');
      await client.query('SELECT pg_sleep(0)');
      this.leaked.push(client);
      return true;
    } catch {
      await client.end().catch(() => undefined);
      return false;
    }
  }

  private async leakUpTo(count: number): Promise<number> {
    let opened = 0;
    for (let index = 0; index < count; index += 1) {
      const ok = await this.openOne();
      if (!ok) break;
      opened += 1;
    }
    return opened;
  }

  protected async inject(): Promise<Record<string, unknown>> {
    const target = await this.targetLeakCount();
    const opened = await this.leakUpTo(target);

    // PostgreSQL closes idle sessions eventually; top up so the incident holds
    // for the length of a demo instead of quietly healing.
    if (!this.topUp) {
      this.topUp = setInterval(() => {
        void (async () => {
          this.leaked = this.leaked.filter((client) => {
            const ended = (client as unknown as { _ending?: boolean })._ending;
            return !ended;
          });
          const remaining = await this.targetLeakCount().catch(() => 0);
          if (remaining > 0) await this.leakUpTo(Math.min(remaining, 5)).catch(() => 0);
        })();
      }, 15_000);
      this.topUp.unref();
    }

    const stats = await getConnectionStats();
    return {
      connectionsOpened: opened,
      applicationName: APPLICATION_NAME,
      activeConnections: stats.activeConnections,
      maxConnections: stats.maxConnections,
      percentUsed: stats.percentUsed,
    };
  }

  protected async clear(): Promise<Record<string, unknown>> {
    if (this.topUp) {
      clearInterval(this.topUp);
      this.topUp = undefined;
    }

    const held = this.leaked;
    this.leaked = [];
    let closed = 0;
    for (const client of held) {
      try {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
        closed += 1;
      } catch (error) {
        log.warn('failed to close leaked connection cleanly', errorFields(error));
      }
    }

    // Sessions from a previous controller process cannot be closed client-side;
    // terminate them server-side, matched strictly on our application_name.
    const terminated = await terminateScenarioSessions();
    const stats = await getConnectionStats();
    return {
      connectionsClosed: closed,
      sessionsTerminated: terminated,
      activeConnectionsAfter: stats.activeConnections,
      percentUsedAfter: stats.percentUsed,
    };
  }

  async telemetry(): Promise<ScenarioTelemetry> {
    const stats = await getConnectionStats();
    const tcp = await tcpProbe(config.postgres.host, config.postgres.port);

    telemetry.trackMetric(METRICS.postgresActiveConnections, stats.activeConnections, undefined, this.context());
    telemetry.trackMetric(METRICS.postgresConnectionPercent, stats.percentUsed, undefined, this.context());
    telemetry.trackMetric(METRICS.postgresConnectivity, stats.reachable ? 1 : 0, undefined, this.context());

    return {
      scenarioId: this.id,
      collectedAt: new Date().toISOString(),
      metrics: {
        activeConnections: stats.activeConnections,
        maxConnections: stats.maxConnections,
        percentUsed: stats.percentUsed,
        scenarioConnections: stats.scenarioConnections,
        leakedByThisProcess: this.leaked.length,
        reachable: stats.reachable,
        tcpReachable: tcp.reachable,
        queryLatencyMs: stats.latencyMs,
      },
      observations: [
        stats.reachable
          ? `${stats.activeConnections} of ${stats.maxConnections} connections in use (${stats.percentUsed}%).`
          : `PostgreSQL query failed: ${stats.error ?? 'unknown error'}.`,
        `${stats.scenarioConnections} session(s) report application_name = '${APPLICATION_NAME}'.`,
        tcp.reachable
          ? `TCP 5432 is reachable in ${tcp.latencyMs}ms, so the network path is intact — this is a connection-limit problem, not a routing one.`
          : `TCP 5432 is unreachable: ${tcp.error ?? 'unknown'}.`,
        'Root cause to recommend: connection pooling that never returns connections; sessions sit idle in transaction.',
      ],
    };
  }

  async verify(): Promise<VerificationResult> {
    const stats = await getConnectionStats();
    const tcp = await tcpProbe(config.postgres.host, config.postgres.port);
    const shouldBeFaulted = this.state !== 'IDLE' && this.state !== 'RESETTING';

    const checks: VerificationCheck[] = [
      {
        name: 'PostgreSQL TCP endpoint reachable',
        passed: tcp.reachable,
        detail: tcp.reachable ? `Connected in ${tcp.latencyMs}ms.` : (tcp.error ?? 'unreachable'),
      },
      {
        name: shouldBeFaulted ? 'Connection usage elevated' : 'Connection usage back to baseline',
        passed: shouldBeFaulted ? stats.percentUsed >= 70 : stats.percentUsed < 50,
        detail: `${stats.activeConnections}/${stats.maxConnections} connections (${stats.percentUsed}%).`,
      },
      {
        name: shouldBeFaulted ? 'Leaked sessions present' : 'No scenario sessions remain',
        passed: shouldBeFaulted ? stats.scenarioConnections > 0 : stats.scenarioConnections === 0,
        detail: `${stats.scenarioConnections} session(s) named '${APPLICATION_NAME}'.`,
      },
      {
        name: 'Administrative headroom preserved',
        passed: stats.activeConnections < stats.maxConnections,
        detail: `Headroom of ${stats.maxConnections - stats.activeConnections} connection(s) kept for diagnosis and reset.`,
      },
    ];

    return {
      scenarioId: this.id,
      passed: checks.every((check) => check.passed),
      faultPresent: stats.scenarioConnections > 0 && stats.percentUsed >= 70,
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }
}
