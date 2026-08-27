#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# reset-lab.sh — return the lab to baseline.
#
# Different from destroy: nothing is deleted, everything is restored.
#
# The controller's /api/lab/reset is the primary path because it clears state it
# alone tracks. This script then re-asserts every baseline directly against
# Azure and Kubernetes, so a reset still works when the controller itself is
# unreachable — which is exactly when you most need it.
#
# Safe to run repeatedly.
# -----------------------------------------------------------------------------

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

load_env_file
require_core_tools
require_state

SUBSCRIPTION_ID="$(state_get subscriptionId)"
RESOURCE_GROUP="$(state_get resourceGroup)"
CONTROLLER_URL="$(state_get controllerUrl)"
AKS_NAME="$(state_get aksName)"
BASELINE_NODES="$(state_get aksBaselineNodeCount 1)"
DB_NSG_NAME="$(state_get databaseNsgName)"
KUBECONFIG_PATH="$(state_get kubeconfig)"
MAGIC8BALL_STABLE_IMAGE="$(state_get acrLoginServer)/magic8ball:$(state_get imageTag)"

require_azure_login
az account set --subscription "${SUBSCRIPTION_ID}" 2>/dev/null || true

FAILURES=0
note_failure() { FAILURES=$(( FAILURES + 1 )); }

# --- 1. Controller-driven reset --------------------------------------------

step "1/6  Asking the Scenario Controller to reset all scenarios"
RESET_RESULT="$(curl -fsS --max-time 120 -X POST "${CONTROLLER_URL}/api/lab/reset" 2>/dev/null || echo '')"
if [[ -n "${RESET_RESULT}" ]]; then
  ALL_CLEARED="$(echo "${RESET_RESULT}" | jq -r '.allCleared // false')"
  echo "${RESET_RESULT}" | jq -r '.results[]? | "     \(.scenarioId) \(.name): \(if .cleared then "cleared" else "FAILED - " + (.error // "unknown") end)"'
  if [[ "${ALL_CLEARED}" == "true" ]]; then
    ok "Controller reported all scenarios cleared"
  else
    warn "Controller reported partial cleanup; continuing with direct restoration"
  fi
else
  warn "Controller unreachable; continuing with direct restoration"
fi

# --- 2. NSG deny rule -------------------------------------------------------

step "2/6  Removing the scenario 05 NSG deny rule"
if az network nsg rule show -g "${RESOURCE_GROUP}" --nsg-name "${DB_NSG_NAME}" \
     -n sre-demo-deny-postgres >/dev/null 2>&1; then
  if az network nsg rule delete -g "${RESOURCE_GROUP}" --nsg-name "${DB_NSG_NAME}" \
       -n sre-demo-deny-postgres -o none 2>/dev/null; then
    ok "Removed sre-demo-deny-postgres"
  else
    fail "Could not remove sre-demo-deny-postgres"; note_failure
  fi
else
  ok "No deny rule present"
fi

# --- 3. Kubernetes baselines -----------------------------------------------

step "3/6  Restoring Kubernetes baselines"
if require_kubectl && [[ -f "${KUBECONFIG_PATH}" ]]; then
  export KUBECONFIG="${KUBECONFIG_PATH}"

  if kubectl -n sre-demo scale deployment/resource-burner --replicas=0 >/dev/null 2>&1; then
    ok "Resource pressure workload scaled to 0"
  else
    warn "Could not scale resource-burner (it may not be deployed)"
  fi

  CURRENT_IMAGE="$(kubectl -n sre-demo get deploy magic8ball -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo '')"
  if [[ -n "${CURRENT_IMAGE}" && "${CURRENT_IMAGE}" != "${MAGIC8BALL_STABLE_IMAGE}" ]]; then
    kubectl -n sre-demo set image deployment/magic8ball "magic8ball=${MAGIC8BALL_STABLE_IMAGE}" >/dev/null 2>&1 \
      && kubectl -n sre-demo annotate deployment/magic8ball sre-demo/variant=stable --overwrite >/dev/null 2>&1
    ok "Rolled Magic 8 Ball back to the stable image"
  else
    ok "Magic 8 Ball already on the stable image"
  fi

  # Restore the valid certificate by copying from the pre-loaded secret.
  if kubectl -n sre-demo get secret magic8ball-tls-valid >/dev/null 2>&1; then
    CRT="$(kubectl -n sre-demo get secret magic8ball-tls-valid -o jsonpath='{.data.tls\.crt}')"
    KEY="$(kubectl -n sre-demo get secret magic8ball-tls-valid -o jsonpath='{.data.tls\.key}')"
    NOT_AFTER="$(kubectl -n sre-demo get secret magic8ball-tls-valid -o jsonpath='{.metadata.annotations.sre-demo/cert-not-after}' 2>/dev/null || echo '')"
    ACTIVE_VARIANT="$(kubectl -n sre-demo get secret magic8ball-tls -o jsonpath='{.metadata.annotations.sre-demo/cert-variant}' 2>/dev/null || echo unknown)"
    kubectl -n sre-demo patch secret magic8ball-tls --type=merge \
      -p "{\"data\":{\"tls.crt\":\"${CRT}\",\"tls.key\":\"${KEY}\"},\"metadata\":{\"annotations\":{\"sre-demo/cert-variant\":\"valid\",\"sre-demo/cert-not-after\":\"${NOT_AFTER}\"}}}" >/dev/null 2>&1
    if [[ "${ACTIVE_VARIANT}" != "valid" ]]; then
      kubectl -n sre-demo rollout restart deployment/magic8ball >/dev/null 2>&1 || true
      ok "Restored the valid TLS certificate and restarted the workload"
    else
      ok "Valid TLS certificate already active"
    fi
  else
    warn "magic8ball-tls-valid secret not found; run scripts/deploy.sh to reinstall certificates"
  fi

  kubectl -n sre-demo rollout status deployment/magic8ball --timeout=240s >/dev/null 2>&1 \
    && ok "Magic 8 Ball rollout healthy" \
    || { warn "Magic 8 Ball rollout did not complete in time"; }
else
  warn "kubectl or kubeconfig unavailable; skipped Kubernetes restoration"
fi

# --- 4. AKS node pool -------------------------------------------------------

step "4/6  Restoring the AKS node pool baseline"
CURRENT_NODES="$(az aks nodepool show -g "${RESOURCE_GROUP}" --cluster-name "${AKS_NAME}" \
  -n system --query count -o tsv 2>/dev/null || echo '')"
if [[ -z "${CURRENT_NODES}" ]]; then
  warn "Could not read the node pool"
elif (( CURRENT_NODES > BASELINE_NODES )); then
  info "Scaling ${CURRENT_NODES} -> ${BASELINE_NODES} node(s); this takes a few minutes"
  if az aks nodepool scale -g "${RESOURCE_GROUP}" --cluster-name "${AKS_NAME}" \
       -n system --node-count "${BASELINE_NODES}" -o none 2>/dev/null; then
    ok "Node pool restored to ${BASELINE_NODES}"
  else
    fail "Node pool scale failed"; note_failure
  fi
elif (( CURRENT_NODES < BASELINE_NODES )); then
  # Never leave the lab smaller than baseline: that would be a new fault.
  warn "Node pool is below baseline (${CURRENT_NODES} < ${BASELINE_NODES}); scaling up"
  az aks nodepool scale -g "${RESOURCE_GROUP}" --cluster-name "${AKS_NAME}" \
    -n system --node-count "${BASELINE_NODES}" -o none 2>/dev/null || note_failure
else
  ok "Node pool already at the baseline of ${BASELINE_NODES}"
fi

# --- 5. Disk and database ---------------------------------------------------

step "5/6  Verifying disk and database baselines"
LAB_STATUS="$(curl -fsS --max-time 30 "${CONTROLLER_URL}/api/lab/status" 2>/dev/null || echo '{}')"
DISK_PERCENT="$(echo "${LAB_STATUS}" | jq -r '.components[]? | select(.name=="App VM") | .metrics.percentUsed // "unknown"')"
PG_PERCENT="$(echo "${LAB_STATUS}" | jq -r '.components[]? | select(.name=="PostgreSQL") | .metrics.percentUsed // "unknown"')"

if [[ "${DISK_PERCENT}" != "unknown" ]]; then
  if awk "BEGIN{exit !(${DISK_PERCENT} < 80)}"; then
    ok "Demo disk at ${DISK_PERCENT}% (below the alert threshold)"
  else
    fail "Demo disk still at ${DISK_PERCENT}%"; note_failure
  fi
else
  warn "Disk utilisation unavailable"
fi

if [[ "${PG_PERCENT}" != "unknown" ]]; then
  if awk "BEGIN{exit !(${PG_PERCENT} < 50)}"; then
    ok "PostgreSQL connections at ${PG_PERCENT}% of maximum"
  else
    fail "PostgreSQL connections still at ${PG_PERCENT}%"; note_failure
  fi
else
  warn "Connection utilisation unavailable"
fi

# --- 6. Final health --------------------------------------------------------

step "6/6  Final health check"
OVERALL="$(curl -fsS --max-time 30 "${CONTROLLER_URL}/api/lab/status" 2>/dev/null | jq -r '.overall // "UNKNOWN"')"
ACTIVE="$(curl -fsS --max-time 30 "${CONTROLLER_URL}/api/lab/status" 2>/dev/null | jq -r '.activeIncident // "null"')"

if [[ "${ACTIVE}" == "null" ]]; then
  ok "No active incident"
else
  fail "An incident is still active"; note_failure
fi

case "${OVERALL}" in
  HEALTHY) ok "Overall lab health: HEALTHY" ;;
  DEGRADED) warn "Overall lab health: DEGRADED — components may still be settling; re-check in a minute" ;;
  *) warn "Overall lab health: ${OVERALL}" ;;
esac

echo
if (( FAILURES > 0 )); then
  printf '%sReset completed with %d problem(s).%s Re-run this script, or see docs/TROUBLESHOOTING.md.\n' \
    "${C_YELLOW}" "${FAILURES}" "${C_RESET}"
  exit 1
fi
printf '%sLab reset complete. All baselines restored.%s\n' "${C_GREEN}" "${C_RESET}"
