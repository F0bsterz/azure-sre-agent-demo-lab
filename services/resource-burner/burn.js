#!/usr/bin/env node
/**
 * resource-burner — bounded CPU and memory pressure for scenario 02.
 *
 * Deliberately boring and deliberately bounded:
 *   * a single process; it never forks, spawns or recurses, so it cannot become
 *     a fork bomb
 *   * memory is allocated ONCE at start to a fixed size and then only touched,
 *     so consumption is flat and predictable rather than a runaway leak
 *   * CPU load is a duty cycle, so the process yields on every interval and the
 *     node stays responsive enough to be diagnosed and remediated
 *
 * The real pressure that makes pods Pending comes from the Kubernetes resource
 * *requests* on this workload, not from what the process actually uses. That is
 * why scaling the node pool is the fix, and why this stays safe to run.
 */

const memoryMb = Number.parseInt(process.env.MEMORY_MB ?? '256', 10);
const cpuPercent = Math.min(95, Math.max(5, Number.parseInt(process.env.CPU_PERCENT ?? '85', 10)));
const cycleMs = 100;
const busyMs = Math.round((cycleMs * cpuPercent) / 100);

function log(message, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'resource-burner',
      message,
      ...fields,
    })}\n`,
  );
}

// Fixed allocation, taken up front. If the limit is too low to satisfy it the
// container fails immediately and visibly rather than drifting into an OOM kill
// halfway through a demo.
const blocks = [];
try {
  for (let index = 0; index < memoryMb; index += 1) {
    const block = Buffer.alloc(1024 * 1024, index % 256);
    blocks.push(block);
  }
  log('memory reserved', { memoryMb, cpuPercent });
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      service: 'resource-burner',
      message: 'failed to reserve memory',
      memoryMb,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
}

let running = true;
let iterations = 0;

// Keep the pages resident so the working set reflects the reservation.
const toucher = setInterval(() => {
  for (let index = 0; index < blocks.length; index += 8) {
    blocks[index][0] = (blocks[index][0] + 1) % 256;
  }
}, 5000);

function burn() {
  if (!running) return;
  const deadline = Date.now() + busyMs;
  // Bounded spin: always ends at the deadline, then hands control back.
  while (Date.now() < deadline) {
    Math.sqrt(Math.random() * 1e9);
  }
  iterations += 1;
  if (iterations % 600 === 0) {
    log('still burning', {
      iterations,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  }
  setTimeout(burn, cycleMs - busyMs);
}

log('resource burner started', { memoryMb, cpuPercent, busyMs, cycleMs });
burn();

function stop(signal) {
  log('stopping', { signal });
  running = false;
  clearInterval(toucher);
  process.exit(0);
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
