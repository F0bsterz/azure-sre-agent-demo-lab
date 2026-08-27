#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# enable-sre-remediation.sh — optional, explicit, reversible.
#
# Investigation needs only read access. This script grants Contributor so an
# Azure SRE Agent can actually perform the remediations the scenarios call for:
# scaling the AKS node pool (02), removing the NSG rule (05), rolling back a
# deployment (03), restarting workloads (06).
#
# It is a separate script, and never part of deploy.sh, because granting write
# access to an automated agent should be a deliberate decision rather than a
# side effect of setting up a demo.
#
# Scope is the demo resource group. Subscription-scope Contributor is never
# granted, and this script will refuse to do so.
# -----------------------------------------------------------------------------

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

AGENT_PRINCIPAL_ID=""
REVOKE=false
ROLE="Contributor"

usage() {
  cat <<'USAGE'
Usage: scripts/enable-sre-remediation.sh --agent-principal-id <object-id> [--revoke]

  --agent-principal-id <id>  Object ID of the SRE Agent's managed identity
                             (portal: your agent -> Identity -> Object ID)
  --role <name>              Role to grant (default: Contributor)
  --revoke                   Remove the grant instead of adding it
  -h, --help                 Show this help

Read-only investigation roles are granted separately; see
docs/AZURE-SRE-AGENT-SETUP.md step 3.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent-principal-id) AGENT_PRINCIPAL_ID="$2"; shift 2 ;;
    --role) ROLE="$2"; shift 2 ;;
    --revoke) REVOKE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

load_env_file
require_core_tools
require_azure_login
require_state

[[ -n "${AGENT_PRINCIPAL_ID}" ]] || { usage; die "--agent-principal-id is required"; }

SUBSCRIPTION_ID="$(state_get subscriptionId)"
RESOURCE_GROUP="$(state_get resourceGroup)"
az account set --subscription "${SUBSCRIPTION_ID}"

SCOPE="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}"

if ! az group show -n "${RESOURCE_GROUP}" -o none 2>/dev/null; then
  die "Resource group ${RESOURCE_GROUP} not found."
fi

if [[ "${REVOKE}" == "true" ]]; then
  step "Revoking ${ROLE} from ${AGENT_PRINCIPAL_ID}"
  if az role assignment delete --assignee "${AGENT_PRINCIPAL_ID}" --role "${ROLE}" --scope "${SCOPE}" -o none 2>/dev/null; then
    ok "Removed ${ROLE} at ${SCOPE}"
  else
    warn "No matching assignment found, or it was already removed"
  fi
  az role assignment list --assignee "${AGENT_PRINCIPAL_ID}" --scope "${SCOPE}" \
    --query "[].{Role:roleDefinitionName,Scope:scope}" -o table 2>/dev/null || true
  exit 0
fi

step "Granting ${ROLE} to the SRE Agent"
cat <<SUMMARY

  Principal : ${AGENT_PRINCIPAL_ID}
  Role      : ${ROLE}
  Scope     : ${SCOPE}

  This permits the agent to modify resources in THIS resource group only:
  scale the AKS node pool, remove the scenario NSG rule, roll back the
  Magic 8 Ball deployment and restart workloads.

  It does NOT grant access to anything else in the subscription.

  Azure SRE Agent mitigation actions remain approval-controlled: the agent
  proposes a change and waits for a human to approve it. This grant makes the
  action possible, not automatic.

SUMMARY

confirm "Grant ${ROLE} at the demo resource group?" || die "Cancelled."

if az role assignment create \
     --assignee "${AGENT_PRINCIPAL_ID}" \
     --role "${ROLE}" \
     --scope "${SCOPE}" \
     --description "Azure SRE Agent remediation for the SRE demo lab. Resource group scope only." \
     -o none 2>/dev/null; then
  ok "Granted ${ROLE} at ${SCOPE}"
else
  # Idempotent: an existing assignment is success, not failure.
  if az role assignment list --assignee "${AGENT_PRINCIPAL_ID}" --scope "${SCOPE}" \
       --query "[?roleDefinitionName=='${ROLE}'] | length(@)" -o tsv 2>/dev/null | grep -q '^[1-9]'; then
    ok "${ROLE} was already granted"
  else
    die "Could not create the role assignment. You need Owner or User Access Administrator on ${RESOURCE_GROUP}."
  fi
fi

echo
info "Current assignments for this principal at the demo resource group:"
az role assignment list --assignee "${AGENT_PRINCIPAL_ID}" --scope "${SCOPE}" \
  --query "[].{Role:roleDefinitionName,Scope:scope}" -o table

cat <<'NEXT'

Revoke when the demonstration is finished:

  ./scripts/enable-sre-remediation.sh --agent-principal-id <id> --revoke

NEXT
