// ---------------------------------------------------------------------------
// postgres-vm.bicep — Ubuntu VM running PostgreSQL on a private IP only.
//
// Two deliberate demo choices:
//   * max_connections is modest (default 50) so scenario 04 reaches saturation
//     in seconds rather than minutes, while superuser_reserved_connections
//     keeps an administrative path open for diagnosis and reset.
//   * verbose connection logging plus pg_stat_statements give an investigating
//     agent real evidence (connection counts, rejections, query latency)
//     instead of only an application-side symptom.
//
// The setup script carries credentials, so it is delivered through the custom
// script extension's protectedSettings, which Azure stores encrypted. Nothing
// secret is placed in customData, which is readable from inside the VM.
// ---------------------------------------------------------------------------

@description('Azure region for the VM.')
param location string

@description('Common tags applied to every resource.')
param tags object

@description('Naming suffix that makes resource names unique.')
param suffix string

@description('Resource ID of the database subnet.')
param subnetId string

@description('VM size. Standard_B2s is the inexpensive default.')
param vmSize string = 'Standard_B2s'

@description('Administrator username for SSH.')
param adminUsername string = 'sreadmin'

@description('SSH public key. Password authentication is disabled.')
param adminPublicKey string

@description('Size of the managed data disk holding the PostgreSQL cluster.')
@minValue(8)
@maxValue(256)
param dataDiskSizeGb int = 32

@description('Resource ID of the user-assigned managed identity.')
param identityId string

@description('Resource ID of the data collection rule that ships guest metrics and syslog.')
param dataCollectionRuleId string

@description('Application database name.')
param databaseName string = 'sre_demo'

@description('Application database role.')
param appUsername string = 'sre_app'

@description('Dedicated role used by the connection-exhaustion scenario.')
param scenarioUsername string = 'sre_scenario'

@description('Password for the application role.')
@secure()
param appPassword string

@description('Password for the scenario role.')
@secure()
param scenarioPassword string

@description('Connection ceiling for the lab. Low on purpose so scenario 04 is fast to demonstrate.')
@minValue(20)
@maxValue(500)
param maxConnections int = 50

@description('CIDRs allowed to authenticate against PostgreSQL.')
param allowedClientCidrs array

var vmName = 'vm-sre-pg-${suffix}'
var pgMountPath = '/var/sre-demo-db'

var cloudInit = '''#cloud-config
package_update: true
package_upgrade: false
packages:
  - ca-certificates
  - curl
  - jq
  - chrony
  - rsync
  - parted
write_files:
  - path: /usr/local/bin/sre-demo-mount-disk.sh
    permissions: '0755'
    content: |
      #!/usr/bin/env bash
      # Prepare the PostgreSQL data disk. Safe to re-run.
      set -euo pipefail
      MOUNT_PATH="__MOUNT_PATH__"
      DEV="/dev/disk/azure/scsi1/lun0"
      for _ in $(seq 1 30); do
        [ -e "$DEV" ] && break
        sleep 2
      done
      if [ ! -e "$DEV" ]; then
        echo "postgres data disk not found at $DEV" >&2
        exit 1
      fi
      REAL=$(readlink -f "$DEV")
      if ! blkid "${REAL}1" >/dev/null 2>&1; then
        if ! blkid "$REAL" >/dev/null 2>&1; then
          parted -s "$REAL" mklabel gpt mkpart primary ext4 0% 100%
          sleep 3
          partprobe "$REAL" || true
          sleep 2
          mkfs.ext4 -F -L sredemodb "${REAL}1"
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
      df -h "$MOUNT_PATH"
runcmd:
  - /usr/local/bin/sre-demo-mount-disk.sh
  - touch /var/log/sre-demo-bootstrap-complete
'''

var cloudInitRendered = replace(cloudInit, '__MOUNT_PATH__', pgMountPath)

var hbaLines = join(map(allowedClientCidrs, cidr => 'host all all ${cidr} scram-sha-256'), '\n')

// Credential-bearing setup. Delivered via protectedSettings (encrypted at rest).
var setupScript = '''#!/usr/bin/env bash
set -euo pipefail
exec > >(tee -a /var/log/sre-demo-postgres-setup.log) 2>&1
echo "=== sre demo postgres setup $(date -Is) ==="

# cloud-init owns the data disk; wait for it before touching PGDATA.
for _ in $(seq 1 90); do
  [ -f /var/log/sre-demo-bootstrap-complete ] && break
  sleep 5
done
mountpoint -q "__PG_MOUNT__" || { echo "data disk not mounted" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
if ! dpkg -l postgresql >/dev/null 2>&1 || ! command -v rsync >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y postgresql postgresql-contrib rsync parted
fi

PGVER=$(ls /etc/postgresql | sort -V | tail -1)
PGCONF="/etc/postgresql/${PGVER}/main/postgresql.conf"
PGHBA="/etc/postgresql/${PGVER}/main/pg_hba.conf"
NEWDATA="__PG_MOUNT__/${PGVER}/main"

systemctl stop postgresql || true

# Relocate the cluster onto the managed data disk exactly once.
if [ ! -d "$NEWDATA" ]; then
  mkdir -p "__PG_MOUNT__/${PGVER}"
  rsync -a "/var/lib/postgresql/${PGVER}/main" "__PG_MOUNT__/${PGVER}/"
  chown -R postgres:postgres "__PG_MOUNT__"
  chmod 0700 "$NEWDATA"
fi

apply_setting() {
  local key="$1" value="$2"
  sed -i "/^[#[:space:]]*${key}[[:space:]]*=/d" "$PGCONF"
  echo "${key} = ${value}" >> "$PGCONF"
}

apply_setting data_directory "'${NEWDATA}'"
apply_setting listen_addresses "'*'"
apply_setting port "5432"
apply_setting max_connections "__MAX_CONN__"
apply_setting superuser_reserved_connections "3"
apply_setting shared_preload_libraries "'pg_stat_statements'"
apply_setting log_destination "'stderr,syslog'"
apply_setting syslog_facility "'LOCAL0'"
apply_setting syslog_ident "'postgres'"
apply_setting logging_collector "on"
apply_setting log_connections "on"
apply_setting log_disconnections "on"
apply_setting log_min_duration_statement "500"
apply_setting log_line_prefix "'%m [%p] %q%u@%d app=%a host=%h '"
apply_setting log_checkpoints "on"
apply_setting log_lock_waits "on"
apply_setting track_activities "on"
apply_setting track_counts "on"

# Rebuild pg_hba: local socket + explicitly allowed demo CIDRs only.
cat > "$PGHBA" <<'HBA'
local   all             postgres                                peer
local   all             all                                     peer
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
HBA
cat >> "$PGHBA" <<HBA
__HBA_LINES__
HBA
chown postgres:postgres "$PGHBA"
chmod 0640 "$PGHBA"

systemctl start postgresql
for _ in $(seq 1 30); do
  pg_isready -q && break
  sleep 2
done

run_sql() { su - postgres -c "psql -v ON_ERROR_STOP=1 -q -c \"$1\""; }
run_sql_db() { su - postgres -c "psql -v ON_ERROR_STOP=1 -q -d __DB_NAME__ -c \"$1\""; }

su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='__APP_USER__'\"" | grep -q 1 \
  || run_sql "CREATE ROLE __APP_USER__ LOGIN PASSWORD '__APP_PASSWORD__'"
run_sql "ALTER ROLE __APP_USER__ WITH LOGIN PASSWORD '__APP_PASSWORD__'"

su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='__SCENARIO_USER__'\"" | grep -q 1 \
  || run_sql "CREATE ROLE __SCENARIO_USER__ LOGIN PASSWORD '__SCENARIO_PASSWORD__'"
run_sql "ALTER ROLE __SCENARIO_USER__ WITH LOGIN PASSWORD '__SCENARIO_PASSWORD__'"

su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='__DB_NAME__'\"" | grep -q 1 \
  || run_sql "CREATE DATABASE __DB_NAME__ OWNER __APP_USER__"

run_sql_db "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"
run_sql_db "GRANT CONNECT ON DATABASE __DB_NAME__ TO __SCENARIO_USER__"
run_sql_db "GRANT pg_monitor TO __APP_USER__"

su - postgres -c "psql -v ON_ERROR_STOP=1 -q -d __DB_NAME__" <<'SCHEMA'
CREATE TABLE IF NOT EXISTS answers (
  id           BIGSERIAL PRIMARY KEY,
  asked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  question     TEXT        NOT NULL,
  answer       TEXT        NOT NULL,
  sentiment    TEXT        NOT NULL DEFAULT 'neutral',
  app_version  TEXT,
  image_tag    TEXT,
  latency_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS answers_asked_at_idx ON answers (asked_at DESC);

CREATE TABLE IF NOT EXISTS scenario_events (
  id             BIGSERIAL PRIMARY KEY,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  scenario_id    TEXT        NOT NULL,
  scenario_name  TEXT,
  state          TEXT        NOT NULL,
  component      TEXT,
  severity       TEXT,
  correlation_id TEXT,
  message        TEXT,
  detail         JSONB
);
CREATE INDEX IF NOT EXISTS scenario_events_occurred_idx ON scenario_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS scenario_events_scenario_idx ON scenario_events (scenario_id, occurred_at DESC);
SCHEMA

run_sql_db "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO __APP_USER__"
run_sql_db "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO __APP_USER__"

systemctl restart postgresql
touch /var/log/sre-demo-postgres-ready
echo "=== sre demo postgres setup complete $(date -Is) ==="
'''

var setupScriptRendered = replace(replace(replace(replace(replace(replace(replace(setupScript, '__PG_MOUNT__', pgMountPath), '__MAX_CONN__', string(maxConnections)), '__HBA_LINES__', hbaLines), '__DB_NAME__', databaseName), '__APP_USER__', appUsername), '__SCENARIO_USER__', scenarioUsername), '__APP_PASSWORD__', appPassword)

var setupScriptFinal = replace(setupScriptRendered, '__SCENARIO_PASSWORD__', scenarioPassword)

resource nic 'Microsoft.Network/networkInterfaces@2023-11-01' = {
  name: 'nic-sre-pg-${suffix}'
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
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2023-09-01' = {
  name: vmName
  location: location
  tags: union(tags, {
    role: 'postgresql'
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
        name: 'osdisk-sre-pg-${suffix}'
        createOption: 'FromImage'
        caching: 'ReadWrite'
        diskSizeGB: 32
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
      }
      dataDisks: [
        {
          name: 'datadisk-sre-pg-${suffix}'
          lun: 0
          createOption: 'Empty'
          caching: 'ReadOnly'
          diskSizeGB: dataDiskSizeGb
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

resource setup 'Microsoft.Compute/virtualMachines/extensions@2023-09-01' = {
  parent: vm
  name: 'postgres-setup'
  location: location
  tags: tags
  properties: {
    publisher: 'Microsoft.Azure.Extensions'
    type: 'CustomScript'
    typeHandlerVersion: '2.1'
    autoUpgradeMinorVersion: true
    protectedSettings: {
      script: base64(setupScriptFinal)
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
  dependsOn: [
    setup
  ]
}

resource dcrAssociation 'Microsoft.Insights/dataCollectionRuleAssociations@2022-06-01' = {
  name: 'dcra-sre-pg-${suffix}'
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
output databaseName string = databaseName
output appUsername string = appUsername
output scenarioUsername string = scenarioUsername
output maxConnections int = maxConnections
