// -----------------------------------------------------------------------------
// Azure SRE Agent (Microsoft.App/agents).
//
// Optional. main.bicep only instantiates this module when deploySreAgent is
// true, because the agent is a chargeable managed service and is not available
// in every region the rest of the lab can run in.
//
// The agent is given a system-assigned identity but NO role assignments here.
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

param tags object = {}

resource agent 'Microsoft.App/agents@2026-01-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    upgradeChannel: upgradeChannel
    actionConfiguration: {
      mode: mode
      accessLevel: accessLevel
    }
    logConfiguration: {
      applicationInsightsConfiguration: {
        appId: appInsightsAppId
        connectionString: appInsightsConnectionString
      }
    }
  }
}

output agentName string = agent.name
output agentId string = agent.id
output agentLocation string = agent.location
output agentMode string = mode

// Consumed by scripts/enable-sre-remediation.sh to scope RBAC to this agent.
output principalId string = agent.identity.principalId
