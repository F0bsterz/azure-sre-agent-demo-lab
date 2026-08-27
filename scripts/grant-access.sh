#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# grant-access.sh — allow an additional address to reach the lab.
#
# The lab is deployed locked to whichever address ran deploy.sh. That is the
# right default, but it makes the environment unreachable from anywhere else —
# a different laptop, a colleague, or simply after your ISP rotates your IP.
#
# This ADDS to the existing allow-lists rather than replacing them, so granting
# access to one machine never silently locks out another.
#
# Covers all three paths in one go:
#   * SSH (22) on the App VM
#   * Scenario Controller UI/API (8080) on the App VM
#   * Magic 8 Ball load balancer (80/443)
# -----------------------------------------------------------------------------

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

CIDR=""
REVOKE=false

usage() {
  cat <<'USAGE'
Usage: scripts/grant-access.sh [--cidr <cidr>] [--revoke]

  --cidr <cidr>   Address to allow, e.g. 203.0.113.10/32 or 203.0.113.0/24.
                  Defaults to this machine's detected public IP as a /32.
  --revoke        Remove the address instead of adding it.
  -h, --help      Show this help.

Examples:
  ./scripts/grant-access.sh                        # allow me, from here
  ./scripts/grant-access.sh --cidr 203.0.113.10/32
  ./scripts/grant-access.sh --cidr 203.0.113.10/32 --revoke
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cidr) CIDR="$2"; shift 2 ;;
    --revoke) REVOKE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

load_env_file
require_core_tools
require_azure_login
require_state

RESOURCE_GROUP="$(state_get resourceGroup)"
SUFFIX="$(state_get suffix)"
SUBSCRIPTION_ID="$(state_get subscriptionId)"
KUBECONFIG_PATH="$(state_get kubeconfig)"
az account set --subscription "${SUBSCRIPTION_ID}" 2>/dev/null || true

if [[ -z "${CIDR}" ]]; then
  if detected="$(detect_public_ip)"; then
    CIDR="${detected}/32"
    info "Detected public IP ${detected}"
  else
    die "Could not detect your public IP. Pass --cidr explicitly."
  fi
fi

[[ "${CIDR}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] \
  || die "Invalid CIDR '${CIDR}'. Expected something like 203.0.113.10/32."

if [[ "${CIDR}" == "0.0.0.0/0" && "${REVOKE}" != "true" ]]; then
  warn "0.0.0.0/0 exposes the Scenario Controller to the entire Internet."
  warn "The controller has no authentication and can inject faults and call Azure."
  confirm "Really allow the whole Internet?" || die "Cancelled."
fi

NSG="nsg-app-${SUFFIX}"

# --- App VM NSG -------------------------------------------------------------

update_rule() {
  local rule="$1" port="$2" priority="$3" description="$4"
  local json existing

  json="$(az network nsg rule show -g "${RESOURCE_GROUP}" --nsg-name "${NSG}" -n "${rule}" -o json 2>/dev/null || true)"

  # Azure stores a single source in sourceAddressPrefix and multiple sources in
  # sourceAddressPrefixes, and populates only one of them. Read both and merge.
  # (JMESPath has no coalesce(), so this cannot be done in --query.)
  if [[ -n "${json}" ]]; then
    existing="$(echo "${json}" | jq -r '
      ([.sourceAddressPrefix] + (.sourceAddressPrefixes // []))
      | map(select(. != null and . != ""))
      | unique | .[]' 2>/dev/null | tr '\n' ' ')"
  else
    existing=""
  fi

  # The rule can legitimately be absent: Defender for Cloud and some governance
  # tooling remove permissive inbound rules after deployment. Recreate it rather
  # than failing, since a missing rule is exactly when access is needed.
  if [[ -z "${existing}" ]]; then
    if [[ "${REVOKE}" == "true" ]]; then
      warn "Rule ${rule} does not exist; nothing to revoke"
      return 0
    fi
    warn "Rule ${rule} is missing; recreating it"
    az network nsg rule create -g "${RESOURCE_GROUP}" --nsg-name "${NSG}" -n "${rule}" \
      --priority "${priority}" --direction Inbound --access Allow --protocol Tcp \
      --source-address-prefixes "${CIDR}" \
      --destination-port-ranges "${port}" --destination-address-prefixes '*' \
      --description "${description}" -o none 2>/dev/null \
      && ok "${rule}: created with ${CIDR}" \
      || fail "Could not create ${rule}"
    return 0
  fi

  local updated=()
  for entry in ${existing}; do
    [[ "${entry}" == "${CIDR}" ]] && continue
    updated+=("${entry}")
  done
  [[ "${REVOKE}" == "true" ]] || updated+=("${CIDR}")

  if (( ${#updated[@]} == 0 )); then
    fail "Refusing to leave ${rule} with no permitted source; that would lock everyone out."
    return 0
  fi

  az network nsg rule update -g "${RESOURCE_GROUP}" --nsg-name "${NSG}" -n "${rule}" \
    --source-address-prefixes "${updated[@]}" -o none 2>/dev/null \
    && ok "${rule}: ${updated[*]}" \
    || fail "Could not update ${rule}"
}

step "$([[ "${REVOKE}" == "true" ]] && echo Revoking || echo Granting) ${CIDR} on the App VM"
update_rule Allow-SSH-Admin 22 200 "Administrative SSH, restricted to the administrator CIDR."
update_rule Allow-Controller-UI-Admin 8080 210 "Scenario Controller UI and API, restricted to the administrator CIDR."

# --- Magic 8 Ball load balancer --------------------------------------------

step "$([[ "${REVOKE}" == "true" ]] && echo Revoking || echo Granting) ${CIDR} on the Magic 8 Ball load balancer"
if require_kubectl && [[ -f "${KUBECONFIG_PATH}" ]]; then
  export KUBECONFIG="${KUBECONFIG_PATH}"
  current="$(kubectl -n sre-demo get svc magic8ball -o jsonpath='{.spec.loadBalancerSourceRanges}' 2>/dev/null || echo '[]')"
  mapfile -t ranges < <(echo "${current}" | jq -r '.[]?' 2>/dev/null || true)

  updated=()
  for entry in "${ranges[@]:-}"; do
    [[ -z "${entry}" || "${entry}" == "${CIDR}" ]] && continue
    updated+=("${entry}")
  done
  [[ "${REVOKE}" == "true" ]] || updated+=("${CIDR}")

  if (( ${#updated[@]} == 0 )); then
    fail "Refusing to leave the load balancer with no permitted source."
  else
    payload="$(printf '%s\n' "${updated[@]}" | jq -R . | jq -sc '{spec:{loadBalancerSourceRanges:.}}')"
    kubectl -n sre-demo patch svc magic8ball --type=merge -p "${payload}" >/dev/null 2>&1 \
      && ok "magic8ball: ${updated[*]}" \
      || fail "Could not patch the magic8ball service"
  fi
else
  warn "kubectl or kubeconfig unavailable; skipped the load balancer"
fi

echo
info "Reach the lab at:"
printf '  Scenario Controller : %s\n' "$(state_get controllerUrl)"
printf '  Magic 8 Ball        : %s\n' "$(state_get magic8ballUrl)"
