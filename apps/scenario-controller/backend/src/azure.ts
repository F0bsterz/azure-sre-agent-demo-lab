/**
 * Azure control-plane access using the App VM's user-assigned managed identity.
 *
 * Tokens come from IMDS and calls go straight to ARM over REST. That avoids
 * pulling several megabytes of Azure SDK into the runtime image for what is
 * ultimately three operations: read/write one NSG rule, and read/scale one AKS
 * node pool. It also means there is no client secret anywhere in the lab.
 */

import { config } from './config.js';
import { log, errorFields } from './logger.js';

const IMDS_ENDPOINT = 'http://169.254.169.254/metadata/identity/oauth2/token';
const ARM = 'https://management.azure.com';
const NETWORK_API = '2023-11-01';
const AKS_API = '2024-05-01';

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

async function getToken(resource: string): Promise<string> {
  const cached = tokenCache.get(resource);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const url = new URL(IMDS_ENDPOINT);
  url.searchParams.set('api-version', '2018-02-01');
  url.searchParams.set('resource', resource);
  if (config.azure.managedIdentityClientId) {
    url.searchParams.set('client_id', config.azure.managedIdentityClientId);
  }

  const response = await fetch(url, {
    headers: { Metadata: 'true' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`IMDS token request failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { access_token: string; expires_on: string };
  const expiresAt = Number.parseInt(body.expires_on, 10) * 1000;
  tokenCache.set(resource, { token: body.access_token, expiresAt });
  return body.access_token;
}

async function arm<T>(method: string, path: string, apiVersion: string, body?: unknown): Promise<T> {
  const token = await getToken(`${ARM}/`);
  const url = `${ARM}${path}${path.includes('?') ? '&' : '?'}api-version=${apiVersion}`;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ARM ${method} ${path} failed: ${response.status} ${text.slice(0, 800)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export function azureConfigured(): boolean {
  return Boolean(config.azure.subscriptionId && config.azure.resourceGroup);
}

const rgPath = () =>
  `/subscriptions/${config.azure.subscriptionId}/resourceGroups/${config.azure.resourceGroup}`;

// --- Scenario 05: the database NSG deny rule -------------------------------

export interface NsgRuleState {
  present: boolean;
  provisioningState?: string;
  priority?: number;
  access?: string;
}

const denyRulePath = () =>
  `${rgPath()}/providers/Microsoft.Network/networkSecurityGroups/${config.network.databaseNsgName}` +
  `/securityRules/${config.network.denyRuleName}`;

export async function getDenyRule(): Promise<NsgRuleState> {
  try {
    const rule = await arm<{ properties: { provisioningState: string; priority: number; access: string } }>(
      'GET',
      denyRulePath(),
      NETWORK_API,
    );
    return {
      present: true,
      provisioningState: rule.properties.provisioningState,
      priority: rule.properties.priority,
      access: rule.properties.access,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes(': 404')) return { present: false };
    throw error;
  }
}

/**
 * Blocks ONLY TCP 5432 into the database subnet from the demo workload subnets.
 * SSH, the controller's own management traffic and every other flow are
 * untouched, which is what keeps the lab resettable while the fault is active.
 */
export async function createDenyRule(): Promise<void> {
  await arm('PUT', denyRulePath(), NETWORK_API, {
    properties: {
      description:
        'SRE demo scenario 05. Blocks PostgreSQL (TCP 5432) from the application and AKS subnets. Injected by the Scenario Controller; removed on reset.',
      protocol: 'Tcp',
      sourcePortRange: '*',
      destinationPortRange: '5432',
      sourceAddressPrefixes: [config.network.appSubnetPrefix, config.network.aksSubnetPrefix],
      destinationAddressPrefix: '*',
      access: 'Deny',
      priority: config.network.denyRulePriority,
      direction: 'Inbound',
    },
  });
  log.info('nsg deny rule created', { rule: config.network.denyRuleName });
}

export async function deleteDenyRule(): Promise<void> {
  try {
    await arm('DELETE', denyRulePath(), NETWORK_API);
    log.info('nsg deny rule removed', { rule: config.network.denyRuleName });
  } catch (error) {
    if (error instanceof Error && error.message.includes(': 404')) return;
    throw error;
  }
}

// --- Scenario 02: AKS node pool capacity -----------------------------------

export interface NodePoolState {
  count: number;
  vmSize: string;
  provisioningState: string;
  powerState?: string;
}

const nodePoolPath = () =>
  `${rgPath()}/providers/Microsoft.ContainerService/managedClusters/${config.aks.clusterName}` +
  `/agentPools/${config.aks.nodePool}`;

export async function getNodePool(): Promise<NodePoolState> {
  const pool = await arm<{
    properties: { count: number; vmSize: string; provisioningState: string; powerState?: { code: string } };
  }>('GET', nodePoolPath(), AKS_API);
  return {
    count: pool.properties.count,
    vmSize: pool.properties.vmSize,
    provisioningState: pool.properties.provisioningState,
    powerState: pool.properties.powerState?.code,
  };
}

/**
 * Scales the system node pool. Refuses to go below the configured baseline so a
 * reset can never leave the lab smaller — and therefore more broken — than it
 * started.
 */
export async function scaleNodePool(desiredCount: number): Promise<NodePoolState> {
  const baseline = config.aks.baselineNodeCount;
  const target = Math.max(baseline, Math.min(desiredCount, 5));
  const current = await getNodePool();
  if (current.count === target) return current;

  const existing = await arm<Record<string, any>>('GET', nodePoolPath(), AKS_API);
  existing['properties']['count'] = target;
  await arm('PUT', nodePoolPath(), AKS_API, { properties: existing['properties'] });
  log.info('aks node pool scale requested', { from: current.count, to: target });
  return { ...current, count: target, provisioningState: 'Updating' };
}

// --- Key Vault -------------------------------------------------------------

export async function readSecret(name: string): Promise<string | undefined> {
  if (!config.azure.keyVaultName) return undefined;
  try {
    const token = await getToken('https://vault.azure.net');
    const response = await fetch(
      `https://${config.azure.keyVaultName}.vault.azure.net/secrets/${name}?api-version=7.4`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as { value: string };
    return body.value;
  } catch (error) {
    log.warn('key vault secret read failed', { name, ...errorFields(error) });
    return undefined;
  }
}
