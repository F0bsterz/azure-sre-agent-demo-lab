// ---------------------------------------------------------------------------
// app-vm.bicep — Ubuntu VM hosting the Scenario Controller (API + React UI)
// and the synthetic monitoring probe.
//
// The dedicated 16 GB data disk mounted at /var/sre-demo is the target of
// scenario 01. Filling a dedicated disk keeps a "disk full" incident realistic
// while guaranteeing the OS disk — and therefore the control plane the operator
// needs in order to reset the lab — is never put at risk.
//
// Base bootstrap happens in cloud-init (no secrets). Application rollout is
// performed afterwards by scripts/deploy.sh via `az vm run-command`, because
// the container image does not exist in ACR until images are built.
// ---------------------------------------------------------------------------

@description('Azure region for the VM.')
param location string

@description('Common tags applied to every resource.')
param tags object

@description('Naming suffix that makes resource names unique.')
param suffix string

@description('Resource ID of the subnet hosting the App VM.')
param subnetId string

@description('VM size. Standard_B2s is the inexpensive default.')
param vmSize string = 'Standard_B2s'

@description('Administrator username for SSH.')
param adminUsername string = 'sreadmin'

@description('SSH public key. Password authentication is disabled.')
param adminPublicKey string

@description('Size of the dedicated demo data disk used by the disk-exhaustion scenario.')
@minValue(8)
@maxValue(128)
param demoDataDiskSizeGb int = 16

@description('Resource ID of the user-assigned managed identity used to call the Azure control plane.')
param identityId string

@description('Resource ID of the data collection rule that ships guest metrics and syslog.')
param dataCollectionRuleId string

@description('Mount point for the dedicated demo data disk.')
param demoMountPath string = '/var/sre-demo'

var vmName = 'vm-sre-app-${suffix}'
var dnsLabel = 'sre-demo-app-${suffix}'

// cloud-init: base packages, Docker, and the dedicated demo disk. Deliberately
// free of secrets — customData is readable from within the VM.
var cloudInit = '''#cloud-config
package_update: true
package_upgrade: false
packages:
  - ca-certificates
  - curl
  - gnupg
  - jq
  - git
  - postgresql-client
  - chrony
  - parted
write_files:
  - path: /usr/local/bin/sre-demo-mount-disk.sh
    permissions: '0755'
    content: |
      #!/usr/bin/env bash
      # Prepare the dedicated demo data disk. Safe to re-run.
      set -euo pipefail
      MOUNT_PATH="__MOUNT_PATH__"
      DEV="/dev/disk/azure/scsi1/lun0"
      for _ in $(seq 1 30); do
        [ -e "$DEV" ] && break
        sleep 2
      done
      if [ ! -e "$DEV" ]; then
        echo "demo data disk not found at $DEV" >&2
        exit 1
      fi
      REAL=$(readlink -f "$DEV")
      if ! blkid "${REAL}1" >/dev/null 2>&1; then
        if ! blkid "$REAL" >/dev/null 2>&1; then
          parted -s "$REAL" mklabel gpt mkpart primary ext4 0% 100%
          sleep 3
          partprobe "$REAL" || true
          sleep 2
          mkfs.ext4 -F -L sredemo "${REAL}1"
        fi
      fi
      PART="${REAL}1"
      [ -e "$PART" ] || PART="$REAL"
      UUID=$(blkid -s UUID -o value "$PART")
      mkdir -p "$MOUNT_PATH"
      if ! grep -q "$UUID" /etc/fstab; then
        echo "UUID=$UUID $MOUNT_PATH ext4 defaults,nofail 0 2" >> /etc/fstab
      fi
      mountpoint -q "$MOUNT_PATH" || mount "$MOUNT_PATH"
      mkdir -p "$MOUNT_PATH/logs" "$MOUNT_PATH/state" "$MOUNT_PATH/certs"
      chmod 0777 "$MOUNT_PATH/logs" "$MOUNT_PATH/state"
      df -h "$MOUNT_PATH"
runcmd:
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  - bash -c 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list'
  - apt-get update -y
  - DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  - systemctl enable --now docker
  - curl -sL https://aka.ms/InstallAzureCLIDeb | bash
  - /usr/local/bin/sre-demo-mount-disk.sh
  - touch /var/log/sre-demo-bootstrap-complete
'''

var cloudInitRendered = replace(cloudInit, '__MOUNT_PATH__', demoMountPath)

resource publicIp 'Microsoft.Network/publicIPAddresses@2023-11-01' = {
  name: 'pip-sre-app-${suffix}'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    dnsSettings: {
      domainNameLabel: dnsLabel
    }
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2023-11-01' = {
  name: 'nic-sre-app-${suffix}'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: subnetId
          }
          publicIPAddress: {
            id: publicIp.id
          }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2023-09-01' = {
  name: vmName
  location: location
  tags: union(tags, {
    role: 'scenario-controller'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        name: 'osdisk-sre-app-${suffix}'
        createOption: 'FromImage'
        caching: 'ReadWrite'
        diskSizeGB: 32
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
      }
      dataDisks: [
        {
          name: 'datadisk-sre-demo-${suffix}'
          lun: 0
          createOption: 'Empty'
          caching: 'None'
          diskSizeGB: demoDataDiskSizeGb
          managedDisk: {
            storageAccountType: 'StandardSSD_LRS'
          }
        }
      ]
    }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      customData: base64(cloudInitRendered)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: adminPublicKey
            }
          ]
        }
        patchSettings: {
          patchMode: 'ImageDefault'
          assessmentMode: 'ImageDefault'
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}

resource monitorAgent 'Microsoft.Compute/virtualMachines/extensions@2023-09-01' = {
  parent: vm
  name: 'AzureMonitorLinuxAgent'
  location: location
  tags: tags
  properties: {
    publisher: 'Microsoft.Azure.Monitor'
    type: 'AzureMonitorLinuxAgent'
    typeHandlerVersion: '1.29'
    autoUpgradeMinorVersion: true
    enableAutomaticUpgrade: true
    settings: {
      authentication: {
        managedIdentity: {
          'identifier-name': 'mi_res_id'
          'identifier-value': identityId
        }
      }
    }
  }
}

resource dcrAssociation 'Microsoft.Insights/dataCollectionRuleAssociations@2022-06-01' = {
  name: 'dcra-sre-app-${suffix}'
  scope: vm
  properties: {
    dataCollectionRuleId: dataCollectionRuleId
  }
  dependsOn: [
    monitorAgent
  ]
}

output vmName string = vm.name
output vmId string = vm.id
output privateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output publicIp string = publicIp.properties.ipAddress
output fqdn string = publicIp.properties.dnsSettings.fqdn
output adminUsername string = adminUsername
output demoMountPath string = demoMountPath
