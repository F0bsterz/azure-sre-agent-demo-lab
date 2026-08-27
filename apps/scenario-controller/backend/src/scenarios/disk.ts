/**
 * Scenario 01 — disk capacity exhaustion on the App VM.
 *
 * Safety envelope:
 *   * writes ONLY into the dedicated demo data disk log directory
 *   * every file is named sre-demo-scenario-01-*.log so reset can delete
 *     exactly what it created and nothing else
 *   * stops at the configured target (default 88%) and is hard-capped at 92%,
 *     so the disk never reaches 100% and always stays recoverable
 *   * the OS disk is never touched, which keeps the control plane alive
 *
 * The generated lines are realistic application logs rather than random bytes,
 * because the investigation is supposed to end at "one service is logging a
 * retry storm", not at "someone ran dd".
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { diskUsage } from '../probes.js';
import { telemetry, METRICS } from '../telemetry.js';
import { BaseScenario } from './base.js';
import type { ScenarioTelemetry, Severity, VerificationCheck, VerificationResult } from './types.js';

const execFileAsync = promisify(execFile);

const FILE_PREFIX = 'sre-demo-scenario-01-';
const ARCHIVE_PREFIX = `${FILE_PREFIX}archive-`;
const SERVICES = ['order-api', 'payment-gateway', 'inventory-sync', 'notification-worker'];
const ENDPOINTS = ['/api/orders', '/api/payments', '/api/inventory/reserve', '/api/notifications/send'];
const EXCEPTIONS = [
  'System.Net.Http.HttpRequestException: Connection reset by peer',
  'java.net.SocketTimeoutException: Read timed out after 30000ms',
  'psycopg2.OperationalError: server closed the connection unexpectedly',
  'RetryExhaustedException: retry budget exhausted after 5 attempts',
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

/** One block of plausible application log lines. */
function logBlock(targetBytes: number): string {
  const lines: string[] = [];
  let size = 0;
  while (size < targetBytes) {
    const timestamp = new Date().toISOString();
    const requestId = randomUUID();
    const sessionId = randomUUID().slice(0, 18);
    const service = pick(SERVICES);
    const endpoint = pick(ENDPOINTS);
    const roll = Math.random();
    let line: string;
    if (roll < 0.55) {
      line = `${timestamp} INFO  [${service}] request_id=${requestId} session_id=${sessionId} app=checkout-suite msg="handled ${endpoint}" duration_ms=${(20 + Math.random() * 90).toFixed(1)} status=200`;
    } else if (roll < 0.8) {
      line = `${timestamp} WARN  [${service}] request_id=${requestId} session_id=${sessionId} app=checkout-suite msg="upstream slow, scheduling retry" endpoint=${endpoint} attempt=${1 + Math.floor(Math.random() * 4)} backoff_ms=${250 * (1 + Math.floor(Math.random() * 8))}`;
    } else {
      line = `${timestamp} ERROR [${service}] request_id=${requestId} session_id=${sessionId} app=checkout-suite msg="request failed" endpoint=${endpoint} status=503 exception="${pick(EXCEPTIONS)}" retry_storm=true`;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return `${lines.join('\n')}\n`;
}

export class DiskCapacityScenario extends BaseScenario {
  readonly id = '01';
  readonly name = 'Disk Capacity Exhaustion';
  readonly description =
    'A misbehaving service enters a retry storm and floods the application log directory on the App VM dedicated demo disk until it runs out of capacity.';
  readonly component = 'App VM — /var/sre-demo';
  readonly severity: Severity = 'high';
  readonly investigationPrompt =
    'Investigate why the application VM is reporting low disk capacity. Identify the root cause and propose a safe mitigation.';
  readonly telemetryMetrics = [METRICS.diskPercentUsed];

  private writer: NodeJS.Timeout | undefined;
  private currentFile: string | undefined;
  private bytesWritten = 0;

  private ceiling(): number {
    return Math.min(config.disk.targetPercent, config.disk.maxPercent);
  }

  private startWriter(): void {
    if (this.writer) return;
    mkdirSync(config.disk.logDir, { recursive: true });
    this.currentFile = join(config.disk.logDir, `${FILE_PREFIX}${Date.now()}.log`);

    this.writer = setInterval(() => {
      void (async () => {
        try {
          const usage = await diskUsage();
          if (usage.percentUsed >= this.ceiling()) {
            // Target reached. Hold the disk at pressure without ever filling it.
            log.info('disk scenario reached target utilisation, pausing writer', {
              percentUsed: usage.percentUsed,
              ceiling: this.ceiling(),
            }, this.context());
            return;
          }
          // Never consume the last 256 MB, whatever the percentage says.
          const guardBytes = 256 * 1024 * 1024;
          if (usage.freeBytes <= guardBytes) return;
          const chunk = Math.min(config.disk.chunkBytes, usage.freeBytes - guardBytes);
          if (chunk <= 0) return;

          // Roll to a new file each ~64 MB so "largest files" is a real clue.
          if (this.bytesWritten > 64 * 1024 * 1024 || !this.currentFile) {
            this.currentFile = join(config.disk.logDir, `${FILE_PREFIX}${Date.now()}.log`);
            this.bytesWritten = 0;
          }
          appendFileSync(this.currentFile, logBlock(chunk));
          this.bytesWritten += chunk;
        } catch (error) {
          log.warn('disk scenario write failed', {
            error: error instanceof Error ? error.message : String(error),
          }, this.context());
        }
      })();
    }, config.disk.writeIntervalMs);
    this.writer.unref();
  }

  private stopWriter(): void {
    if (this.writer) {
      clearInterval(this.writer);
      this.writer = undefined;
    }
    this.currentFile = undefined;
    this.bytesWritten = 0;
  }

  private scenarioFiles(): { name: string; path: string; sizeBytes: number }[] {
    try {
      return readdirSync(config.disk.logDir)
        .filter((name) => name.startsWith(FILE_PREFIX))
        .map((name) => {
          const path = join(config.disk.logDir, name);
          let sizeBytes = 0;
          try {
            sizeBytes = statSync(path).size;
          } catch {
            sizeBytes = 0;
          }
          return { name, path, sizeBytes };
        })
        .sort((a, b) => b.sizeBytes - a.sizeBytes);
    } catch {
      return [];
    }
  }

  protected async inject(): Promise<Record<string, unknown>> {
    mkdirSync(config.disk.logDir, { recursive: true });
    const before = await diskUsage();

    // Stand in for months of unrotated logs. fallocate reserves the blocks
    // without writing them, so this is effectively instantaneous and df
    // reflects it immediately.
    let ballastBytes = 0;
    const ballastTarget = Math.min(config.disk.ballastPercent, this.ceiling() - 5);
    if (before.percentUsed < ballastTarget) {
      const usable = before.usedBytes + before.freeBytes;
      ballastBytes = Math.max(0, Math.floor((ballastTarget / 100) * usable) - before.usedBytes);
      if (ballastBytes > 0) {
        const archivePath = join(config.disk.logDir, `${ARCHIVE_PREFIX}${Date.now()}.log`);
        try {
          await execFileAsync('fallocate', ['-l', String(ballastBytes), archivePath]);
        } catch (error) {
          log.warn('fallocate unavailable, falling back to written ballast', {
            error: error instanceof Error ? error.message : String(error),
          });
          ballastBytes = 0;
        }
      }
    }

    this.startWriter();
    const after = await diskUsage();
    return {
      logDirectory: config.disk.logDir,
      targetPercent: this.ceiling(),
      startingPercentUsed: before.percentUsed,
      archiveBytes: ballastBytes,
      percentUsedAfterArchive: after.percentUsed,
    };
  }

  protected async clear(): Promise<Record<string, unknown>> {
    this.stopWriter();
    const files = this.scenarioFiles();
    let removed = 0;
    let freedBytes = 0;
    for (const file of files) {
      try {
        unlinkSync(file.path);
        removed += 1;
        freedBytes += file.sizeBytes;
      } catch (error) {
        log.warn('could not remove scenario log file', {
          file: file.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const after = await diskUsage();
    return { filesRemoved: removed, bytesFreed: freedBytes, percentUsedAfter: after.percentUsed };
  }

  async telemetry(): Promise<ScenarioTelemetry> {
    const usage = await diskUsage();
    const files = this.scenarioFiles();
    const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    const largest = files[0];
    return {
      scenarioId: this.id,
      collectedAt: new Date().toISOString(),
      metrics: {
        percentUsed: usage.percentUsed,
        freeGb: Math.round((usage.freeBytes / 1024 ** 3) * 100) / 100,
        totalGb: Math.round((usage.totalBytes / 1024 ** 3) * 100) / 100,
        scenarioFileCount: files.length,
        scenarioBytes: totalBytes,
        largestFile: largest?.name ?? null,
        largestFileMb: largest ? Math.round((largest.sizeBytes / 1024 ** 2) * 10) / 10 : 0,
        writerRunning: this.writer !== undefined,
      },
      observations: [
        `Mount ${usage.mountPath} is ${usage.percentUsed}% used (${(usage.freeBytes / 1024 ** 3).toFixed(2)} GB free).`,
        `${files.length} scenario log file(s) occupy ${(totalBytes / 1024 ** 2).toFixed(1)} MB under ${config.disk.logDir}.`,
        largest ? `Largest file: ${largest.name} at ${(largest.sizeBytes / 1024 ** 2).toFixed(1)} MB.` : 'No scenario log files present.',
        'Log lines identify app=checkout-suite with retry_storm=true, pointing at a client-side retry loop.',
      ],
    };
  }

  async verify(): Promise<VerificationResult> {
    const usage = await diskUsage();
    const files = this.scenarioFiles();
    const shouldBeFaulted = this.state !== 'IDLE' && this.state !== 'RESETTING';

    telemetry.trackMetric(METRICS.diskPercentUsed, usage.percentUsed, { mount: usage.mountPath }, this.context());

    const checks: VerificationCheck[] = [
      {
        name: 'Demo disk mounted',
        passed: usage.totalBytes > 0,
        detail: `${usage.mountPath} reports ${(usage.totalBytes / 1024 ** 3).toFixed(1)} GB total.`,
      },
      {
        name: shouldBeFaulted ? 'Disk under capacity pressure' : 'Disk below alert threshold',
        passed: shouldBeFaulted ? usage.percentUsed >= 80 : usage.percentUsed < 80,
        detail: `Utilisation is ${usage.percentUsed}%.`,
      },
      {
        name: shouldBeFaulted ? 'Scenario log files present' : 'Scenario log files removed',
        passed: shouldBeFaulted ? files.length > 0 : files.length === 0,
        detail: `${files.length} file(s) matching ${FILE_PREFIX}*.`,
      },
      {
        name: 'Disk never filled to capacity',
        passed: usage.percentUsed < 95,
        detail: `Safety ceiling is ${this.ceiling()}%; observed ${usage.percentUsed}%.`,
      },
    ];

    return {
      scenarioId: this.id,
      passed: checks.every((check) => check.passed),
      faultPresent: usage.percentUsed >= 80 && files.length > 0,
      checks,
      verifiedAt: new Date().toISOString(),
    };
  }
}
