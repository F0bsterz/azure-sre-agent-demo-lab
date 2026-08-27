#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# start-lab.sh — bring a stopped lab back and verify it.
#
# Order matters: PostgreSQL first, then AKS, then the App VM. The controller and
# Magic 8 Ball both probe the database on startup, so starting them last avoids
# a burst of spurious dependency failures that would otherwise look like a real
# incident in the telemetry.
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
CONTROLLER_URL="$(state_get controllerUrl)"
MAGIC8BALL_URL="$(state_get magic8ballUrl)"

require_azure_login
az account set --subscription "${SUBSCRIPTION_ID}" 2>/dev/null || true

step "1/4  Starting PostgreSQL"
az vm start -g "${RESOURCE_GROUP}" -n "${PG_VM_NAME}" -o none 2>/dev/null \
  && ok "${PG_VM_NAME} started" || die "Could not start ${PG_VM_NAME}"

step "2/4  Starting AKS"
AKS_POWER="$(az aks show -g "${RESOURCE_GROUP}" -n "${AKS_NAME}" --query powerState.code -o tsv 2>/dev/null || echo Unknown)"
if [[ "${AKS_POWER}" == "Stopped" ]]; then
  info "Starting cluster; nodes take several minutes to become Ready"
  az aks start -g "${RESOURCE_GROUP}" -n "${AKS_NAME}" -o none 2>/dev/null \
    && ok "${AKS_NAME} started" || fail "Could not start ${AKS_NAME}"
else
  ok "AKS power state is ${AKS_POWER}"
fi

step "3/4  Starting the App VM"
az vm start -g "${RESOURCE_GROUP}" -n "${APP_VM_NAME}" -o none 2>/dev/null \
  && ok "${APP_VM_NAME} started" || die "Could not start ${APP_VM_NAME}"

# The controller container has restart=unless-stopped, so Docker brings it back
# with the boot. Nudge it only if it has not come up on its own.
step "4/4  Verifying services"
info "Waiting for the Scenario Controller..."
CONTROLLER_UP=false
for _ in $(seq 1 40); do
  if curl -fsS --max-time 10 "${CONTROLLER_URL}/api/health" >/dev/null 2>&1; then
    CONTROLLER_UP=true
    break
  fi
  sleep 15
done

if [[ "${CONTROLLER_UP}" == "true" ]]; then
  ok "Scenario Controller is responding at ${CONTROLLER_URL}"
else
  warn "Controller did not respond; attempting to restart the container"
  az vm run-command invoke -g "${RESOURCE_GROUP}" -n "${APP_VM_NAME}" \
    --command-id RunShellScript \
    --scripts "docker start sre-scenario-controller || true; sleep 10; curl -fsS http://127.0.0.1:8080/healthz || docker logs --tail 40 sre-scenario-controller" \
    --query "value[0].message" -o tsv 2>/dev/null | tail -15 || true

  for _ in $(seq 1 12); do
    if curl -fsS --max-time 10 "${CONTROLLER_URL}/api/health" >/dev/null 2>&1; then
      CONTROLLER_UP=true; break
    fi
    sleep 10
  done
  [[ "${CONTROLLER_UP}" == "true" ]] && ok "Controller recovered" || fail "Controller is still not responding"
fi

info "Waiting for Magic 8 Ball..."
MAGIC_UP=false
for _ in $(seq 1 30); do
  if curl -fsS --max-time 10 "${MAGIC8BALL_URL}/healthz" >/dev/null 2>&1; then
    MAGIC_UP=true; break
  fi
  sleep 15
done
[[ "${MAGIC_UP}" == "true" ]] && ok "Magic 8 Ball is responding at ${MAGIC8BALL_URL}" \
  || warn "Magic 8 Ball did not respond yet; AKS nodes may still be joining"

echo
if [[ "${CONTROLLER_UP}" == "true" && "${MAGIC_UP}" == "true" ]]; then
  printf '%sLab is running.%s\n\n' "${C_GREEN}" "${C_RESET}"
else
  printf '%sLab started with warnings.%s Allow a few more minutes, then re-check.\n\n' "${C_YELLOW}" "${C_RESET}"
fi
printf '  Scenario Controller : %s\n' "${CONTROLLER_URL}"
printf '  Magic 8 Ball        : %s\n\n' "${MAGIC8BALL_URL}"
printf 'Run ./scripts/validate.sh for a full health report.\n'
