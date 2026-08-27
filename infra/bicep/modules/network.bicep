// ---------------------------------------------------------------------------
// network.bicep — VNet, subnets and NSGs for the SRE Agent demo lab.
//
// The database NSG is deliberately explicit: an ALLOW list plus a catch-all
// DENY for VNet traffic. Scenario 05 injects "sre-demo-deny-postgres" at a
// higher priority than the allows, which is what makes that fault detectable
// as a configuration change rather than a service failure.
// ---------------------------------------------------------------------------

@description('Azure region for all networking resources.')
param location string

@description('Common tags applied to every resource.')
param tags object

@description('Naming suffix that makes resource names unique.')
param suffix string

@description('CIDRs permitted to reach SSH, the Scenario Controller UI and Magic 8 Ball. Supply every address that needs access: the machine running the deployment is not necessarily the machine the operator browses from.')
param adminCidrs array

@description('Address space of the lab virtual network.')
param vnetAddressPrefix string = '10.20.0.0/16'

@description('Application / Scenario Controller subnet prefix.')
param appSubnetPrefix string = '10.20.1.0/24'

@description('PostgreSQL subnet prefix.')
param databaseSubnetPrefix string = '10.20.2.0/24'

@description('AKS node subnet prefix.')
param aksSubnetPrefix string = '10.20.3.0/24'

@description('Port the Scenario Controller listens on.')
param controllerPort int = 8080

var appNsgName = 'nsg-app-${suffix}'
var dbNsgName = 'nsg-db-${suffix}'
var aksNsgName = 'nsg-aks-${suffix}'
var vnetName = 'vnet-sre-demo-${suffix}'

resource appNsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: appNsgName
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'Allow-SSH-Admin'
        properties: {
          description: 'Administrative SSH, restricted to the administrator CIDRs.'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '22'
          sourceAddressPrefixes: adminCidrs
          destinationAddressPrefix: '*'
          access: 'Allow'
          priority: 200
          direction: 'Inbound'
        }
      }
      {
        name: 'Allow-Controller-UI-Admin'
        properties: {
          description: 'Scenario Controller web UI and API, restricted to the administrator CIDRs.'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: string(controllerPort)
          sourceAddressPrefixes: adminCidrs
          destinationAddressPrefix: '*'
          access: 'Allow'
          priority: 210
          direction: 'Inbound'
        }
      }
    ]
  }
}

resource dbNsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: dbNsgName
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'Allow-Postgres-From-App'
        properties: {
          description: 'PostgreSQL access from the application subnet.'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '5432'
          sourceAddressPrefix: appSubnetPrefix
          destinationAddressPrefix: '*'
          access: 'Allow'
          priority: 200
          direction: 'Inbound'
        }
      }
      {
        name: 'Allow-Postgres-From-AKS'
        properties: {
          description: 'PostgreSQL access from AKS nodes (pod traffic is SNATed to the node IP).'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '5432'
          sourceAddressPrefix: aksSubnetPrefix
          destinationAddressPrefix: '*'
          access: 'Allow'
          priority: 210
          direction: 'Inbound'
        }
      }
      {
        name: 'Allow-SSH-From-App'
        properties: {
          description: 'Management SSH from the App VM only. The database VM has no public IP.'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '22'
          sourceAddressPrefix: appSubnetPrefix
          destinationAddressPrefix: '*'
          access: 'Allow'
          priority: 220
          direction: 'Inbound'
        }
      }
      {
        name: 'Deny-Other-Vnet-Inbound'
        properties: {
          description: 'Catch-all below the explicit allows so the database is reachable only from demo workloads.'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: '*'
          access: 'Deny'
          priority: 4000
          direction: 'Inbound'
        }
      }
    ]
  }
}

resource aksNsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: aksNsgName
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'Allow-Magic8Ball-From-Admin'
        properties: {
          description: 'HTTP/HTTPS to the Magic 8 Ball load balancer from the administrator CIDRs.'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRanges: [
            '80'
            '443'
          ]
          sourceAddressPrefixes: adminCidrs
          destinationAddressPrefix: '*'
          access: 'Allow'
          priority: 200
          direction: 'Inbound'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
    subnets: [
      {
        name: 'AppSubnet'
        properties: {
          addressPrefix: appSubnetPrefix
          networkSecurityGroup: {
            id: appNsg.id
          }
        }
      }
      {
        name: 'DatabaseSubnet'
        properties: {
          addressPrefix: databaseSubnetPrefix
          networkSecurityGroup: {
            id: dbNsg.id
          }
        }
      }
      {
        name: 'AKSSubnet'
        properties: {
          addressPrefix: aksSubnetPrefix
          networkSecurityGroup: {
            id: aksNsg.id
          }
        }
      }
    ]
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name
output appSubnetId string = vnet.properties.subnets[0].id
output databaseSubnetId string = vnet.properties.subnets[1].id
output aksSubnetId string = vnet.properties.subnets[2].id
output appSubnetPrefix string = appSubnetPrefix
output databaseSubnetPrefix string = databaseSubnetPrefix
output aksSubnetPrefix string = aksSubnetPrefix
output databaseNsgName string = dbNsg.name
output databaseNsgId string = dbNsg.id
output appNsgName string = appNsg.name
