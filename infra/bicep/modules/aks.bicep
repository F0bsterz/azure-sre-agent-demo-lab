// ---------------------------------------------------------------------------
// aks.bicep — one very small AKS cluster for Magic 8 Ball and scenario-runner.
//
// The cluster autoscaler is deliberately DISABLED. Scenario 02 creates genuine
// capacity pressure, and the expected remediation is an explicit node-pool
// scale from the baseline (1) to 2. An autoscaler would silently fix the
// incident and there would be nothing to investigate.
//
// The node SKU and Kubernetes version are parameters, resolved to currently
// available values by scripts/deploy.sh — nothing here is pinned to a patch
// version or to a SKU that may not exist in the caller's region.
// ---------------------------------------------------------------------------

@description('Azure region for the cluster.')
param location string

@description('Common tags applied to every resource.')
param tags object

@description('Naming suffix that makes resource names unique.')
param suffix string

@description('Resource ID of the subnet hosting AKS nodes.')
param subnetId string

@description('Resource ID of the Log Analytics workspace backing Container Insights.')
param workspaceId string

@description('System node pool VM size. Validated for regional availability by the deploy script.')
param nodeVmSize string = 'Standard_D2as_v7'

@description('Baseline node count the lab returns to after scenario 02 is reset.')
@minValue(1)
@maxValue(5)
param baselineNodeCount int = 1

@description('Kubernetes version. Leave empty to accept the current AKS default for the region.')
param kubernetesVersion string = ''

@description('OS disk size for cluster nodes.')
@minValue(30)
@maxValue(256)
param nodeOsDiskSizeGb int = 64

var clusterName = 'aks-sre-demo-${suffix}'

resource aks 'Microsoft.ContainerService/managedClusters@2024-05-01' = {
  name: clusterName
  location: location
  tags: tags
  sku: {
    name: 'Base'
    tier: 'Free'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    dnsPrefix: 'sre-demo-${suffix}'
    kubernetesVersion: empty(kubernetesVersion) ? null : kubernetesVersion
    nodeResourceGroup: 'rg-sre-demo-aks-nodes-${suffix}'
    enableRBAC: true
    disableLocalAccounts: false
    agentPoolProfiles: [
      {
        name: 'system'
        mode: 'System'
        count: baselineNodeCount
        vmSize: nodeVmSize
        osType: 'Linux'
        osSKU: 'Ubuntu'
        osDiskSizeGB: nodeOsDiskSizeGb
        osDiskType: 'Managed'
        type: 'VirtualMachineScaleSets'
        vnetSubnetID: subnetId
        maxPods: 60
        enableAutoScaling: false
        tags: tags
      }
    ]
    networkProfile: {
      networkPlugin: 'azure'
      networkPluginMode: 'overlay'
      loadBalancerSku: 'standard'
      outboundType: 'loadBalancer'
      podCidr: '10.244.0.0/16'
      serviceCidr: '10.0.0.0/16'
      dnsServiceIP: '10.0.0.10'
    }
    addonProfiles: {
      omsagent: {
        enabled: true
        config: {
          logAnalyticsWorkspaceResourceID: workspaceId
          useAADAuth: 'true'
        }
      }
    }
    autoUpgradeProfile: {
      upgradeChannel: 'none'
      nodeOSUpgradeChannel: 'NodeImage'
    }
    oidcIssuerProfile: {
      enabled: false
    }
    storageProfile: {
      diskCSIDriver: {
        enabled: true
      }
      fileCSIDriver: {
        enabled: false
      }
      snapshotController: {
        enabled: false
      }
    }
  }
}

output clusterName string = aks.name
output clusterId string = aks.id
output nodeResourceGroup string = aks.properties.nodeResourceGroup
output kubeletIdentityObjectId string = aks.properties.identityProfile.kubeletidentity.objectId
output clusterPrincipalId string = aks.identity.principalId
output kubernetesVersion string = aks.properties.kubernetesVersion
output nodeVmSize string = nodeVmSize
output baselineNodeCount int = baselineNodeCount
output systemNodePoolName string = 'system'
