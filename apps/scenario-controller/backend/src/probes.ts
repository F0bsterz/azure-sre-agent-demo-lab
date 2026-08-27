/**
 * Synthetic monitoring probes.
 *
 * These run continuously on the App VM and are the source of the sre_demo_*
 * custom metrics. The faults themselves are always real; these probes exist
 * only to make the resulting condition easy to see in Azure Monitor within a
 * demo-length window.
 */

import { statfs } from 'node:fs/promises';
import { connect as tlsConnect, type PeerCertificate } from 'node:tls';
import { config } from './config.js';

export interface DiskUsage {
  mountPath: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  percentUsed: number;
}

export async function diskUsage(mountPath = config.disk.mountPath): Promise<DiskUsage> {
  const stats = await statfs(mountPath);
  const blockSize = Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * blockSize;
  // bavail (not bfree) is what an unprivileged writer can actually use, which
  // is what the log generator is constrained by.
  const freeBytes = Number(stats.bavail) * blockSize;
  const usedBytes = totalBytes - Number(stats.bfree) * blockSize;
  const usable = usedBytes + freeBytes;
  return {
    mountPath,
    totalBytes,
    freeBytes,
    usedBytes,
    percentUsed: usable > 0 ? Math.round((usedBytes / usable) * 1000) / 10 : 0,
  };
}

export interface HttpProbeResult {
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  body?: string;
  error?: string;
}

export async function httpProbe(url: string, timeoutMs = 8000): Promise<HttpProbeResult> {
  const started = Date.now();
  if (!url) return { ok: false, latencyMs: 0, error: 'no url configured' };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text().catch(() => '');
    return {
      ok: response.ok,
      statusCode: response.status,
      latencyMs: Date.now() - started,
      body: body.slice(0, 2000),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface TlsProbeResult {
  valid: boolean;
  reason?: string;
  /** Negative once the certificate has expired. */
  daysRemaining?: number;
  notBefore?: string;
  notAfter?: string;
  subject?: string;
  issuer?: string;
  expired: boolean;
  latencyMs: number;
}

/** X.509 CN may be a single value or several; report the first. */
function commonName(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Validates the Magic 8 Ball server certificate against the demo CA.
 *
 * Trusting the demo CA explicitly matters: it means a failure here is
 * attributable to the certificate's validity dates rather than to an unknown
 * issuer, which is what makes scenario 06 a certificate-expiry investigation
 * instead of a trust-store puzzle.
 */
export function tlsProbe(url: string, timeoutMs = 8000): Promise<TlsProbeResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    if (!url) {
      resolve({ valid: false, expired: false, reason: 'no url configured', latencyMs: 0 });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ valid: false, expired: false, reason: `invalid url: ${url}`, latencyMs: 0 });
      return;
    }

    const ca = config.magic8ball.caCertificate;
    const socket = tlsConnect(
      {
        host: parsed.hostname,
        port: Number(parsed.port || 443),
        servername: process.env['MAGIC8BALL_TLS_SERVERNAME'] || 'magic8ball.sre-demo.local',
        ca: ca ? [ca] : undefined,
        rejectUnauthorized: false, // inspect the certificate ourselves, then judge
        timeout: timeoutMs,
      },
      () => {
        const certificate = socket.getPeerCertificate() as PeerCertificate;
        const authorized = socket.authorized;
        const authorizationError = socket.authorizationError as unknown as string | undefined;
        socket.end();

        if (!certificate || Object.keys(certificate).length === 0) {
          resolve({
            valid: false,
            expired: false,
            reason: 'no peer certificate presented',
            latencyMs: Date.now() - started,
          });
          return;
        }

        const notAfter = new Date(certificate.valid_to);
        const notBefore = new Date(certificate.valid_from);
        const now = Date.now();
        const expired = notAfter.getTime() < now;
        const notYetValid = notBefore.getTime() > now;
        const daysRemaining = Math.floor((notAfter.getTime() - now) / 86_400_000);

        let reason: string | undefined;
        if (expired) reason = `certificate expired on ${notAfter.toISOString()}`;
        else if (notYetValid) reason = `certificate not valid until ${notBefore.toISOString()}`;
        else if (!authorized) reason = authorizationError ?? 'certificate failed validation';

        resolve({
          valid: !expired && !notYetValid && authorized,
          expired,
          reason,
          daysRemaining,
          notBefore: notBefore.toISOString(),
          notAfter: notAfter.toISOString(),
          subject: commonName(certificate.subject?.CN),
          issuer: commonName(certificate.issuer?.CN),
          latencyMs: Date.now() - started,
        });
      },
    );

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ valid: false, expired: false, reason: 'tls handshake timed out', latencyMs: Date.now() - started });
    });

    socket.on('error', (error) => {
      resolve({
        valid: false,
        expired: false,
        reason: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - started,
      });
    });
  });
}

export interface TcpProbeResult {
  reachable: boolean;
  latencyMs: number;
  error?: string;
}

/** Raw TCP reachability, used to separate "NSG blocked" from "service down". */
export async function tcpProbe(host: string, port: number, timeoutMs = 5000): Promise<TcpProbeResult> {
  const started = Date.now();
  if (!host) return { reachable: false, latencyMs: 0, error: 'no host configured' };
  const { Socket } = await import('node:net');
  return new Promise((resolve) => {
    const socket = new Socket();
    const finish = (result: TcpProbeResult) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ reachable: true, latencyMs: Date.now() - started }));
    socket.once('timeout', () =>
      finish({ reachable: false, latencyMs: Date.now() - started, error: 'connection timed out' }),
    );
    socket.once('error', (error) =>
      finish({ reachable: false, latencyMs: Date.now() - started, error: error.message }),
    );
    socket.connect(port, host);
  });
}
