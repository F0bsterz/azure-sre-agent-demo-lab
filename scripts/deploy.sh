#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# deploy.sh — end-to-end deployment of the Azure SRE Agent Demo Lab.
#
#   ./scripts/deploy.sh --subscription <id> --location <region>
#
# Designed to be re-runnable. Every step is either idempotent or detects the
# existing resource, so an interrupted deployment can simply be run again.
#
# Container images are built with `az acr build`, not locally. That removes the
# need for a working local Docker daemon, a registry login and a push over the
# operator's connection — the build happens next to the registry.
# -----------------------------------------------------------------------------

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SUBSCRIPTION_ID="${AZURE_SUBSCRIPTION_ID:-}"
LOCATION="${AZURE_LOCATION:-eastus}"
SUFFIX="${LAB_SUFFIX:-}"
ADMIN_CIDR="${ADMIN_CIDR:-}"
SKIP_BUILD=false
SKIP_APPS=false
ASSUME_YES="${ASSUME_YES:-false}"

usage() {
  cat <<'USAGE'
Usage: scripts/deploy.sh [options]

  --subscription <id>    Azure subscription ID (defaults to the current az account)
  --location <region>    Azure region, e.g. eastus, westus3, uksouth (default: eastus)
  --suffix <string>      Reuse a specific lab suffix instead of generating one
  --admin-cidr <cidr>    CIDR allowed to reach SSH, the controller UI and Magic 8 Ball
                         (default: the detected public IP of this machine, as /32)
  --skip-build           Do not rebuild container images
  --skip-apps            Deploy infrastructure only
  --yes                  Do not prompt for confirmation
  -h, --help             Show this help

Examples:
  ./scripts/deploy.sh --subscription 00000000-0000-0000-0000-000000000000 --location eastus
  ./scripts/deploy.sh --location westus3 --admin-cidr 203.0.113.10/32 --yes
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --subscription) SUBSCRIPTION_ID="$2"; shift 2 ;;
    --location) LOCATION="$2"; shift 2 ;;
    --suffix) SUFFIX="$2"; shift 2 ;;
    --admin-cidr) ADMIN_CIDR="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --skip-apps) SKIP_APPS=true; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (use --help)" ;;
  esac
done

load_env_file
: "${LOCATION:=${AZURE_LOCATION:-eastus}}"

START_TIME=$(date +%s)

# --- 1. Tooling -------------------------------------------------------------

step "1/20  Validating required tools"
require_core_tools
require_kubectl
require_tool git
ok "az $(az version --query '\"azure-cli\"' -o tsv 2>/dev/null || echo present), jq, openssl, kubectl, git"

# --- 2. Azure authentication ------------------------------------------------

step "2/20  Validating Azure authentication"
require_azure_login
CURRENT_USER="$(az account show --query user.name -o tsv)"
ok "Signed in as ${CURRENT_USER}"

# --- 3. Subscription --------------------------------------------------------

step "3/20  Selecting subscription"
if [[ -z "${SUBSCRIPTION_ID}" ]]; then
  SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
  info "No --subscription given; using the current one"
fi
az account set --subscription "${SUBSCRIPTION_ID}"
SUBSCRIPTION_NAME="$(az account show --query name -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"
ok "${SUBSCRIPTION_NAME} (${SUBSCRIPTION_ID})"

# --- 4. Region --------------------------------------------------------------

step "4/20  Validating region '${LOCATION}'"
if ! az account list-locations --query "[?name=='${LOCATION}'].name" -o tsv | grep -qx "${LOCATION}"; then
  die "Region '${LOCATION}' is not available on this subscription. List them with: az account list-locations -o table"
fi
ok "Region ${LOCATION} is available"

# --- 5. Resource providers --------------------------------------------------

step "5/20  Ensuring resource providers are registered"
PROVIDERS=(
  Microsoft.Compute Microsoft.Network Microsoft.Storage Microsoft.KeyVault
  Microsoft.ContainerService Microsoft.ContainerRegistry Microsoft.ManagedIdentity
  Microsoft.OperationalInsights Microsoft.Insights Microsoft.Monitor
  Microsoft.AlertsManagement Microsoft.Authorization
)
PENDING=()
for provider in "${PROVIDERS[@]}"; do
  state="$(az provider show -n "${provider}" --query registrationState -o tsv 2>/dev/null || echo NotFound)"
  if [[ "${state}" != "Registered" ]]; then
    info "Registering ${provider} (currently ${state})"
    az provider register -n "${provider}" --only-show-errors >/dev/null 2>&1 || warn "Could not register ${provider}"
    PENDING+=("${provider}")
  fi
done
if (( ${#PENDING[@]} > 0 )); then
  info "Waiting for ${#PENDING[@]} provider registration(s)..."
  for provider in "${PENDING[@]}"; do
    for _ in $(seq 1 30); do
      state="$(az provider show -n "${provider}" --query registrationState -o tsv 2>/dev/null || echo Unknown)"
      [[ "${state}" == "Registered" ]] && break
      sleep 10
    done
    [[ "${state}" == "Registered" ]] && ok "${provider}" || warn "${provider} is ${state}; deployment may fail"
  done
else
  ok "All required providers are registered"
fi

# --- 6. Administrator CIDR --------------------------------------------------

step "6/20  Determining administrator access CIDR"
if [[ -z "${ADMIN_CIDR}" ]]; then
  if detected_ip="$(detect_public_ip)"; then
    ADMIN_CIDR="${detected_ip}/32"
    ok "Detected public IP ${detected_ip}; restricting access to ${ADMIN_CIDR}"
  else
    die "Could not detect your public IP. Pass --admin-cidr <cidr> explicitly. Refusing to default SSH to the whole Internet."
  fi
else
  ok "Using supplied CIDR ${ADMIN_CIDR}"
  [[ "${ADMIN_CIDR}" == "0.0.0.0/0" ]] && warn "ADMIN_CIDR is 0.0.0.0/0 — the lab will be reachable from the entire Internet."
fi

# --- 7. Sizing and quota ----------------------------------------------------

APP_VM_SIZE="${APP_VM_SIZE:-Standard_B2s}"
POSTGRES_VM_SIZE="${POSTGRES_VM_SIZE:-Standard_B2s}"
AKS_NODE_SIZE="${AKS_NODE_SIZE:-Standard_D2as_v7}"
AKS_BASELINE_NODE_COUNT="${AKS_BASELINE_NODE_COUNT:-1}"

step "7/20  Validating VM SKU availability and quota"

# The SKU catalogue is large and the call is slow (~60s), so it is fetched ONCE
# and queried locally. --all is required: without it, SKUs that are restricted
# for this subscription are omitted entirely rather than returned with their
# restriction reason, which makes "unavailable" indistinguishable from
# "does not exist".
SKU_CACHE="$(mktemp)"
info "Fetching the VM SKU catalogue for ${LOCATION} (this takes up to a minute)"
if ! az vm list-skus --location "${LOCATION}" --resource-type virtualMachines --all -o json \
     > "${SKU_CACHE}" 2>/dev/null; then
  echo '[]' > "${SKU_CACHE}"
  warn "Could not read the SKU catalogue; skipping availability checks"
fi

# Only Location-type restrictions actually block a deployment. A Zone-type
# restriction means the SKU is unavailable in specific availability zones but is
# perfectly usable regionally — and this lab pins no zones, so treating those as
# blocking would reject working SKUs (Standard_B2s in several regions, for
# example).
sku_available() {
  local sku="$1"
  jq -e --arg n "${sku}" '
    any(.[];
      .name == $n
      and ([.restrictions[]? | select(.type == "Location")] | length) == 0)
  ' "${SKU_CACHE}" >/dev/null 2>&1
}

sku_restriction() {
  local sku="$1"
  jq -r --arg n "${sku}" '
    first(.[] | select(.name == $n)
      | [.restrictions[]? | "\(.type):\(.reasonCode)"] | unique | join(", "))
    // "not offered in this region"
  ' "${SKU_CACHE}" 2>/dev/null
}

sku_family() {
  local sku="$1"
  jq -r --arg n "${sku}" 'first(.[] | select(.name == $n) | .family) // empty' "${SKU_CACHE}" 2>/dev/null
}

# v7 D-series first: current generation, widely available and the cheapest
# 2 vCPU / 8 GB option. Older generations follow as fallbacks for regions or
# subscriptions where v7 is not yet offered.
#
# B-series is deliberately excluded for AKS: burstable CPU credits make capacity
# behaviour non-deterministic, which would make scenario 02 inconsistent to
# demonstrate.
AKS_SKU_CANDIDATES=(
  "${AKS_NODE_SIZE}"
  Standard_D2as_v7 Standard_D2s_v7 Standard_D2ads_v7 Standard_D2ds_v7
  Standard_D2as_v6 Standard_D2s_v6
  Standard_D2as_v5 Standard_D2s_v5 Standard_D2ads_v5
  Standard_D2s_v4 Standard_D2as_v4 Standard_DS2_v2
)
SELECTED_AKS_SKU=""
for candidate in "${AKS_SKU_CANDIDATES[@]}"; do
  [[ -n "${candidate}" ]] || continue
  if sku_available "${candidate}"; then
    SELECTED_AKS_SKU="${candidate}"
    break
  fi
  info "SKU ${candidate} unavailable in ${LOCATION}: $(sku_restriction "${candidate}")"
done
[[ -n "${SELECTED_AKS_SKU}" ]] || die "No suitable AKS node SKU is available in ${LOCATION}. Try another region with --location."
if [[ "${SELECTED_AKS_SKU}" != "${AKS_NODE_SIZE}" ]]; then
  warn "Substituting AKS node SKU ${AKS_NODE_SIZE} -> ${SELECTED_AKS_SKU} (regional/subscription availability)"
else
  ok "AKS node SKU ${SELECTED_AKS_SKU} is available"
fi

for candidate in "${APP_VM_SIZE}" "${POSTGRES_VM_SIZE}"; do
  sku_available "${candidate}" \
    || warn "SKU ${candidate} may be unavailable in ${LOCATION}: $(sku_restriction "${candidate}")"
done

# Per-family quota matters as much as the regional total: a family limit of zero
# fails the deployment even when plenty of regional cores remain.
USAGE_JSON="$(az vm list-usage --location "${LOCATION}" -o json 2>/dev/null || echo '[]')"
# az returns limit/currentValue as STRINGS, so they are coerced explicitly here.
family_headroom() {
  local family="$1"
  echo "${USAGE_JSON}" | jq -r --arg f "${family}" '
    [.[] | select((.name.value | ascii_downcase) == ($f | ascii_downcase))][0]
    | if . == null then "unknown"
      else ((.limit // 0 | tostring | tonumber) - (.currentValue // 0 | tostring | tonumber) | floor | tostring)
      end
  ' 2>/dev/null || echo "unknown"
}

AKS_FAMILY="$(sku_family "${SELECTED_AKS_SKU}")"
AKS_VCPUS_NEEDED=$(( 2 * AKS_BASELINE_NODE_COUNT + 2 ))   # +2 for the scenario 02 scale-out
if [[ -n "${AKS_FAMILY}" ]]; then
  HEADROOM="$(family_headroom "${AKS_FAMILY}")"
  if [[ "${HEADROOM}" != "unknown" ]] && (( HEADROOM < AKS_VCPUS_NEEDED )); then
    fail "${AKS_FAMILY} quota is insufficient: ${HEADROOM} vCPU available, ${AKS_VCPUS_NEEDED} required."
    die "Request a quota increase for ${AKS_FAMILY} in ${LOCATION}, or deploy to another region."
  fi
  ok "${AKS_FAMILY}: ${HEADROOM} vCPU available, ${AKS_VCPUS_NEEDED} required"
fi

B_HEADROOM="$(family_headroom standardBSFamily)"
if [[ "${B_HEADROOM}" != "unknown" ]] && (( B_HEADROOM < 4 )); then
  fail "standardBSFamily quota is insufficient: ${B_HEADROOM} vCPU available, 4 required for the two lab VMs."
  die "Request a quota increase, or override APP_VM_SIZE and POSTGRES_VM_SIZE in .env."
fi
ok "standardBSFamily: ${B_HEADROOM} vCPU available, 4 required"

# Total regional vCPU headroom across all families.
REQUIRED_VCPUS=$(( 4 + AKS_VCPUS_NEEDED ))
TOTAL_LIMIT="$(echo "${USAGE_JSON}" | jq -r '[.[] | select(.name.value=="cores")][0].limit // 0')"
TOTAL_USED="$(echo "${USAGE_JSON}" | jq -r '[.[] | select(.name.value=="cores")][0].currentValue // 0')"
if [[ "${TOTAL_LIMIT}" != "0" ]]; then
  AVAILABLE=$(( TOTAL_LIMIT - TOTAL_USED ))
  if (( AVAILABLE < REQUIRED_VCPUS )); then
    fail "Regional vCPU quota is insufficient: ${AVAILABLE} available, ${REQUIRED_VCPUS} required in ${LOCATION}."
    die "Request a quota increase, or deploy to a different region with --location."
  fi
  ok "Regional vCPU quota: ${AVAILABLE} available, ${REQUIRED_VCPUS} required"
else
  warn "Could not read regional vCPU quota; continuing"
fi

rm -f "${SKU_CACHE}"

# --- 8. Naming --------------------------------------------------------------

step "8/20  Resolving lab identity"
if [[ -z "${SUFFIX}" ]]; then
  SUFFIX="$(random_suffix)"
  ok "Generated lab suffix: ${SUFFIX}"
else
  ok "Using lab suffix: ${SUFFIX}"
fi
RESOURCE_GROUP="${RESOURCE_GROUP:-rg-sre-demo-${SUFFIX}}"
ADMIN_USERNAME="${ADMIN_USERNAME:-sreadmin}"

echo
info "About to deploy:"
printf '     subscription : %s\n' "${SUBSCRIPTION_NAME}"
printf '     region       : %s\n' "${LOCATION}"
printf '     resource grp : %s\n' "${RESOURCE_GROUP}"
printf '     admin CIDR   : %s\n' "${ADMIN_CIDR}"
printf '     AKS node SKU : %s (%s node baseline)\n' "${SELECTED_AKS_SKU}" "${AKS_BASELINE_NODE_COUNT}"
echo
confirm "Proceed?" || die "Cancelled."

# --- 9. SSH key -------------------------------------------------------------

step "9/20  Preparing SSH key"
SSH_KEY_DIR="${REPO_ROOT}/.secrets"
SSH_KEY_PATH="${SSH_KEY_DIR}/lab_${SUFFIX}_ed25519"
mkdir -p "${SSH_KEY_DIR}"; chmod 700 "${SSH_KEY_DIR}"
if [[ ! -f "${SSH_KEY_PATH}" ]]; then
  ssh-keygen -t ed25519 -N '' -C "sre-demo-lab-${SUFFIX}" -f "${SSH_KEY_PATH}" >/dev/null
  ok "Generated ${SSH_KEY_PATH} (git-ignored)"
else
  ok "Reusing existing key ${SSH_KEY_PATH}"
fi
ADMIN_PUBLIC_KEY="$(cat "${SSH_KEY_PATH}.pub")"

# --- 10. Credentials --------------------------------------------------------

step "10/20  Generating credentials"
PG_APP_PASSWORD="$(generate_password)"
PG_SCENARIO_PASSWORD="$(generate_password)"
RUNNER_TOKEN="$(generate_password)"
ok "Database and runner credentials generated (stored in Key Vault, never in git)"

# --- 11. Resource group -----------------------------------------------------

step "11/20  Creating resource group"
az group create --name "${RESOURCE_GROUP}" --location "${LOCATION}" \
  --tags project=azure-sre-agent-demo environment=demo managedBy=bicep purpose=sre-training \
  --only-show-errors -o none
ok "Resource group ${RESOURCE_GROUP} ready"

# --- 12. Kubernetes version -------------------------------------------------

step "12/20  Selecting a supported GA Kubernetes version"
K8S_VERSION="${AKS_KUBERNETES_VERSION:-}"
if [[ -z "${K8S_VERSION}" ]]; then
  K8S_VERSION="$(az aks get-versions --location "${LOCATION}" -o json 2>/dev/null \
    | jq -r '[.values[]? | select(.isPreview != true) | .version]
             | sort_by(split(".") | map(tonumber)) | last // empty')"
fi
if [[ -n "${K8S_VERSION}" ]]; then
  ok "Kubernetes ${K8S_VERSION} (resolved at deploy time, no patch version pinned)"
else
  warn "Could not resolve a version; AKS will choose the regional default"
fi

# --- 13. Infrastructure -----------------------------------------------------

step "13/20  Deploying Azure infrastructure (Bicep)"
DEPLOYER_OBJECT_ID="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)"
[[ -n "${DEPLOYER_OBJECT_ID}" ]] || DEPLOYER_OBJECT_ID="$(az account show --query user.name -o tsv | xargs -I{} az ad sp show --id {} --query id -o tsv 2>/dev/null || true)"

DEPLOYMENT_NAME="sre-demo-${SUFFIX}-$(date -u +%Y%m%d%H%M%S)"
deploy_infra() {
  local assign_roles="$1"
  az deployment group create \
    --resource-group "${RESOURCE_GROUP}" \
    --name "${DEPLOYMENT_NAME}" \
    --template-file "${REPO_ROOT}/infra/bicep/main.bicep" \
    --parameters \
      suffix="${SUFFIX}" \
      location="${LOCATION}" \
      adminCidr="${ADMIN_CIDR}" \
      adminUsername="${ADMIN_USERNAME}" \
      adminPublicKey="${ADMIN_PUBLIC_KEY}" \
      postgresAppPassword="${PG_APP_PASSWORD}" \
      postgresScenarioPassword="${PG_SCENARIO_PASSWORD}" \
      appVmSize="${APP_VM_SIZE}" \
      postgresVmSize="${POSTGRES_VM_SIZE}" \
      aksNodeVmSize="${SELECTED_AKS_SKU}" \
      aksBaselineNodeCount="${AKS_BASELINE_NODE_COUNT}" \
      kubernetesVersion="${K8S_VERSION}" \
      demoDataDiskSizeGb="${DEMO_DATA_DISK_GB:-16}" \
      postgresMaxConnections="${POSTGRES_MAX_CONNECTIONS:-50}" \
      deployerObjectId="${DEPLOYER_OBJECT_ID}" \
      assignRoles="${assign_roles}" \
    --only-show-errors -o none
}

info "This takes roughly 10-15 minutes (AKS and two VMs)."
DEPLOY_ERR="$(mktemp)"
if ! deploy_infra true 2>"${DEPLOY_ERR}"; then
  DEPLOY_ERROR_TEXT="$(cat "${DEPLOY_ERR}")"
  echo "${DEPLOY_ERROR_TEXT}" | head -20

  # Regional capacity is not something a retry can fix, and it is not a
  # permissions problem — distinguish it so the operator is not sent chasing RBAC.
  if echo "${DEPLOY_ERROR_TEXT}" | grep -qiE "AKSCapacityHeavyUsage|SkuNotAvailable|ZonalAllocationFailed|AllocationFailed|OutOfCapacity"; then
    rm -f "${DEPLOY_ERR}"
    fail "Azure reports insufficient capacity in ${LOCATION}."
    cat <<CAPACITY

This is a regional capacity condition, not a configuration or permission error.
Azure is temporarily refusing new resources of this type in ${LOCATION}.

What to do:

  1. Re-run in another region — everything else about the lab is unchanged:

       ./scripts/destroy-lab.sh --resource-group ${RESOURCE_GROUP} --yes
       ./scripts/deploy.sh --location eastus2

     Regions worth trying: eastus2, westus3, centralus, westus2, canadacentral,
     northeurope, uksouth.

  2. Or wait and retry the same region later — capacity conditions are transient:

       ./scripts/deploy.sh --location ${LOCATION} --suffix ${SUFFIX}

     The deployment is idempotent, so it will reuse everything already created.

The resource group ${RESOURCE_GROUP} has been left in place so you can choose.
CAPACITY
    exit 1
  fi

  # Role assignment failures ARE worth retrying without them: the lab still runs,
  # and the operator can grant the roles separately.
  if echo "${DEPLOY_ERROR_TEXT}" | grep -qiE "AuthorizationFailed|RoleAssignment|does not have permission|Forbidden"; then
    warn "Deployment failed on a permissions error. Retrying without role assignments."
    if deploy_infra false; then
      warn "Deployed WITHOUT role assignments. Grant them manually:"
      cat <<MANUAL

  # The App VM identity needs these for scenarios 02 and 05:
  IDENTITY_ID=\$(az identity show -g ${RESOURCE_GROUP} -n id-sre-demo-${SUFFIX} --query principalId -o tsv)
  az role assignment create --assignee \$IDENTITY_ID --role Contributor \\
     --scope /subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}
  az role assignment create --assignee \$IDENTITY_ID --role AcrPull \\
     --scope \$(az acr show -g ${RESOURCE_GROUP} -n acrsredemo${SUFFIX} --query id -o tsv)
  az aks update -g ${RESOURCE_GROUP} -n aks-sre-demo-${SUFFIX} --attach-acr acrsredemo${SUFFIX}

MANUAL
    else
      rm -f "${DEPLOY_ERR}"
      die "Infrastructure deployment failed. Inspect: az deployment group show -g ${RESOURCE_GROUP} -n ${DEPLOYMENT_NAME}"
    fi
  else
    rm -f "${DEPLOY_ERR}"
    die "Infrastructure deployment failed. Inspect: az deployment group show -g ${RESOURCE_GROUP} -n ${DEPLOYMENT_NAME}"
  fi
fi
rm -f "${DEPLOY_ERR}"

OUTPUTS="$(az deployment group show -g "${RESOURCE_GROUP}" -n "${DEPLOYMENT_NAME}" --query properties.outputs -o json)"
out() { echo "${OUTPUTS}" | jq -r --arg k "$1" '.[$k].value // empty'; }

ACR_NAME="$(out acrName)"
ACR_LOGIN_SERVER="$(out acrLoginServer)"
APPI_CONNECTION_STRING="$(out appInsightsConnectionString)"
APPI_NAME="$(out appInsightsName)"
LAW_NAME="$(out logAnalyticsWorkspaceName)"
LAW_ID="$(out logAnalyticsWorkspaceId)"
KEY_VAULT_NAME="$(out keyVaultName)"
IDENTITY_CLIENT_ID="$(out labIdentityClientId)"
APP_VM_NAME="$(out appVmName)"
APP_VM_IP="$(out appVmPublicIp)"
APP_VM_FQDN="$(out appVmFqdn)"
PG_VM_NAME="$(out postgresVmName)"
PG_PRIVATE_IP="$(out postgresPrivateIp)"
PG_DATABASE="$(out postgresDatabaseName)"
PG_APP_USER="$(out postgresAppUsername)"
PG_SCENARIO_USER="$(out postgresScenarioUsername)"
PG_MAX_CONNECTIONS="$(out postgresMaxConnections)"
AKS_NAME="$(out aksClusterName)"
AKS_NODE_RG="$(out aksNodeResourceGroup)"
AKS_K8S_VERSION="$(out aksKubernetesVersion)"
DB_NSG_NAME="$(out databaseNsgName)"
DEMO_MOUNT_PATH="$(out demoMountPath)"

ok "Infrastructure deployed"
printf '     ACR    : %s\n' "${ACR_LOGIN_SERVER}"
printf '     App VM : %s (%s)\n' "${APP_VM_NAME}" "${APP_VM_IP}"
printf '     PG VM  : %s (%s)\n' "${PG_VM_NAME}" "${PG_PRIVATE_IP}"
printf '     AKS    : %s (k8s %s)\n' "${AKS_NAME}" "${AKS_K8S_VERSION}"

# --- 14. Key Vault ----------------------------------------------------------

step "14/20  Storing secrets in Key Vault"
kv_set() {
  az keyvault secret set --vault-name "${KEY_VAULT_NAME}" --name "$1" --value "$2" \
    --only-show-errors -o none 2>/dev/null || warn "Could not store secret '$1' (check Key Vault RBAC propagation)"
}
# RBAC assignments can take a moment to propagate to the data plane.
sleep 15
kv_set postgres-app-password "${PG_APP_PASSWORD}"
kv_set postgres-scenario-password "${PG_SCENARIO_PASSWORD}"
kv_set scenario-runner-token "${RUNNER_TOKEN}"
ok "Secrets stored in ${KEY_VAULT_NAME}"

# --- 15. Container images ---------------------------------------------------

GIT_COMMIT="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
IMAGE_TAG="${IMAGE_TAG:-${GIT_COMMIT}}"

CONTROLLER_IMAGE="${ACR_LOGIN_SERVER}/scenario-controller:${IMAGE_TAG}"
MAGIC8BALL_STABLE_IMAGE="${ACR_LOGIN_SERVER}/magic8ball:${IMAGE_TAG}"
MAGIC8BALL_BAD_IMAGE="${ACR_LOGIN_SERVER}/magic8ball-bad:${IMAGE_TAG}"
RUNNER_IMAGE="${ACR_LOGIN_SERVER}/scenario-runner:${IMAGE_TAG}"
BURNER_IMAGE="${ACR_LOGIN_SERVER}/resource-burner:${IMAGE_TAG}"

if [[ "${SKIP_BUILD}" == "true" ]]; then
  step "15/20  Skipping image build (--skip-build)"
else
  step "15/20  Building container images in ACR"
  info "Builds run in Azure, so no local Docker daemon or registry push is needed."

  acr_build() {
    local image="$1" dockerfile="$2" context="$3"; shift 3
    info "Building ${image##*/}"
    az acr build --registry "${ACR_NAME}" --image "${image#*/}" \
      --file "${dockerfile}" "${context}" \
      --build-arg APP_VERSION=0.1.0 \
      --build-arg IMAGE_TAG="${IMAGE_TAG}" \
      --build-arg GIT_COMMIT="${GIT_COMMIT}" \
      --build-arg BUILD_TIMESTAMP="${BUILD_TIMESTAMP}" \
      "$@" \
      --only-show-errors -o none
    ok "${image}"
  }

  acr_build "${CONTROLLER_IMAGE}" "${REPO_ROOT}/apps/scenario-controller/Dockerfile" "${REPO_ROOT}/apps/scenario-controller"
  acr_build "${MAGIC8BALL_STABLE_IMAGE}" "${REPO_ROOT}/apps/magic8ball/Dockerfile" "${REPO_ROOT}/apps/magic8ball" --build-arg FAULT_MODE=stable
  # Same source, different build metadata and fault flag: a genuine second
  # deployment for scenario 03 to correlate against.
  acr_build "${MAGIC8BALL_BAD_IMAGE}" "${REPO_ROOT}/apps/magic8ball/Dockerfile" "${REPO_ROOT}/apps/magic8ball" --build-arg FAULT_MODE=bad --build-arg APP_VERSION=0.1.1
  acr_build "${RUNNER_IMAGE}" "${REPO_ROOT}/services/scenario-runner/Dockerfile" "${REPO_ROOT}/services/scenario-runner"
  acr_build "${BURNER_IMAGE}" "${REPO_ROOT}/services/resource-burner/Dockerfile" "${REPO_ROOT}/services/resource-burner"
fi

if [[ "${SKIP_APPS}" == "true" ]]; then
  warn "Skipping application deployment (--skip-apps)"
  exit 0
fi

# --- 16. AKS credentials ----------------------------------------------------

step "16/20  Connecting to AKS"
KUBECONFIG_PATH="${REPO_ROOT}/.secrets/kubeconfig-${SUFFIX}"
az aks get-credentials --resource-group "${RESOURCE_GROUP}" --name "${AKS_NAME}" \
  --file "${KUBECONFIG_PATH}" --overwrite-existing --only-show-errors
export KUBECONFIG="${KUBECONFIG_PATH}"
chmod 600 "${KUBECONFIG_PATH}"
kubectl cluster-info >/dev/null 2>&1 || die "Could not reach the AKS API server"
ok "Connected to ${AKS_NAME}"

# --- 17. TLS certificates ---------------------------------------------------

step "17/20  Generating demo TLS certificates"
FORCE_REGENERATE=true bash "${REPO_ROOT}/scripts/gen-certs.sh" --force >/dev/null
CERT_DIR="${REPO_ROOT}/certs"
ok "Demo CA plus valid and expired server certificates created"

# --- 18. Kubernetes workloads ----------------------------------------------

step "18/20  Deploying Kubernetes workloads"

kubectl apply -f "${REPO_ROOT}/k8s/namespace.yaml" --only-show-errors >/dev/null 2>&1 \
  || kubectl apply -f "${REPO_ROOT}/k8s/namespace.yaml"
kubectl apply -f "${REPO_ROOT}/k8s/rbac/scenario-runner.yaml"

kubectl -n sre-demo create secret generic magic8ball-db \
  --from-literal=password="${PG_APP_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n sre-demo create secret generic magic8ball-telemetry \
  --from-literal=connectionString="${APPI_CONNECTION_STRING}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n sre-demo create secret generic scenario-runner-auth \
  --from-literal=token="${RUNNER_TOKEN}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Both certificate pairs live in the cluster; scenario 06 only ever copies
# between them, so no private key passes through the runner or the controller.
VALID_NOT_AFTER="$(openssl x509 -in "${CERT_DIR}/valid.crt" -noout -enddate | cut -d= -f2)"
EXPIRED_NOT_AFTER="$(openssl x509 -in "${CERT_DIR}/expired.crt" -noout -enddate | cut -d= -f2)"

apply_tls_secret() {
  local name="$1" crt="$2" key="$3" variant="$4" not_after="$5"
  kubectl -n sre-demo create secret tls "${name}" --cert="${crt}" --key="${key}" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl -n sre-demo annotate secret "${name}" \
    "sre-demo/cert-variant=${variant}" "sre-demo/cert-not-after=${not_after}" --overwrite >/dev/null
}
apply_tls_secret magic8ball-tls-valid   "${CERT_DIR}/valid.crt"   "${CERT_DIR}/valid.key"   valid   "${VALID_NOT_AFTER}"
apply_tls_secret magic8ball-tls-expired "${CERT_DIR}/expired.crt" "${CERT_DIR}/expired.key" expired "${EXPIRED_NOT_AFTER}"
apply_tls_secret magic8ball-tls         "${CERT_DIR}/valid.crt"   "${CERT_DIR}/valid.key"   valid   "${VALID_NOT_AFTER}"
ok "TLS secrets installed (active certificate: valid)"

render_manifest() {
  sed \
    -e "s|__MAGIC8BALL_STABLE_IMAGE__|${MAGIC8BALL_STABLE_IMAGE}|g" \
    -e "s|__MAGIC8BALL_BAD_IMAGE__|${MAGIC8BALL_BAD_IMAGE}|g" \
    -e "s|__SCENARIO_RUNNER_IMAGE__|${RUNNER_IMAGE}|g" \
    -e "s|__RESOURCE_BURNER_IMAGE__|${BURNER_IMAGE}|g" \
    -e "s|__POSTGRES_HOST__|${PG_PRIVATE_IP}|g" \
    -e "s|__POSTGRES_DB__|${PG_DATABASE}|g" \
    -e "s|__POSTGRES_USER__|${PG_APP_USER}|g" \
    -e "s|__ADMIN_CIDR__|${ADMIN_CIDR}|g" \
    -e "s|__LAB_SUFFIX__|${SUFFIX}|g" \
    "$1"
}

render_manifest "${REPO_ROOT}/k8s/resource-pressure/deployment.yaml" | kubectl apply -f -
render_manifest "${REPO_ROOT}/k8s/scenario-runner/deployment.yaml" | kubectl apply -f -
render_manifest "${REPO_ROOT}/k8s/magic8ball/deployment.yaml" | kubectl apply -f -

info "Waiting for workloads to become ready..."
kubectl -n sre-demo rollout status deployment/scenario-runner --timeout=300s || warn "scenario-runner rollout is slow"
kubectl -n sre-demo rollout status deployment/magic8ball --timeout=420s || warn "magic8ball rollout is slow"

info "Waiting for load balancer addresses..."
wait_for_lb() {
  local service="$1" attempts=60 ip=""
  for _ in $(seq 1 "${attempts}"); do
    ip="$(kubectl -n sre-demo get svc "${service}" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
    [[ -n "${ip}" ]] && { printf '%s' "${ip}"; return 0; }
    sleep 10
  done
  return 1
}
MAGIC8BALL_IP="$(wait_for_lb magic8ball)" || die "Magic 8 Ball load balancer did not receive an address"
RUNNER_IP="$(wait_for_lb scenario-runner)" || die "scenario-runner internal load balancer did not receive an address"
ok "Magic 8 Ball at ${MAGIC8BALL_IP}, scenario-runner (internal) at ${RUNNER_IP}"

# The certificate must cover the address clients actually use, so reissue now
# that the load balancer IP is known, then install the refreshed pairs.
step "18b/20  Reissuing certificates for the load balancer address"
FORCE_REGENERATE=true bash "${REPO_ROOT}/scripts/gen-certs.sh" --force --ip "${MAGIC8BALL_IP}" >/dev/null
VALID_NOT_AFTER="$(openssl x509 -in "${CERT_DIR}/valid.crt" -noout -enddate | cut -d= -f2)"
EXPIRED_NOT_AFTER="$(openssl x509 -in "${CERT_DIR}/expired.crt" -noout -enddate | cut -d= -f2)"
apply_tls_secret magic8ball-tls-valid   "${CERT_DIR}/valid.crt"   "${CERT_DIR}/valid.key"   valid   "${VALID_NOT_AFTER}"
apply_tls_secret magic8ball-tls-expired "${CERT_DIR}/expired.crt" "${CERT_DIR}/expired.key" expired "${EXPIRED_NOT_AFTER}"
apply_tls_secret magic8ball-tls         "${CERT_DIR}/valid.crt"   "${CERT_DIR}/valid.key"   valid   "${VALID_NOT_AFTER}"
kubectl -n sre-demo rollout restart deployment/magic8ball >/dev/null
kubectl -n sre-demo rollout status deployment/magic8ball --timeout=300s || warn "magic8ball restart is slow"
ok "Certificates now valid for ${MAGIC8BALL_IP}"

# --- 19. App VM -------------------------------------------------------------

step "19/20  Configuring the App VM"
CONTROLLER_ENV_FILE="$(mktemp)"
VM_SCRIPT="$(mktemp)"
trap 'rm -f "${CONTROLLER_ENV_FILE}" "${VM_SCRIPT}"' EXIT

cat > "${VM_SCRIPT}" <<VMSCRIPT
#!/usr/bin/env bash
set -euo pipefail
exec > >(tee -a /var/log/sre-demo-controller-deploy.log) 2>&1
echo "=== controller deploy \$(date -Is) ==="

# cloud-init owns Docker and the demo disk; wait for it to finish.
for _ in \$(seq 1 120); do
  [ -f /var/log/sre-demo-bootstrap-complete ] && break
  sleep 5
done
[ -f /var/log/sre-demo-bootstrap-complete ] || { echo "cloud-init did not complete"; exit 1; }

mkdir -p ${DEMO_MOUNT_PATH}/logs ${DEMO_MOUNT_PATH}/state ${DEMO_MOUNT_PATH}/certs
chmod 0777 ${DEMO_MOUNT_PATH}/logs ${DEMO_MOUNT_PATH}/state

cat > ${DEMO_MOUNT_PATH}/certs/ca.crt <<'CACERT'
$(cat "${CERT_DIR}/ca.crt")
CACERT
chmod 0644 ${DEMO_MOUNT_PATH}/certs/ca.crt

# Pull from ACR with the VM's managed identity — no registry password anywhere.
az login --identity --username ${IDENTITY_CLIENT_ID} --only-show-errors >/dev/null
TOKEN=\$(az acr login --name ${ACR_NAME} --expose-token --output tsv --query accessToken)
echo "\${TOKEN}" | docker login ${ACR_LOGIN_SERVER} --username 00000000-0000-0000-0000-000000000000 --password-stdin
docker pull ${CONTROLLER_IMAGE}

cat > /etc/sre-demo-controller.env <<'ENVFILE'
$(cat <<ENV
PORT=8080
LAB_SUFFIX=${SUFFIX}
AZURE_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}
AZURE_RESOURCE_GROUP=${RESOURCE_GROUP}
AZURE_LOCATION=${LOCATION}
AZURE_CLIENT_ID=${IDENTITY_CLIENT_ID}
KEY_VAULT_NAME=${KEY_VAULT_NAME}
APPLICATIONINSIGHTS_CONNECTION_STRING=${APPI_CONNECTION_STRING}
PGHOST=${PG_PRIVATE_IP}
PGPORT=5432
PGDATABASE=${PG_DATABASE}
PGUSER=${PG_APP_USER}
PGPASSWORD=${PG_APP_PASSWORD}
SCENARIO_PGUSER=${PG_SCENARIO_USER}
SCENARIO_PGPASSWORD=${PG_SCENARIO_PASSWORD}
POSTGRES_MAX_CONNECTIONS=${PG_MAX_CONNECTIONS}
DEMO_MOUNT_PATH=${DEMO_MOUNT_PATH}
DEMO_LOG_DIR=${DEMO_MOUNT_PATH}/logs
DEMO_STATE_DIR=${DEMO_MOUNT_PATH}/state
DEMO_CA_CERT_FILE=${DEMO_MOUNT_PATH}/certs/ca.crt
DISK_SCENARIO_TARGET_PERCENT=${DISK_SCENARIO_TARGET_PERCENT:-88}
AKS_CLUSTER_NAME=${AKS_NAME}
AKS_NODE_POOL=system
AKS_BASELINE_NODE_COUNT=${AKS_BASELINE_NODE_COUNT}
K8S_NAMESPACE=sre-demo
DB_NSG_NAME=${DB_NSG_NAME}
APP_SUBNET_PREFIX=10.20.1.0/24
AKS_SUBNET_PREFIX=10.20.3.0/24
SCENARIO_RUNNER_URL=http://${RUNNER_IP}:8090
SCENARIO_RUNNER_TOKEN=${RUNNER_TOKEN}
MAGIC8BALL_HTTP_URL=http://${MAGIC8BALL_IP}
MAGIC8BALL_HTTPS_URL=https://${MAGIC8BALL_IP}:443
MAGIC8BALL_TLS_SERVERNAME=magic8ball.sre-demo.local
MAGIC8BALL_STABLE_IMAGE=${MAGIC8BALL_STABLE_IMAGE}
MAGIC8BALL_BAD_IMAGE=${MAGIC8BALL_BAD_IMAGE}
SCENARIO_TIMEOUT_MINUTES=${SCENARIO_TIMEOUT_MINUTES:-30}
ALLOW_CONCURRENT_SCENARIOS=${ALLOW_CONCURRENT_SCENARIOS:-false}
APP_VERSION=0.1.0
IMAGE_TAG=${IMAGE_TAG}
GIT_COMMIT=${GIT_COMMIT}
BUILD_TIMESTAMP=${BUILD_TIMESTAMP}
ENV
)
ENVFILE
chmod 0600 /etc/sre-demo-controller.env

docker rm -f sre-scenario-controller >/dev/null 2>&1 || true

# Host networking: the container needs IMDS (169.254.169.254) for its managed
# identity, which is not routable from the default bridge network.
docker run -d \\
  --name sre-scenario-controller \\
  --restart unless-stopped \\
  --network host \\
  --env-file /etc/sre-demo-controller.env \\
  -v ${DEMO_MOUNT_PATH}:${DEMO_MOUNT_PATH} \\
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \\
  ${CONTROLLER_IMAGE}

sleep 8
for _ in \$(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo "controller healthy"
    exit 0
  fi
  sleep 4
done
echo "controller did not become healthy"
docker logs --tail 60 sre-scenario-controller || true
exit 1
VMSCRIPT

info "Running configuration on ${APP_VM_NAME} (this can take a few minutes)..."
RUN_RESULT="$(az vm run-command invoke \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${APP_VM_NAME}" \
  --command-id RunShellScript \
  --scripts "@${VM_SCRIPT}" \
  --query "value[0].message" -o tsv 2>&1 || true)"

if echo "${RUN_RESULT}" | grep -q "controller healthy"; then
  ok "Scenario Controller is running on ${APP_VM_NAME}"
else
  warn "Controller health was not confirmed. Last output:"
  echo "${RUN_RESULT}" | tail -25
fi

# --- 20. Smoke tests and summary -------------------------------------------

step "20/20  Running smoke tests"
CONTROLLER_URL="http://${APP_VM_IP}:8080"
MAGIC8BALL_URL="http://${MAGIC8BALL_IP}"

smoke() {
  local label="$1" url="$2"
  if curl -fsS --max-time 15 "${url}" >/dev/null 2>&1; then ok "${label}"; else fail "${label} (${url})"; fi
}
smoke "Scenario Controller health" "${CONTROLLER_URL}/api/health"
smoke "Scenario Controller lab status" "${CONTROLLER_URL}/api/lab/status"
smoke "Magic 8 Ball health" "${MAGIC8BALL_URL}/healthz"
smoke "Magic 8 Ball version" "${MAGIC8BALL_URL}/api/version"

cat > "${STATE_FILE}" <<STATE
{
  "suffix": "${SUFFIX}",
  "subscriptionId": "${SUBSCRIPTION_ID}",
  "subscriptionName": "${SUBSCRIPTION_NAME}",
  "tenantId": "${TENANT_ID}",
  "location": "${LOCATION}",
  "resourceGroup": "${RESOURCE_GROUP}",
  "adminCidr": "${ADMIN_CIDR}",
  "acrName": "${ACR_NAME}",
  "acrLoginServer": "${ACR_LOGIN_SERVER}",
  "imageTag": "${IMAGE_TAG}",
  "gitCommit": "${GIT_COMMIT}",
  "keyVaultName": "${KEY_VAULT_NAME}",
  "appInsightsName": "${APPI_NAME}",
  "logAnalyticsName": "${LAW_NAME}",
  "logAnalyticsId": "${LAW_ID}",
  "appVmName": "${APP_VM_NAME}",
  "appVmPublicIp": "${APP_VM_IP}",
  "appVmFqdn": "${APP_VM_FQDN}",
  "postgresVmName": "${PG_VM_NAME}",
  "postgresPrivateIp": "${PG_PRIVATE_IP}",
  "postgresDatabase": "${PG_DATABASE}",
  "postgresAppUser": "${PG_APP_USER}",
  "postgresMaxConnections": "${PG_MAX_CONNECTIONS}",
  "aksName": "${AKS_NAME}",
  "aksNodeResourceGroup": "${AKS_NODE_RG}",
  "aksNodeSize": "${SELECTED_AKS_SKU}",
  "aksBaselineNodeCount": "${AKS_BASELINE_NODE_COUNT}",
  "aksKubernetesVersion": "${AKS_K8S_VERSION}",
  "databaseNsgName": "${DB_NSG_NAME}",
  "kubeconfig": "${KUBECONFIG_PATH}",
  "sshKey": "${SSH_KEY_PATH}",
  "adminUsername": "${ADMIN_USERNAME}",
  "controllerUrl": "${CONTROLLER_URL}",
  "magic8ballUrl": "${MAGIC8BALL_URL}",
  "magic8ballHttpsUrl": "https://${MAGIC8BALL_IP}",
  "magic8ballIp": "${MAGIC8BALL_IP}",
  "scenarioRunnerIp": "${RUNNER_IP}",
  "deployedAt": "${BUILD_TIMESTAMP}"
}
STATE
chmod 600 "${STATE_FILE}"

ELAPSED=$(( $(date +%s) - START_TIME ))
cat <<SUMMARY

${C_BOLD}${C_GREEN}Azure SRE Agent Demo Lab deployed in $(( ELAPSED / 60 ))m $(( ELAPSED % 60 ))s${C_RESET}

  Scenario Controller : ${CONTROLLER_URL}
  Magic 8 Ball        : ${MAGIC8BALL_URL}
  Magic 8 Ball (TLS)  : https://${MAGIC8BALL_IP}

  Subscription        : ${SUBSCRIPTION_NAME}
  Region              : ${LOCATION}
  Resource group      : ${RESOURCE_GROUP}
  AKS                 : ${AKS_NAME} (${SELECTED_AKS_SKU}, ${AKS_BASELINE_NODE_COUNT} node, k8s ${AKS_K8S_VERSION})
  Application Insights: ${APPI_NAME}
  Log Analytics       : ${LAW_NAME}
  Key Vault           : ${KEY_VAULT_NAME}

  SSH                 : ssh -i ${SSH_KEY_PATH} ${ADMIN_USERNAME}@${APP_VM_IP}
  kubectl             : export KUBECONFIG=${KUBECONFIG_PATH}

Next steps:
  1. Open the Scenario Controller and confirm all components are HEALTHY.
  2. Wait 5-10 minutes for telemetry to reach Application Insights.
  3. Run ./scripts/validate.sh to confirm the whole lab end to end.
  4. Follow docs/AZURE-SRE-AGENT-SETUP.md to connect Azure SRE Agent.

Lab state written to .lab-state.json (git-ignored).
SUMMARY
