// ---------------------------------------------------------------------------
// monitoring.bicep — Log Analytics workspace and workspace-based Application
// Insights.
//
// Everything the lab emits lands in a single workspace: application telemetry
// (AppRequests / AppDependencies / AppExceptions / AppMetrics / AppEvents),
// AKS Container Insights (Perf / KubePodInventory / ContainerLogV2) and VM
// guest data. That single pane is what makes the alert rules in alerts.bicep
// and an Azure SRE Agent investigation straightforward.
// ---------------------------------------------------------------------------

@description('Azure region for monitoring resources.')
param location string

@description('Common tags applied to every resource.')
param tags object

@description('Naming suffix that makes resource names unique.')
param suffix string

@description('Log Analytics retention in days. 30 is the free-tier default and is plenty for a demo.')
@minValue(30)
@maxValue(730)
param retentionInDays int = 30

@description('Daily ingestion cap in GB. -1 disables the cap. A small cap protects demo cost.')
param dailyQuotaGb int = 2

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-sre-demo-${suffix}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-sre-demo-${suffix}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    DisableLocalAuth: false
  }
}

@description('Data collection endpoint used by the Azure Monitor Agent on both lab VMs.')
resource dataCollectionEndpoint 'Microsoft.Insights/dataCollectionEndpoints@2022-06-01' = {
  name: 'dce-sre-demo-${suffix}'
  location: location
  tags: tags
  properties: {
    networkAcls: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

@description('Collects syslog and guest performance counters from the lab VMs into the workspace.')
resource vmDataCollectionRule 'Microsoft.Insights/dataCollectionRules@2022-06-01' = {
  name: 'dcr-sre-demo-vm-${suffix}'
  location: location
  tags: tags
  properties: {
    dataCollectionEndpointId: dataCollectionEndpoint.id
    dataSources: {
      performanceCounters: [
        {
          name: 'vmPerfCounters'
          streams: [
            'Microsoft-Perf'
          ]
          samplingFrequencyInSeconds: 60
          counterSpecifiers: [
            'Processor(*)\\% Processor Time'
            'Memory(*)\\% Used Memory'
            'Memory(*)\\Available MBytes Memory'
            'Logical Disk(*)\\% Used Space'
            'Logical Disk(*)\\Free Megabytes'
            'Logical Disk(*)\\Disk Read Bytes/sec'
            'Logical Disk(*)\\Disk Write Bytes/sec'
            'Network(*)\\Total Bytes Transmitted'
            'Network(*)\\Total Bytes Received'
          ]
        }
      ]
      syslog: [
        {
          name: 'vmSyslog'
          streams: [
            'Microsoft-Syslog'
          ]
          facilityNames: [
            'auth'
            'authpriv'
            'cron'
            'daemon'
            'kern'
            'local0'
            'syslog'
            'user'
          ]
          logLevels: [
            'Warning'
            'Error'
            'Critical'
            'Alert'
            'Emergency'
          ]
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          name: 'labWorkspace'
          workspaceResourceId: workspace.id
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Microsoft-Perf'
        ]
        destinations: [
          'labWorkspace'
        ]
      }
      {
        streams: [
          'Microsoft-Syslog'
        ]
        destinations: [
          'labWorkspace'
        ]
      }
    ]
  }
}

@description('Container Insights data collection rule.')
// Enabling the omsagent addon through ARM does NOT create this rule, unlike
// `az aks enable-addons`. With managed-identity auth the agent then runs
// happily but has nowhere to send data, so KubePodInventory, ContainerLogV2 and
// the K8SNode Perf counters all stay empty and the AKS alert rules can never
// fire. The rule and its association below are what actually turn Container
// Insights on.
resource containerInsightsRule 'Microsoft.Insights/dataCollectionRules@2022-06-01' = {
  name: 'dcr-sre-demo-ci-${suffix}'
  location: location
  tags: tags
  kind: 'Linux'
  properties: {
    dataSources: {
      extensions: [
        {
          name: 'ContainerInsightsExtension'
          streams: [
            'Microsoft-ContainerInsights-Group-Default'
          ]
          extensionName: 'ContainerInsights'
          extensionSettings: {
            dataCollectionSettings: {
              interval: '1m'
              namespaceFilteringMode: 'Off'
              enableContainerLogV2: true
            }
          }
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          name: 'ciWorkspace'
          workspaceResourceId: workspace.id
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Microsoft-ContainerInsights-Group-Default'
        ]
        destinations: [
          'ciWorkspace'
        ]
      }
    ]
  }
}

output workspaceId string = workspace.id
output workspaceName string = workspace.name
output workspaceCustomerId string = workspace.properties.customerId
output appInsightsId string = appInsights.id
output appInsightsName string = appInsights.name
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output appInsightsAppId string = appInsights.properties.AppId
output dataCollectionRuleId string = vmDataCollectionRule.id
output dataCollectionEndpointId string = dataCollectionEndpoint.id
output containerInsightsRuleId string = containerInsightsRule.id
