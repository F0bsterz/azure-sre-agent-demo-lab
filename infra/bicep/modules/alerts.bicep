// ---------------------------------------------------------------------------
// alerts.bicep — Azure Monitor scheduled query alerts, one per scenario.
//
// Every rule is scoped to the single Log Analytics workspace, because the
// workspace-based Application Insights component and AKS Container Insights
// both land there. That gives an investigating agent one correlated dataset
// covering application, container and infrastructure signal.
//
// Evaluation is every 5 minutes over a 10 minute window. That is deliberately
// short so an incident becomes visible during a live demo instead of half an
// hour later, and it is the practical floor once Container Insights ingestion
// latency is taken into account.
//
// skipQueryValidation is required: at deployment time the workspace is empty,
// so tables such as AppMetrics and Perf do not exist yet and validation of an
// otherwise correct query would fail the deployment.
// ---------------------------------------------------------------------------

@description('Azure region for the alert rules.')
param location string

@description('Common tags applied to every resource.')
param tags object

@description('Naming suffix that makes resource names unique.')
param suffix string

@description('Resource ID of the Log Analytics workspace all rules query.')
param workspaceId string

@description('Disk utilisation percentage that constitutes an incident.')
param diskThresholdPercent int = 85

@description('AKS node CPU/memory utilisation percentage that constitutes capacity pressure.')
param nodePressureThresholdPercent int = 80

@description('Magic 8 Ball HTTP failure percentage that constitutes a bad deployment.')
param failureRateThresholdPercent int = 20

@description('PostgreSQL connection utilisation percentage that constitutes exhaustion.')
param connectionThresholdPercent int = 80

@description('How often each rule is evaluated.')
param evaluationFrequency string = 'PT5M'

@description('Lookback window each evaluation considers.')
param windowSize string = 'PT10M'

var diskQuery = '''
let custom = AppMetrics
    | where Name == "sre_demo_disk_percent_used"
    | extend Value = iif(ItemCount > 0, Sum / ItemCount, Sum)
    | project TimeGenerated, Computer = tostring(Properties["host"]), Value;
let guest = Perf
    | where ObjectName == "Logical Disk" and CounterName == "% Used Space"
    | where InstanceName startswith "/var/sre-demo"
    | project TimeGenerated, Computer, Value = CounterValue;
union custom, guest
| summarize DiskPercentUsed = max(Value)
'''

var nodePressureQuery = '''
let cpuCapacity = Perf
    | where ObjectName == "K8SNode" and CounterName == "cpuCapacityNanoCores"
    | summarize Capacity = max(CounterValue) by Computer;
let cpuUsage = Perf
    | where ObjectName == "K8SNode" and CounterName == "cpuUsageNanoCores"
    | summarize Used = avg(CounterValue) by Computer;
let memCapacity = Perf
    | where ObjectName == "K8SNode" and CounterName == "memoryCapacityBytes"
    | summarize Capacity = max(CounterValue) by Computer;
let memUsage = Perf
    | where ObjectName == "K8SNode" and CounterName == "memoryWorkingSetBytes"
    | summarize Used = avg(CounterValue) by Computer;
let cpuPct = cpuUsage
    | join kind=inner cpuCapacity on Computer
    | where Capacity > 0
    | project Computer, Pct = 100.0 * Used / Capacity, Resource = "cpu";
let memPct = memUsage
    | join kind=inner memCapacity on Computer
    | where Capacity > 0
    | project Computer, Pct = 100.0 * Used / Capacity, Resource = "memory";
union cpuPct, memPct
| summarize NodePressurePercent = max(Pct)
'''

var pendingPodsQuery = '''
KubePodInventory
| where Namespace == "sre-demo"
| summarize arg_max(TimeGenerated, PodStatus) by Name
| summarize PendingPods = countif(PodStatus == "Pending")
'''

var failureRateQuery = '''
AppRequests
| where AppRoleName has "magic8ball"
| summarize Total = count(), Failed = countif(Success == false or toint(ResultCode) >= 500)
| where Total >= 5
| project FailurePercent = 100.0 * Failed / Total
'''

var connectionQuery = '''
AppMetrics
| where Name == "sre_demo_postgres_connection_percent"
| extend Value = iif(ItemCount > 0, Sum / ItemCount, Sum)
| summarize ConnectionPercent = max(Value)
'''

var connectivityQuery = '''
let probe = AppMetrics
    | where Name == "sre_demo_postgres_connectivity"
    | extend Value = iif(ItemCount > 0, Sum / ItemCount, Sum)
    | summarize Failures = countif(Value < 1);
let deps = AppDependencies
    | where DependencyType has "postgre" or Target has "postgres" or Name has "postgres"
    | summarize Failures = countif(Success == false);
union probe, deps
| summarize FailedProbes = sum(Failures)
'''

var tlsQuery = '''
AppMetrics
| where Name == "sre_demo_magic8ball_tls_valid"
| extend Value = iif(ItemCount > 0, Sum / ItemCount, Sum)
| summarize FailedTlsChecks = countif(Value < 1)
'''

var alertDefinitions = [
  {
    key: '01-disk-capacity'
    displayName: 'SRE Demo 01 - App VM demo disk capacity'
    description: 'The dedicated demo data disk on the App VM (/var/sre-demo) is above the capacity threshold. Expected root cause: runaway application logging.'
    severity: 2
    query: diskQuery
    measureColumn: 'DiskPercentUsed'
    operator: 'GreaterThan'
    threshold: diskThresholdPercent
  }
  {
    key: '02-aks-node-pressure'
    displayName: 'SRE Demo 02 - AKS node resource pressure'
    description: 'AKS node CPU or memory utilisation is high. Expected remediation: scale the system node pool above the baseline.'
    severity: 2
    query: nodePressureQuery
    measureColumn: 'NodePressurePercent'
    operator: 'GreaterThan'
    threshold: nodePressureThresholdPercent
  }
  {
    key: '02-aks-pending-pods'
    displayName: 'SRE Demo 02 - AKS pods cannot be scheduled'
    description: 'One or more pods in the sre-demo namespace are Pending, indicating insufficient allocatable node capacity.'
    severity: 2
    query: pendingPodsQuery
    measureColumn: 'PendingPods'
    operator: 'GreaterThanOrEqual'
    threshold: 1
  }
  {
    key: '03-http-failure-rate'
    displayName: 'SRE Demo 03 - Magic 8 Ball HTTP failure rate'
    description: 'Magic 8 Ball is returning server errors above the acceptable rate. Correlate with the deployed image tag and commit SHA in /api/version telemetry.'
    severity: 1
    query: failureRateQuery
    measureColumn: 'FailurePercent'
    operator: 'GreaterThan'
    threshold: failureRateThresholdPercent
  }
  {
    key: '04-postgres-connections'
    displayName: 'SRE Demo 04 - PostgreSQL connection utilisation'
    description: 'PostgreSQL connection usage is approaching max_connections. Expected root cause: a client leaking connections.'
    severity: 1
    query: connectionQuery
    measureColumn: 'ConnectionPercent'
    operator: 'GreaterThan'
    threshold: connectionThresholdPercent
  }
  {
    key: '05-postgres-connectivity'
    displayName: 'SRE Demo 05 - PostgreSQL dependency failures'
    description: 'Repeated failures reaching PostgreSQL on TCP 5432 while the database service itself is healthy. Check NSG rules on the database subnet.'
    severity: 1
    query: connectivityQuery
    measureColumn: 'FailedProbes'
    operator: 'GreaterThanOrEqual'
    threshold: 2
  }
  {
    key: '06-tls-certificate'
    displayName: 'SRE Demo 06 - Magic 8 Ball TLS validation failing'
    description: 'Synthetic HTTPS checks against Magic 8 Ball fail TLS validation while pods remain healthy. Check server certificate validity dates.'
    severity: 1
    query: tlsQuery
    measureColumn: 'FailedTlsChecks'
    operator: 'GreaterThanOrEqual'
    threshold: 1
  }
]

resource rules 'Microsoft.Insights/scheduledQueryRules@2022-06-15' = [for definition in alertDefinitions: {
  name: 'sre-demo-${definition.key}-${suffix}'
  location: location
  tags: tags
  properties: {
    displayName: definition.displayName
    description: definition.description
    severity: definition.severity
    enabled: true
    scopes: [
      workspaceId
    ]
    evaluationFrequency: evaluationFrequency
    windowSize: windowSize
    autoMitigate: true
    skipQueryValidation: true
    checkWorkspaceAlertsStorageConfigured: false
    criteria: {
      allOf: [
        {
          query: definition.query
          timeAggregation: 'Average'
          metricMeasureColumn: definition.measureColumn
          operator: definition.operator
          threshold: definition.threshold
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
  }
}]

output alertRuleNames array = [for (definition, i) in alertDefinitions: rules[i].name]
