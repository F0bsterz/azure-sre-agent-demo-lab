#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# no-hardcoded-values.sh — enforces the portability requirement.
#
# The lab must deploy into ANY subscription and region unchanged. That property
# is easy to state and easy to break accidentally, so it is tested: no
# subscription ID, tenant ID, region, resource group, object ID, public IP,
# Kubernetes patch version or password may appear in the templates or manifests.
# -----------------------------------------------------------------------------

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

FAILURES=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; FAILURES=$(( FAILURES + 1 )); }

# Scanned paths: things a customer deploys. Docs legitimately contain examples.
SCAN_PATHS=(infra/bicep k8s)

echo "Portability checks"

# --- GUIDs (subscription, tenant, object IDs) -------------------------------
# Azure built-in role definition IDs are GUIDs and are legitimately constant, so
# they are excluded by name.
KNOWN_ROLE_IDS='7f951dda-4ed3-4680-a7ca-43fe172d538d|b24988ac-6180-42a0-ab88-20f7382dd24c|4633458b-17de-408a-b874-0445c86b69e6|b86a8fe4-44ce-4948-aee5-eccb2c155cd7|3913510d-42f4-4e42-8a64-420c390055eb|00000000-0000-0000-0000-000000000000'

GUID_HITS="$(grep -rInE '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' \
  "${SCAN_PATHS[@]}" 2>/dev/null | grep -vE "${KNOWN_ROLE_IDS}" || true)"
if [[ -z "${GUID_HITS}" ]]; then
  pass "No hardcoded subscription, tenant or object IDs"
else
  fail "Hardcoded GUID(s) found:"; echo "${GUID_HITS}" | head -10
fi

# --- Azure regions ----------------------------------------------------------
REGION_HITS="$(grep -rInE "['\"](eastus2?|westus[0-9]?|centralus|northeurope|westeurope|uksouth|ukwest|canadacentral|australiaeast|southeastasia|japaneast)['\"]" \
  "${SCAN_PATHS[@]}" 2>/dev/null || true)"
if [[ -z "${REGION_HITS}" ]]; then
  pass "No hardcoded Azure region"
else
  fail "Hardcoded region(s) found:"; echo "${REGION_HITS}" | head -10
fi

# --- Kubernetes patch versions ----------------------------------------------
# A pinned patch version rots: it stops being offered within months.
K8S_HITS="$(grep -rInE "kubernetesVersion['\"]?\s*[:=]\s*['\"][0-9]+\.[0-9]+\.[0-9]+" \
  "${SCAN_PATHS[@]}" 2>/dev/null || true)"
if [[ -z "${K8S_HITS}" ]]; then
  pass "No pinned Kubernetes patch version"
else
  fail "Pinned Kubernetes patch version found:"; echo "${K8S_HITS}"
fi

# --- Public IP addresses ----------------------------------------------------
# RFC1918, loopback, link-local, the AKS service CIDR and documentation ranges
# are all legitimate. ARM "contentVersion" and "$schema" values are dotted quads
# by coincidence (1.0.0.0) and are excluded.
IP_HITS="$(grep -rInoE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' "${SCAN_PATHS[@]}" 2>/dev/null \
  | grep -vE ':(10|127|169\.254|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.' \
  | grep -vE '0\.0\.0\.0|255\.255|203\.0\.113|198\.51\.100|192\.0\.2' \
  | grep -vE ':[0-9]\.[0-9]\.[0-9]\.[0-9]$' || true)"
if [[ -z "${IP_HITS}" ]]; then
  pass "No hardcoded public IP addresses"
else
  fail "Hardcoded public IP(s) found:"; echo "${IP_HITS}" | head -10
fi

# --- Credentials ------------------------------------------------------------
SECRET_HITS="$(grep -rInE "(password|secret|token|apikey|api_key)\s*[:=]\s*['\"][^'\"]{8,}['\"]" \
  "${SCAN_PATHS[@]}" 2>/dev/null \
  | grep -viE '@secure|secretKeyRef|secretName|param |description|// |# ' || true)"
if [[ -z "${SECRET_HITS}" ]]; then
  pass "No hardcoded credentials"
else
  fail "Possible hardcoded credential(s):"; echo "${SECRET_HITS}" | head -10
fi

# --- Secure parameters ------------------------------------------------------
for param in postgresAppPassword postgresScenarioPassword; do
  if grep -B2 "param ${param}" infra/bicep/main.bicep 2>/dev/null | grep -q '@secure()'; then
    pass "Parameter ${param} is marked @secure()"
  else
    fail "Parameter ${param} is NOT marked @secure()"
  fi
done

# --- Resource group names ---------------------------------------------------
if grep -rInE "resourceGroup['\"]?\s*[:=]\s*['\"]rg-" infra/bicep 2>/dev/null | grep -v 'nodeResourceGroup' | grep -q .; then
  fail "Hardcoded resource group name found"
else
  pass "No hardcoded resource group name"
fi

echo
if (( FAILURES > 0 )); then
  printf 'Portability checks FAILED (%d problem(s)).\n' "${FAILURES}" >&2
  exit 1
fi
printf 'All portability checks passed.\n'
