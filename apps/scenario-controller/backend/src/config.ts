/**
 * Runtime configuration for the Scenario Controller.
 *
 * Everything arrives from the environment, which scripts/deploy.sh renders from
 * live Bicep outputs. There are no baked-in subscription, tenant, region or
 * resource identifiers, so the same image runs unchanged in any subscription.
 */

import { readFileSync } from 'node:fs';

function str(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * PEM material is supplied as a mounted file rather than an environment
 * variable: multi-line values do not survive `docker run -e` or an env file
 * cleanly. DEMO_CA_CERT remains supported for local development.
 */
function pem(fileVar: string, inlineVar: string): string {
  const path = process.env[fileVar];
  if (path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  }
  return str(inlineVar);
}

export const config = {
  port: int('PORT', 8080),
  labSuffix: str('LAB_SUFFIX', 'local'),
  environmentName: str('LAB_ENVIRONMENT', 'demo'),

  azure: {
    subscriptionId: str('AZURE_SUBSCRIPTION_ID'),
    resourceGroup: str('AZURE_RESOURCE_GROUP'),
    location: str('AZURE_LOCATION'),
    /** Client ID of the user-assigned identity attached to the App VM. */
    managedIdentityClientId: str('AZURE_CLIENT_ID'),
    keyVaultName: str('KEY_VAULT_NAME'),
  },

  telemetry: {
    connectionString: str('APPLICATIONINSIGHTS_CONNECTION_STRING'),
    roleName: str('OTEL_SERVICE_NAME', 'scenario-controller'),
    /** How often the synthetic probe loop runs. Short, so a demo shows movement. */
    probeIntervalMs: int('PROBE_INTERVAL_MS', 20_000),
  },

  postgres: {
    host: str('PGHOST'),
    port: int('PGPORT', 5432),
    database: str('PGDATABASE', 'sre_demo'),
    user: str('PGUSER', 'sre_app'),
    password: str('PGPASSWORD'),
    scenarioUser: str('SCENARIO_PGUSER', 'sre_scenario'),
    scenarioPassword: str('SCENARIO_PGPASSWORD'),
    maxConnections: int('POSTGRES_MAX_CONNECTIONS', 50),
    /** Keep the controller's own pool tiny: it must survive scenario 04. */
    poolSize: int('PG_POOL_SIZE', 2),
    connectTimeoutMs: int('PG_CONNECT_TIMEOUT_MS', 4000),
  },

  disk: {
    mountPath: str('DEMO_MOUNT_PATH', '/var/sre-demo'),
    logDir: str('DEMO_LOG_DIR', '/var/sre-demo/logs'),
    stateDir: str('DEMO_STATE_DIR', '/var/sre-demo/state'),
    /** Hard ceiling for scenario 01. Never 100: the disk must stay recoverable. */
    targetPercent: int('DISK_SCENARIO_TARGET_PERCENT', 88),
    /** Absolute safety net regardless of configuration. */
    maxPercent: 92,
    /**
     * Represents historic logs that were never rotated. Allocated instantly, so
     * the disk starts the incident already under pressure and the runaway
     * logger only has to write the remainder — which is what keeps the scenario
     * inside a demo-length window instead of the ~40 minutes a full 16 GB fill
     * would take at disk throughput.
     */
    ballastPercent: int('DISK_SCENARIO_BALLAST_PERCENT', 75),
    chunkBytes: int('DISK_SCENARIO_CHUNK_BYTES', 16 * 1024 * 1024),
    writeIntervalMs: int('DISK_SCENARIO_INTERVAL_MS', 250),
  },

  aks: {
    clusterName: str('AKS_CLUSTER_NAME'),
    nodePool: str('AKS_NODE_POOL', 'system'),
    baselineNodeCount: int('AKS_BASELINE_NODE_COUNT', 1),
    namespace: str('K8S_NAMESPACE', 'sre-demo'),
  },

  network: {
    databaseNsgName: str('DB_NSG_NAME'),
    denyRuleName: 'sre-demo-deny-postgres',
    denyRulePriority: int('DENY_RULE_PRIORITY', 100),
    appSubnetPrefix: str('APP_SUBNET_PREFIX', '10.20.1.0/24'),
    aksSubnetPrefix: str('AKS_SUBNET_PREFIX', '10.20.3.0/24'),
  },

  runner: {
    /** Internal (private) address of scenario-runner inside AKS. */
    url: str('SCENARIO_RUNNER_URL'),
    token: str('SCENARIO_RUNNER_TOKEN'),
    timeoutMs: int('SCENARIO_RUNNER_TIMEOUT_MS', 20_000),
  },

  magic8ball: {
    httpUrl: str('MAGIC8BALL_HTTP_URL'),
    httpsUrl: str('MAGIC8BALL_HTTPS_URL'),
    /** PEM of the demo CA so a TLS failure is attributable to expiry, not to an unknown issuer. */
    caCertificate: pem('DEMO_CA_CERT_FILE', 'DEMO_CA_CERT'),
    stableImage: str('MAGIC8BALL_STABLE_IMAGE'),
    badImage: str('MAGIC8BALL_BAD_IMAGE'),
  },

  scenarios: {
    timeoutMinutes: int('SCENARIO_TIMEOUT_MINUTES', 60),
    allowConcurrent: bool('ALLOW_CONCURRENT_SCENARIOS', false),
    /** Connection leak stops here so administrative sessions remain possible. */
    postgresLeakHeadroom: int('POSTGRES_LEAK_HEADROOM', 6),
  },
} as const;

export type AppConfig = typeof config;

/** Tags stamped onto everything a scenario creates, so cleanup is unambiguous. */
export const SCENARIO_RESOURCE_TAGS = {
  'sre-demo-scenario': 'true',
} as const;
