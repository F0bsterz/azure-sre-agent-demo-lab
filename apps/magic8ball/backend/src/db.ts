/**
 * PostgreSQL access for Magic 8 Ball.
 *
 * The application degrades gracefully: if the database is unavailable, answers
 * are still generated and returned, history simply becomes unavailable. Every
 * failed call is reported as a failed dependency so Azure Monitor sees the real
 * dependency failure rather than silence — that signal is what scenarios 04 and
 * 05 rely on.
 */

import { Pool } from 'pg';
import { telemetry } from './telemetry.js';

const host = process.env['PGHOST'] ?? '';
const database = process.env['PGDATABASE'] ?? 'sre_demo';

let pool: Pool | undefined;

function getPool(): Pool | undefined {
  if (!host) return undefined;
  if (pool) return pool;
  pool = new Pool({
    host,
    port: Number.parseInt(process.env['PGPORT'] ?? '5432', 10),
    database,
    user: process.env['PGUSER'] ?? 'sre_app',
    password: process.env['PGPASSWORD'] ?? '',
    max: Number.parseInt(process.env['PG_POOL_SIZE'] ?? '4', 10),
    connectionTimeoutMillis: Number.parseInt(process.env['PG_CONNECT_TIMEOUT_MS'] ?? '4000', 10),
    idleTimeoutMillis: 15_000,
    query_timeout: 8000,
    statement_timeout: 8000,
    application_name: 'magic8ball',
  });
  pool.on('error', () => undefined);
  return pool;
}

async function tracked<T>(name: string, statement: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    telemetry.trackDependency({
      name,
      type: 'PostgreSQL',
      target: host || 'postgres',
      data: statement,
      durationMs: Date.now() - started,
      success: true,
      resultCode: '200',
    });
    return result;
  } catch (error) {
    telemetry.trackDependency({
      name,
      type: 'PostgreSQL',
      target: host || 'postgres',
      data: statement,
      durationMs: Date.now() - started,
      success: false,
      resultCode: '500',
      properties: { error: error instanceof Error ? error.message : String(error) },
    });
    telemetry.trackException(error, { component: 'postgres', operation: name });
    throw error;
  }
}

export interface AnswerRow {
  askedAt: string;
  question: string;
  answer: string;
  sentiment: string;
}

export async function saveAnswer(input: {
  question: string;
  answer: string;
  sentiment: string;
  appVersion: string;
  imageTag: string;
  latencyMs: number;
}): Promise<boolean> {
  const active = getPool();
  if (!active) return false;
  try {
    await tracked('insert answer', 'INSERT INTO answers', async () => {
      await active.query(
        `INSERT INTO answers (question, answer, sentiment, app_version, image_tag, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.question, input.answer, input.sentiment, input.appVersion, input.imageTag, input.latencyMs],
      );
    });
    return true;
  } catch {
    return false;
  }
}

export async function recentAnswers(limit = 10): Promise<AnswerRow[] | undefined> {
  const active = getPool();
  if (!active) return undefined;
  try {
    return await tracked('select recent answers', 'SELECT FROM answers', async () => {
      const result = await active.query(
        `SELECT asked_at, question, answer, sentiment FROM answers ORDER BY asked_at DESC LIMIT $1`,
        [limit],
      );
      return result.rows.map((row: any) => ({
        askedAt: new Date(row.asked_at).toISOString(),
        question: row.question,
        answer: row.answer,
        sentiment: row.sentiment,
      }));
    });
  } catch {
    return undefined;
  }
}

export async function databaseHealthy(): Promise<boolean> {
  const active = getPool();
  if (!active) return false;
  try {
    await tracked('health check', 'SELECT 1', async () => {
      await active.query('SELECT 1');
    });
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = undefined;
  }
}
