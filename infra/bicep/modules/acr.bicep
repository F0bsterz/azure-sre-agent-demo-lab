// ---------------------------------------------------------------------------
// acr.bicep — Basic-tier Azure Container Registry for the lab images.
//
// The admin account stays disabled: AKS and the App VM both pull with Entra ID
// identities through AcrPull role assignments, so no registry password exists
// to leak.
// ---------------------------------------------------------------------------

@description('Azure region for the registry.')
param location string

@description('Common tags applied to every resource.')
param tags object

@description('Naming suffix that makes resource names unique.')
param suffix string

@description('Registry SKU. Basic is sufficient for the lab image set.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param sku string = 'Basic'

var registryName = 'acrsredemo${replace(suffix, '-', '')}'

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: sku
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
    zoneRedundancy: 'Disabled'
  }
}

output registryId string = registry.id
output registryName string = registry.name
output loginServer string = registry.properties.loginServer
