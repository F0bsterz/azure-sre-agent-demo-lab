#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# stop-lab.sh — deallocate compute to cut cost between demos.
#
# Deallocates both VMs and stops the AKS cluster. Persistent infrastructure
# (disks, registry, workspace, Key Vault, networking) is left intact so
# start-lab.sh brings the same environment back rather than rebuilding it.
#
# Deallocated is the important word: a merely "stopped" Azure VM still bills for
# compute. `az vm deallocate` releases it.
# -----------------------------------------------------------------------------

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

load_env_file
require_core_tools
require_state

SUBSCRIPTION_ID="$(state_get subscriptionId)"
RESOURCE_GROUP="$(state_get resourceGroup)"
APP_VM_NAME="$(state_get appVmName)"
PG_VM_NAME="$(state_get postgresVmName)"
AKS_NAME="$(state_get aksName)"

require_azure_login
az account set --subscription "${SUBSCRIPTION_ID}" 2>/dev/null || true

step "Stopping the lab in ${RESOURCE_GROUP}"

info "Deallocating ${APP_VM_NAME} and ${PG_VM_NAME} (in parallel)"
az vm deallocate -g "${RESOURCE_GROUP}" -n "${APP_VM_NAME}" --no-wait -o none 2>/dev/null \
  && ok "App VM deallocation requested" || { fail "Could not deallocate the App VM"; }
az vm deallocate -g "${RESOURCE_GROUP}" -n "${PG_VM_NAME}" --no-wait -o none 2>/dev/null \
  && ok "PostgreSQL VM deallocation requested" || { fail "Could not deallocate the PostgreSQL VM"; }

info "Stopping AKS cluster ${AKS_NAME}"
if az aks stop -g "${RESOURCE_GROUP}" -n "${AKS_NAME}" --no-wait -o none 2>/dev/null; then
  ok "AKS stop requested"
else
  warn "Could not stop AKS. Cluster stop is unsupported on some configurations; nodes will keep billing."
fi

info "Waiting for the VMs to finish deallocating..."
for vm in "${APP_VM_NAME}" "${PG_VM_NAME}"; do
  for _ in $(seq 1 60); do
    state="$(az vm get-instance-view -g "${RESOURCE_GROUP}" -n "${vm}" \
      --query "instanceView.statuses[?starts_with(code,'PowerState')].displayStatus | [0]" -o tsv 2>/dev/null || echo unknown)"
    [[ "${state}" == "VM deallocated" ]] && break
    sleep 10
  done
  [[ "${state}" == "VM deallocated" ]] && ok "${vm}: ${state}" || warn "${vm}: ${state}"
done

cat <<'COSTS'

Still accruing cost while the lab is stopped:

  Managed disks       OS and data disks for both VMs, and the AKS node disks.
                      This is usually the largest remaining line item.
  Public IP addresses Static Standard IPs (App VM, Magic 8 Ball load balancer).
  Log Analytics       Retained data until the retention period expires.
  Container Registry  Basic tier daily charge plus stored image layers.
  Key Vault           Negligible; charged per operation.
  Load balancers      Standard load balancer rules remain provisioned.

Compute (VM cores and AKS nodes) is NOT billed while deallocated/stopped,
which is the bulk of the hourly cost.

Restart with:  ./scripts/start-lab.sh
Remove fully:  ./scripts/destroy-lab.sh
COSTS
