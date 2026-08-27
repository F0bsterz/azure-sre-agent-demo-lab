// ---------------------------------------------------------------------------
// security.bicep — user-assigned managed identity and Key Vault.
//
// The App VM runs the Scenario Controller, which must call the Azure control
// plane to add/remove the scenario 05 NSG rule and to scale the AKS node pool
// for scenario 02. It does that with this identity — no service principal
// secret, no client secret in source, nothing to rotate.
//
// Purge protection is intentionally left off so scripts/destroy-lab.sh can
// fully remove the lab and a later redeploy can reuse the same vault name.
// ---------------------------------------------------------------------------

@description('Azure region for security resources.')
param location string

@description('Common tags applied to every resource.')
param tags object

@description('Naming suffix that makes resource names unique.')
param suffix string

resource labIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-sre-demo-${suffix}'
  location: location
  tags: tags
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-sredemo-${suffix}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enabledForDeployment: false
    enabledForTemplateDeployment: true
    enabledForDiskEncryption: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

output identityId string = labIdentity.id
output identityName string = labIdentity.name
output identityPrincipalId string = labIdentity.properties.principalId
output identityClientId string = labIdentity.properties.clientId
output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
