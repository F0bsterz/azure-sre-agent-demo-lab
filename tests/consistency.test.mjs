/**
 * Cross-file consistency tests.
 *
 * These check the seams where this project is most likely to break silently.
 * A metric renamed in the controller but not in the alert rule, a Kubernetes
 * placeholder that deploy.sh never substitutes, or a scenario added without
 * documentation would all leave the lab looking healthy while quietly failing
 * to do its job. Type checking cannot catch any of them because the mismatch
 * spans TypeScript, Bicep, YAML and Bash.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repoRoot, path), 'utf8');

/**
 * Removes YAML comment lines. These tests must analyse configuration, not the
 * prose explaining it — otherwise a comment mentioning "cluster-admin" or a
 * placeholder reads as the real thing.
 */
const stripComments = (yaml) =>
  yaml
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

test('every sre_demo_ metric queried by an alert rule is emitted by the controller', () => {
  const alerts = read('infra/bicep/modules/alerts.bicep');
  const telemetry = read('apps/scenario-controller/backend/src/telemetry.ts');

  const queried = new Set([...alerts.matchAll(/"(sre_demo_[a-z0-9_]+)"/g)].map((m) => m[1]));
  const emitted = new Set([...telemetry.matchAll(/'(sre_demo_[a-z0-9_]+)'/g)].map((m) => m[1]));

  assert.ok(queried.size > 0, 'alerts.bicep should query at least one custom metric');

  for (const metric of queried) {
    assert.ok(
      emitted.has(metric),
      `Alert rule queries "${metric}" but the controller never emits it. ` +
        `Emitted: ${[...emitted].join(', ')}`,
    );
  }
});

test('every registered scenario has an implementation, a document and an id', () => {
  const registry = read('apps/scenario-controller/backend/src/scenarios/index.ts');
  const registered = [...registry.matchAll(/new (\w+Scenario)\(\)/g)].map((m) => m[1]);

  assert.equal(registered.length, 6, `expected 6 registered scenarios, found ${registered.length}`);

  const scenarioDir = join(repoRoot, 'apps/scenario-controller/backend/src/scenarios');
  const sources = readdirSync(scenarioDir).filter((f) => f.endsWith('.ts'));
  const combined = sources.map((f) => readFileSync(join(scenarioDir, f), 'utf8')).join('\n');

  for (const className of registered) {
    assert.ok(
      combined.includes(`class ${className}`),
      `${className} is registered but no class definition was found`,
    );
  }

  const ids = [...combined.matchAll(/readonly id = '(\d{2})'/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids, ['01', '02', '03', '04', '05', '06'], 'scenario IDs must be 01-06 and unique');

  const docs = readdirSync(join(repoRoot, 'docs/scenarios'));
  for (const id of ids) {
    assert.ok(
      docs.some((doc) => doc.startsWith(id)),
      `Scenario ${id} has no document in docs/scenarios/`,
    );
  }
});

test('every Kubernetes manifest placeholder is substituted by deploy.sh', () => {
  const deploy = read('scripts/deploy.sh');
  const manifestDir = join(repoRoot, 'k8s');

  const collect = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return collect(full);
      return entry.name.endsWith('.yaml') ? [full] : [];
    });

  const placeholders = new Set();
  for (const file of collect(manifestDir)) {
    const content = stripComments(readFileSync(file, 'utf8'));
    for (const match of content.matchAll(/__([A-Z0-9_]+)__/g)) {
      placeholders.add(match[1]);
    }
  }

  assert.ok(placeholders.size > 0, 'expected the manifests to contain placeholders');

  for (const placeholder of placeholders) {
    assert.ok(
      deploy.includes(`__${placeholder}__`),
      `Manifests use __${placeholder}__ but deploy.sh never substitutes it, ` +
        'so it would be applied to the cluster literally.',
    );
  }
});

test('scenario-runner endpoints called by the controller exist in the runner', () => {
  const client = read('apps/scenario-controller/backend/src/runner.ts');
  const server = read('services/scenario-runner/src/index.ts');

  const called = [...client.matchAll(/call<[^>]*>\('(GET|POST)', '([^']+)'/g)].map((m) => ({
    method: m[1],
    path: m[2],
  }));

  assert.ok(called.length > 0, 'expected the controller to call the runner');

  for (const { method, path } of called) {
    const handler = `app.${method.toLowerCase()}('${path}'`;
    assert.ok(
      server.includes(handler),
      `Controller calls ${method} ${path} but scenario-runner has no handler for it`,
    );
  }
});

test('lifecycle scripts referenced in the README exist and are executable shell', () => {
  const readme = read('README.md');
  const referenced = new Set(
    [...readme.matchAll(/scripts\/([a-z-]+\.(?:sh|ps1))/g)].map((m) => m[1]),
  );

  assert.ok(referenced.size > 0, 'README should reference the lifecycle scripts');

  for (const script of referenced) {
    assert.ok(existsSync(join(repoRoot, 'scripts', script)), `README references missing scripts/${script}`);
  }

  // Every Bash script must have a PowerShell counterpart, and vice versa.
  for (const name of ['deploy', 'validate', 'reset-lab', 'stop-lab', 'start-lab', 'destroy-lab']) {
    assert.ok(existsSync(join(repoRoot, 'scripts', `${name}.sh`)), `missing scripts/${name}.sh`);
    assert.ok(existsSync(join(repoRoot, 'scripts', `${name}.ps1`)), `missing scripts/${name}.ps1`);
  }
});

test('the disk scenario can never be configured to fill the disk completely', () => {
  const config = read('apps/scenario-controller/backend/src/config.ts');

  const maxPercent = Number(/maxPercent:\s*(\d+)/.exec(config)?.[1]);
  assert.ok(Number.isFinite(maxPercent), 'config must define disk.maxPercent');
  assert.ok(maxPercent < 100, `disk.maxPercent is ${maxPercent}; it must stay below 100`);
  assert.ok(maxPercent <= 95, `disk.maxPercent of ${maxPercent} leaves too little headroom`);

  const disk = read('apps/scenario-controller/backend/src/scenarios/disk.ts');
  assert.ok(
    disk.includes('Math.min(config.disk.targetPercent, config.disk.maxPercent)'),
    'the disk scenario must clamp its target to the hard ceiling',
  );
  assert.ok(disk.includes('guardBytes'), 'the disk scenario must enforce an absolute free-space floor');
});

test('database session termination is always filtered to this lab', () => {
  const db = read('apps/scenario-controller/backend/src/db.ts');

  const terminates = db.includes('pg_terminate_backend');
  assert.ok(terminates, 'expected a termination path to exist');

  // An unfiltered pg_terminate_backend would turn a partial incident into a
  // total outage, and could kill sessions this lab does not own.
  const filtered = /pg_terminate_backend\(pid\)[\s\S]{0,200}application_name LIKE 'sre-demo-scenario%'/.test(db);
  assert.ok(filtered, 'pg_terminate_backend must be filtered on application_name');
  assert.ok(db.includes('pid <> pg_backend_pid()'), 'termination must exclude the calling session');
});

test('the resource-burner cannot preempt application workloads', () => {
  const manifest = stripComments(read('k8s/resource-pressure/deployment.yaml'));

  assert.ok(manifest.includes('priorityClassName: sre-demo-low-priority'), 'burner must use the low priority class');
  assert.ok(manifest.includes('preemptionPolicy: Never'), 'burner must never preempt other pods');
  assert.match(manifest, /value:\s*-\d+/, 'burner priority value must be negative');
  assert.ok(manifest.includes('replicas: 0'), 'burner must be dormant at baseline');
});

test('scenario-runner RBAC is namespace-scoped and secret access is enumerated', () => {
  const rbac = stripComments(read('k8s/rbac/scenario-runner.yaml'));

  assert.ok(!rbac.includes('cluster-admin'), 'scenario-runner must never bind cluster-admin');
  assert.ok(rbac.includes('resourceNames:'), 'secret access must be restricted to named secrets');

  for (const verb of ['create', 'delete', 'deletecollection']) {
    assert.ok(
      !new RegExp(`verbs:.*["']${verb}["']`).test(rbac),
      `scenario-runner must not be granted the "${verb}" verb`,
    );
  }
});

test('Magic 8 Ball probes use HTTP so scenario 06 does not restart the pods', () => {
  const manifest = stripComments(read('k8s/magic8ball/deployment.yaml'));

  // If liveness used the HTTPS port, an expired certificate would cause a
  // CrashLoopBackOff and destroy the evidence scenario 06 depends on.
  const livenessBlock = /livenessProbe:[\s\S]*?failureThreshold: \d+/.exec(manifest)?.[0] ?? '';
  assert.ok(livenessBlock.includes('port: http'), 'liveness probe must target the HTTP port');

  const readinessBlock = /readinessProbe:[\s\S]*?failureThreshold: \d+/.exec(manifest)?.[0] ?? '';
  assert.ok(readinessBlock.includes('port: http'), 'readiness probe must target the HTTP port');
});
