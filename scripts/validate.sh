#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# validate.sh — end-to-end health verification of a deployed lab.
#
# Prints PASS/FAIL for every check and exits non-zero if any fail, so it can be
# used as a gate in CI or before a customer demo.
# -----------------------------------------------------------------------------

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

load_env_file
require_core_tools

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    ok "${label}"; PASS_COUNT=$(( PASS_COUNT + 1 )); return 0
  fi
  fail "${label}"; FAIL_COUNT=$(( FAIL_COUNT + 1 )); return 1
}

report() {
  local label="$1" passed="$2" detail="${3:-}"
  if [[ "${passed}" == "true" ]]; then
    ok "${label}${detail:+ — ${detail}}"; PASS_COUNT=$(( PASS_COUNT + 1 ))
  else
    fail "${label}${detail:+ — ${detail}}"; FAIL_COUNT=$(( FAIL_COUNT + 1 ))
  fi
}

skip() {
  warn "SKIP ${1}"; SKIP_COUNT=$(( SKIP_COUNT + 1 ))
}

require_state
SUBSCRIPTION_ID="$(state_get subscriptionId)"
RESOURCE_GROUP="$(state_get resourceGroup)"
CONTROLLER_URL="$(state_get controllerUrl)"
MAGIC8BALL_URL="$(state_get magic8ballUrl)"
MAGIC8BALL_HTTPS_URL="$(state_get magic8ballHttpsUrl)"
AKS_NAME="$(state_get aksName)"
APP_VM_NAME="$(state_get appVmName)"
PG_VM_NAME="$(state_get postgresVmName)"
KUBECONFIG_PATH="$(state_get kubeconfig)"
APPI_NAME="$(state_get appInsightsName)"
LAW_ID="$(state_get logAnalyticsId)"

printf '\n%sAzure SRE Agent Demo Lab — validation%s\n' "${C_BOLD}" "${C_RESET}"
printf 'Resource group: %s\n' "${RESOURCE_GROUP}"

# --- Azure resources --------------------------------------------------------

step "Azure resources"
require_azure_login
az account set --subscription "${SUBSCRIPTION_ID}" 2>/dev/null || true

check "Resource group ${RESOURCE_GROUP} exists" az group show -n "${RESOURCE_GROUP}"

APP_VM_STATE="$(az vm get-instance-view -g "${RESOURCE_GROUP}" -n "${APP_VM_NAME}" \
  --query "instanceView.statuses[?starts_with(code,'PowerState')].displayStatus | [0]" -o tsv 2>/dev/null || echo unknown)"
report "App VM running" "$([[ "${APP_VM_STATE}" == "VM running" ]] && echo true || echo false)" "${APP_VM_STATE}"

PG_VM_STATE="$(az vm get-instance-view -g "${RESOURCE_GROUP}" -n "${PG_VM_NAME}" \
  --query "instanceView.statuses[?starts_with(code,'PowerState')].displayStatus | [0]" -o tsv 2>/dev/null || echo unknown)"
report "PostgreSQL VM running" "$([[ "${PG_VM_STATE}" == "VM running" ]] && echo true || echo false)" "${PG_VM_STATE}"

AKS_STATE="$(az aks show -g "${RESOURCE_GROUP}" -n "${AKS_NAME}" --query provisioningState -o tsv 2>/dev/null || echo unknown)"
report "AKS cluster provisioned" "$([[ "${AKS_STATE}" == "Succeeded" ]] && echo true || echo false)" "${AKS_STATE}"

# --- Scenario Controller ----------------------------------------------------

step "Scenario Controller"
CONTROLLER_HEALTH="$(curl -fsS --max-time 15 "${CONTROLLER_URL}/api/health" 2>/dev/null || echo '')"
report "Controller reachable" "$([[ -n "${CONTROLLER_HEALTH}" ]] && echo true || echo false)" "${CONTROLLER_URL}"

if [[ -n "${CONTROLLER_HEALTH}" ]]; then
  TELEMETRY_OK="$(echo "${CONTROLLER_HEALTH}" | jq -r '.telemetryConfigured // false')"
  report "Controller telemetry configured" "${TELEMETRY_OK}"

  LAB_STATUS="$(curl -fsS --max-time 25 "${CONTROLLER_URL}/api/lab/status" 2>/dev/null || echo '{}')"
  for component in "App VM" "PostgreSQL" "AKS" "Magic 8 Ball" "TLS"; do
    STATE_VALUE="$(echo "${LAB_STATUS}" | jq -r --arg n "${component}" '.components[]? | select(.name==$n) | .state // "UNKNOWN"')"
    DETAIL="$(echo "${LAB_STATUS}" | jq -r --arg n "${component}" '.components[]? | select(.name==$n) | .detail // ""')"
    report "${component} healthy" "$([[ "${STATE_VALUE}" == "HEALTHY" ]] && echo true || echo false)" "${STATE_VALUE}: ${DETAIL}"
  done

  SCENARIO_COUNT="$(curl -fsS --max-time 20 "${CONTROLLER_URL}/api/scenarios" 2>/dev/null | jq -r '.scenarios | length // 0')"
  report "All six scenario APIs available" "$([[ "${SCENARIO_COUNT}" == "6" ]] && echo true || echo false)" "${SCENARIO_COUNT} registered"
else
  skip "Component health checks (controller unreachable)"
fi

# --- Magic 8 Ball -----------------------------------------------------------

step "Magic 8 Ball"
check "HTTP health endpoint" curl -fsS --max-time 15 "${MAGIC8BALL_URL}/healthz"
check "Readiness endpoint" curl -fsS --max-time 15 "${MAGIC8BALL_URL}/readyz"

VERSION_JSON="$(curl -fsS --max-time 15 "${MAGIC8BALL_URL}/api/version" 2>/dev/null || echo '{}')"
VARIANT="$(echo "${VERSION_JSON}" | jq -r '.variant // "unknown"')"
report "Stable variant deployed" "$([[ "${VARIANT}" == "stable" ]] && echo true || echo false)" "variant=${VARIANT}"
report "Build metadata present" \
  "$([[ "$(echo "${VERSION_JSON}" | jq -r '.gitCommit // "unknown"')" != "unknown" ]] && echo true || echo false)" \
  "commit=$(echo "${VERSION_JSON}" | jq -r '.gitCommit // "unknown"')"

ANSWER="$(curl -fsS --max-time 20 -X POST "${MAGIC8BALL_URL}/api/answer" \
  -H 'content-type: application/json' -d '{"question":"is the lab healthy?"}' 2>/dev/null || echo '{}')"
report "Answer API returns a result" \
  "$([[ -n "$(echo "${ANSWER}" | jq -r '.answer // empty')" ]] && echo true || echo false)" \
  "$(echo "${ANSWER}" | jq -r '.answer // "no answer"')"
report "Answer persisted to PostgreSQL" "$(echo "${ANSWER}" | jq -r '.persisted // false')"

# TLS must validate against the demo CA specifically, which is what proves the
# certificate scenario will fail for the right reason later.
step "TLS"
CERT_DIR="${REPO_ROOT}/certs"
if [[ -f "${CERT_DIR}/ca.crt" ]]; then
  if curl -fsS --max-time 15 --cacert "${CERT_DIR}/ca.crt" \
       --resolve "magic8ball.sre-demo.local:443:$(state_get magic8ballIp)" \
       "https://magic8ball.sre-demo.local/healthz" >/dev/null 2>&1; then
    report "HTTPS validates against the demo CA" true
  elif curl -fsSk --max-time 15 "${MAGIC8BALL_HTTPS_URL}/healthz" >/dev/null 2>&1; then
    report "HTTPS validates against the demo CA" false "handshake works but validation failed — check certificate dates"
  else
    report "HTTPS endpoint reachable" false "no TLS response"
  fi

  NOT_AFTER="$(echo | openssl s_client -connect "$(state_get magic8ballIp):443" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || echo unknown)"
  report "Served certificate is currently valid" \
    "$([[ "${NOT_AFTER}" != "unknown" ]] && date -d "${NOT_AFTER}" +%s >/dev/null 2>&1 && \
       [[ "$(date -d "${NOT_AFTER}" +%s)" -gt "$(date +%s)" ]] && echo true || echo false)" \
    "notAfter=${NOT_AFTER}"
else
  skip "TLS validation (certs/ca.crt not present locally)"
fi

# --- Kubernetes -------------------------------------------------------------

step "Kubernetes"
if command -v kubectl >/dev/null 2>&1 || [[ -x "${HOME}/.local/bin/kubectl" ]]; then
  require_kubectl
  export KUBECONFIG="${KUBECONFIG_PATH}"
  if kubectl cluster-info >/dev/null 2>&1; then
    report "AKS API reachable" true

    READY_NODES="$(kubectl get nodes --no-headers 2>/dev/null | grep -c ' Ready ' || echo 0)"
    report "AKS nodes Ready" "$([[ "${READY_NODES}" -ge 1 ]] && echo true || echo false)" "${READY_NODES} node(s)"

    M8_READY="$(kubectl -n sre-demo get deploy magic8ball -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
    report "Magic 8 Ball pods ready" "$([[ "${M8_READY:-0}" -ge 1 ]] && echo true || echo false)" "${M8_READY:-0} ready"

    RUNNER_READY="$(kubectl -n sre-demo get deploy scenario-runner -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)"
    report "scenario-runner ready" "$([[ "${RUNNER_READY:-0}" -ge 1 ]] && echo true || echo false)" "${RUNNER_READY:-0} ready"

    PENDING="$(kubectl -n sre-demo get pods --field-selector=status.phase=Pending --no-headers 2>/dev/null | wc -l | tr -d ' ')"
    report "No pods pending at baseline" "$([[ "${PENDING}" == "0" ]] && echo true || echo false)" "${PENDING} pending"

    BURNER="$(kubectl -n sre-demo get deploy resource-burner -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)"
    report "Resource pressure workload idle" "$([[ "${BURNER:-0}" == "0" ]] && echo true || echo false)" "${BURNER:-0} replicas"
  else
    report "AKS API reachable" false "kubeconfig ${KUBECONFIG_PATH}"
  fi
else
  skip "Kubernetes checks (kubectl unavailable)"
fi

# --- Networking -------------------------------------------------------------

step "Networking"
DENY_RULE="$(az network nsg rule show -g "${RESOURCE_GROUP}" \
  --nsg-name "$(state_get databaseNsgName)" -n sre-demo-deny-postgres --query name -o tsv 2>/dev/null || echo '')"
report "No scenario NSG deny rule present" "$([[ -z "${DENY_RULE}" ]] && echo true || echo false)" \
  "${DENY_RULE:-none}"

PG_PUBLIC_IP="$(az vm list-ip-addresses -g "${RESOURCE_GROUP}" -n "${PG_VM_NAME}" \
  --query "[0].virtualMachine.network.publicIpAddresses | length(@)" -o tsv 2>/dev/null || echo 0)"
report "PostgreSQL has no public IP" "$([[ "${PG_PUBLIC_IP}" == "0" ]] && echo true || echo false)"

# --- Telemetry --------------------------------------------------------------

step "Telemetry"
LAW_GUID="$(az monitor log-analytics workspace show -g "${RESOURCE_GROUP}" \
  -n "$(state_get logAnalyticsName)" --query customerId -o tsv 2>/dev/null || true)"

if [[ -n "${LAW_GUID}" ]]; then
  # The REST API rather than `az monitor log-analytics query`: the CLI extension
  # loads slowly enough to exceed any sensible timeout, which previously made
  # healthy telemetry look like a failure.
  la_count() {
    timeout 45 az rest --method post \
      --url "https://api.loganalytics.io/v1/workspaces/${LAW_GUID}/query" \
      --resource "https://api.loganalytics.io" \
      --body "{\"query\":\"$1\"}" -o json 2>/dev/null \
      | jq -r '.tables[0].rows[0][0] // 0' 2>/dev/null || echo 0
  }

  ROWS="$(la_count 'union isfuzzy=true AppMetrics, AppRequests, AppDependencies | where TimeGenerated > ago(30m) | count')"
  report "Application telemetry reaching Log Analytics" \
    "$([[ "${ROWS}" != "0" ]] && echo true || echo false)" \
    "${ROWS} row(s) in the last 30 minutes (allow 5-10 min after deployment)"

  CUSTOM="$(la_count 'AppMetrics | where TimeGenerated > ago(30m) | where Name startswith "sre_demo_" | count')"
  report "Custom sre_demo_ metrics present" \
    "$([[ "${CUSTOM}" != "0" ]] && echo true || echo false)" "${CUSTOM} row(s)"

  CROWS="$(la_count 'KubePodInventory | where TimeGenerated > ago(30m) | where Namespace == "sre-demo" | count')"
  report "Container Insights collecting AKS data" \
    "$([[ "${CROWS}" != "0" ]] && echo true || echo false)" \
    "${CROWS} row(s) (Container Insights can take 10-15 min on a new cluster)"
else
  skip "Log Analytics queries (workspace unknown)"
fi

ALERT_COUNT="$(az monitor scheduled-query list -g "${RESOURCE_GROUP}" --query "length(@)" -o tsv 2>/dev/null || echo 0)"
report "Azure Monitor alert rules created" "$([[ "${ALERT_COUNT}" -ge 6 ]] && echo true || echo false)" "${ALERT_COUNT} rule(s)"

# --- Summary ----------------------------------------------------------------

printf '\n%s%s%s\n' "${C_BOLD}" "----------------------------------------" "${C_RESET}"
printf '%sPASS%s %d   %sFAIL%s %d   %sSKIP%s %d\n' \
  "${C_GREEN}" "${C_RESET}" "${PASS_COUNT}" \
  "${C_RED}" "${C_RESET}" "${FAIL_COUNT}" \
  "${C_YELLOW}" "${C_RESET}" "${SKIP_COUNT}"

if (( FAIL_COUNT > 0 )); then
  printf '\n%sValidation failed.%s See docs/TROUBLESHOOTING.md.\n' "${C_RED}" "${C_RESET}"
  exit 1
fi
printf '\n%sLab is healthy and ready to demonstrate.%s\n' "${C_GREEN}" "${C_RESET}"
