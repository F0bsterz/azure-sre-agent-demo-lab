// ---------------------------------------------------------------------------
// rbac.bicep — role assignments for the lab, scoped to this resource group.
//
// This lives in its own module for a concrete Bicep reason: a role assignment
// name must be resolvable at the start of a deployment, but principal IDs of
// the managed identity and the AKS kubelet identity are only known once those
// resources exist. Passing them as module parameters makes them known at the
// start of THIS nested deployment, which is the supported way to satisfy
// BCP120 without pre-computing GUIDs by hand.
//
// Scope discipline: Contributor is granted on the demo resource group only.
// Nothing in this lab is granted at subscription scope.
// ---------------------------------------------------------------------------

@description('Name of the lab container registry.')
param acrName string

@description('Name of the lab key vault.')
param keyVaultName string

@description('Principal ID of the user-assigned identity used by the App VM.')
param labIdentityPrincipalId string

@description('Object ID of the AKS kubelet identity that pulls images from ACR.')
param kubeletIdentityObjectId string

@description('Object ID of the principal running the deployment. Empty skips the Key Vault Secrets Officer grant.')
param deployerObjectId string = ''

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var monitoringMetricsPublisherRoleId = '3913510d-42f4-4e42-8a64-420c390055eb'

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: acrName
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource labIdentityAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, labIdentityPrincipalId, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: labIdentityPrincipalId
    principalType: 'ServicePrincipal'
    description: 'App VM pulls the scenario-controller image with a managed identity instead of a registry password.'
  }
}

resource kubeletAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, kubeletIdentityObjectId, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: kubeletIdentityObjectId
    principalType: 'ServicePrincipal'
    description: 'AKS pulls lab images with its kubelet identity instead of an imagePullSecret.'
  }
}

resource labIdentityContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, labIdentityPrincipalId, contributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
    principalId: labIdentityPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Scenario Controller adds/removes the scenario 05 NSG rule and scales the AKS node pool for scenario 02. Demo resource group scope only.'
  }
}

resource labIdentityMetricsPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, labIdentityPrincipalId, monitoringMetricsPublisherRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringMetricsPublisherRoleId)
    principalId: labIdentityPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Allows the Azure Monitor Agent on the lab VMs to publish guest telemetry.'
  }
}

resource labIdentityKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, labIdentityPrincipalId, keyVaultSecretsUserRoleId)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: labIdentityPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Scenario Controller reads the PostgreSQL credentials at runtime rather than holding them in configuration.'
  }
}

resource deployerKvSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployerObjectId)) {
  name: guid(vault.id, deployerObjectId, keyVaultSecretsOfficerRoleId)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficerRoleId)
    principalId: deployerObjectId
    description: 'Lets the deploy script write generated credentials into the lab key vault.'
  }
}
