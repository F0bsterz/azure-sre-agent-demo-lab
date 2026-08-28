// -----------------------------------------------------------------------------
// Azure SRE Agent (Microsoft.App/agents).
//
// Optional. main.bicep only instantiates this module when deploySreAgent is
// true, because the agent is a chargeable managed service and is not available
// in every region the rest of the lab can run in.
//
// The agent is given its own managed identity but NO role assignments here.
// Investigation needs read access and remediation needs write access, and both
// are granted deliberately by scripts/enable-sre-remediation.sh rather than as
// a side effect of deploying a demo.
// -----------------------------------------------------------------------------

@description('Agent name. Must start with a letter and be 2-32 characters of letters, digits and hyphens.')
@minLength(2)
@maxLength(32)
param name string

@description('Region for the agent. Not every Azure region offers SRE Agent, so this is separate from the lab location.')
param location string

@description('How the agent may act. Review pauses for human approval before every remediation, Autonomous acts unattended, ReadOnly investigates only.')
@allowed([
  'ReadOnly'
  'Review'
  'Autonomous'
])
param mode string = 'Review'

@description('Breadth of action the agent may take. Low is the conservative default.')
@allowed([
  'Low'
  'High'
])
param accessLevel string = 'Low'

@description('Stable tracks generally available agent behaviour; Preview opts into newer capability.')
@allowed([
  'Stable'
  'Preview'
])
param upgradeChannel string = 'Stable'

@description('Application Insights AppId the agent reads telemetry from.')
param appInsightsAppId string

@description('Application Insights connection string the agent reads telemetry from.')
@secure()
param appInsightsConnectionString string

@description('Object ID of the principal running the deployment. Granted SRE Agent Administrator so the agent UI is reachable. Empty skips the assignment.')
param deployerObjectId string = ''

param tags object = {}

// The agent's actions run as a managed identity, and ARM rejects the agent
// unless actionConfiguration.identity names one that is attached to it. A
// system-assigned identity cannot be referenced at creation time, so the agent
// gets its own user-assigned identity.
//
// It is deliberately NOT the lab identity, which already holds Contributor on
// the resource group: reusing it would hand the agent write access as a side
// effect of deploying. This one starts with no role assignments at all.
resource agentIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${name}'
  location: location
  tags: tags
}

resource agent 'Microsoft.App/agents@2026-01-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    // Both are required. The user-assigned identity carries connector auth and
    // Azure RBAC; the system-assigned one backs the agent's own infrastructure,
    // which is what the portal wizard provisions.
    type: 'SystemAssigned,UserAssigned'
    userAssignedIdentities: {
      '${agentIdentity.id}': {}
    }
  }
  properties: {
    upgradeChannel: upgradeChannel
    actionConfiguration: {
      mode: mode
      accessLevel: accessLevel
      identity: agentIdentity.id
    }
    logConfiguration: {
      applicationInsightsConfiguration: {
        appId: appInsightsAppId
        connectionString: appInsightsConnectionString
      }
    }
  }
}

// Owner on the subscription does not grant access to the agent itself: the agent
// UI is a data plane with its own roles, so without this the agent deploys but
// cannot be opened, and the UI reports a misleading cold-start error.
var sreAgentAdministratorRoleId = 'e79298df-d852-4c6d-84f9-5d13249d1e55'

resource deployerAgentAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployerObjectId)) {
  name: guid(agent.id, deployerObjectId, sreAgentAdministratorRoleId)
  scope: agent
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', sreAgentAdministratorRoleId)
    principalId: deployerObjectId
    description: 'Lets the deploying user open and operate the agent. Control-plane Owner does not cover the agent data plane.'
  }
}

output agentName string = agent.name
output agentId string = agent.id
output agentLocation string = agent.location
output agentMode string = mode
output agentEndpoint string = agent.properties.agentEndpoint

// Consumed by scripts/enable-sre-remediation.sh to scope RBAC to this agent.
output principalId string = agentIdentity.properties.principalId
output identityId string = agentIdentity.id
