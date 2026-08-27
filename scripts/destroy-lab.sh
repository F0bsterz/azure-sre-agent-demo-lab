#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# destroy-lab.sh — delete the lab's resource group(s) and nothing else.
#
# Safety design:
#   * operates ONLY on the resource group recorded in .lab-state.json, or one
#     passed explicitly with --resource-group
#   * refuses to proceed unless that group carries the lab's own
#     project=azure-sre-agent-demo tag, so it cannot delete an unrelated group
#     that happens to share a name
#   * requires typed confirmation of the group name unless --yes is given
#   * never touches subscription-scope deletion
#
# --dry-run prints exactly what would be deleted and exits, which is how the
# teardown path can be verified without destroying a working environment.
# -----------------------------------------------------------------------------

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DRY_RUN=false
TARGET_RG=""
ASSUME_YES="${ASSUME_YES:-false}"

usage() {
  cat <<'USAGE'
Usage: scripts/destroy-lab.sh [--resource-group <name>] [--dry-run] [--yes]

  --resource-group <name>  Group to delete (default: from .lab-state.json)
  --dry-run                Show what would be deleted, then exit
  --yes                    Skip the confirmation prompt
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group|-g) TARGET_RG="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

load_env_file
require_core_tools
require_azure_login

SUBSCRIPTION_ID="$(state_get subscriptionId)"
[[ -n "${SUBSCRIPTION_ID}" ]] && az account set --subscription "${SUBSCRIPTION_ID}" 2>/dev/null || true

if [[ -z "${TARGET_RG}" ]]; then
  require_state
  TARGET_RG="$(state_get resourceGroup)"
fi
[[ -n "${TARGET_RG}" ]] || die "No resource group specified and none found in .lab-state.json"

step "Inspecting ${TARGET_RG}"
if ! az group show -n "${TARGET_RG}" -o none 2>/dev/null; then
  ok "Resource group ${TARGET_RG} does not exist; nothing to do"
  exit 0
fi

# Tag guard. This is what makes it safe to run: without the lab's own tag the
# group is assumed to belong to someone else.
PROJECT_TAG="$(az group show -n "${TARGET_RG}" --query "tags.project" -o tsv 2>/dev/null || echo '')"
if [[ "${PROJECT_TAG}" != "azure-sre-agent-demo" ]]; then
  fail "Resource group ${TARGET_RG} is not tagged project=azure-sre-agent-demo (found: '${PROJECT_TAG:-none}')."
  die "Refusing to delete a resource group this lab did not create."
fi
ok "Tag check passed: project=azure-sre-agent-demo"

RESOURCE_COUNT="$(az resource list -g "${TARGET_RG}" --query "length(@)" -o tsv 2>/dev/null || echo 0)"
AKS_NODE_RG="$(state_get aksNodeResourceGroup)"

printf '\n%sResources that would be deleted:%s\n\n' "${C_BOLD}" "${C_RESET}"
az resource list -g "${TARGET_RG}" --query "[].{Name:name, Type:type}" -o table 2>/dev/null || true

printf '\n  Resource group      : %s (%s resources)\n' "${TARGET_RG}" "${RESOURCE_COUNT}"
if [[ -n "${AKS_NODE_RG}" ]]; then
  printf '  AKS node group      : %s (deleted automatically with the cluster)\n' "${AKS_NODE_RG}"
fi
printf '  Subscription        : %s\n\n' "$(az account show --query name -o tsv)"

if [[ "${DRY_RUN}" == "true" ]]; then
  printf '%sDry run — nothing was deleted.%s\n' "${C_YELLOW}" "${C_RESET}"
  exit 0
fi

if [[ "${ASSUME_YES}" != "true" ]]; then
  printf '%sThis permanently deletes the resource group and everything in it.%s\n' "${C_RED}" "${C_RESET}"
  read -r -p "Type the resource group name to confirm: " typed
  [[ "${typed}" == "${TARGET_RG}" ]] || die "Name did not match. Nothing was deleted."
fi

step "Deleting ${TARGET_RG}"
az group delete --name "${TARGET_RG}" --yes --no-wait -o none
ok "Deletion started (running in the background; it takes several minutes)"

# Key Vault soft-delete would otherwise block redeploying with the same suffix.
KEY_VAULT_NAME="$(state_get keyVaultName)"
if [[ -n "${KEY_VAULT_NAME}" ]]; then
  info "Purging soft-deleted Key Vault ${KEY_VAULT_NAME} so the name can be reused"
  (
    sleep 90
    az keyvault purge --name "${KEY_VAULT_NAME}" --no-wait -o none 2>/dev/null \
      && echo "Key Vault ${KEY_VAULT_NAME} purge requested" \
      || echo "Key Vault purge skipped (it may still be deleting; purge later with: az keyvault purge --name ${KEY_VAULT_NAME})"
  ) &
fi

SRE_AGENT_RG="$(state_get sreAgentResourceGroup)"
if [[ -n "${SRE_AGENT_RG}" ]] && az group show -n "${SRE_AGENT_RG}" -o none 2>/dev/null; then
  AGENT_TAG="$(az group show -n "${SRE_AGENT_RG}" --query "tags.project" -o tsv 2>/dev/null || echo '')"
  if [[ "${AGENT_TAG}" == "azure-sre-agent-demo" ]]; then
    info "Deleting SRE Agent resource group ${SRE_AGENT_RG}"
    az group delete --name "${SRE_AGENT_RG}" --yes --no-wait -o none
  else
    warn "${SRE_AGENT_RG} is not tagged for this lab; leaving it alone"
  fi
fi

rm -f "${STATE_FILE}"
info "Removed .lab-state.json"

cat <<'DONE'

Teardown started. Track progress with:

  az group list --query "[?starts_with(name,'rg-sre-demo')].{Name:name,State:properties.provisioningState}" -o table

Local artefacts that are NOT deleted (git-ignored, remove manually if you wish):
  .secrets/    SSH key and kubeconfig
  certs/       demo CA and server certificates
DONE
