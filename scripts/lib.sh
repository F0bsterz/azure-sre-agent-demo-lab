#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Shared helpers for the lab scripts.
#
# Sourced by deploy.sh, validate.sh, reset-lab.sh, stop-lab.sh, start-lab.sh and
# destroy-lab.sh. Keeps state in .lab-state.json at the repository root, which is
# git-ignored and is what makes the lifecycle scripts usable without re-passing
# every parameter.
# -----------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="${REPO_ROOT}/.lab-state.json"

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_BOLD=$'\033[1m'
else
  C_RESET=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""
fi

log()      { printf '%s[%s]%s %s\n' "${C_DIM}" "$(date -u +%H:%M:%S)" "${C_RESET}" "$*"; }
info()     { printf '%s==>%s %s\n' "${C_BLUE}" "${C_RESET}" "$*"; }
step()     { printf '\n%s==> %s%s\n' "${C_BOLD}${C_BLUE}" "$*" "${C_RESET}"; }
ok()       { printf '%s  PASS%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn()     { printf '%s  WARN%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
fail()     { printf '%s  FAIL%s %s\n' "${C_RED}" "${C_RESET}" "$*" >&2; }
die()      { fail "$*"; exit 1; }

# --- Tooling ---------------------------------------------------------------

require_tool() {
  local tool="$1" hint="${2:-}"
  if ! command -v "${tool}" >/dev/null 2>&1; then
    die "Required tool '${tool}' was not found on PATH. ${hint}"
  fi
}

require_core_tools() {
  require_tool az "Install: https://learn.microsoft.com/cli/azure/install-azure-cli"
  require_tool jq "Install jq, e.g. 'apt-get install jq' or 'brew install jq'."
  require_tool openssl "Install OpenSSL."
}

require_kubectl() {
  if command -v kubectl >/dev/null 2>&1; then return 0; fi
  if [[ -x "${HOME}/.local/bin/kubectl" ]]; then
    export PATH="${HOME}/.local/bin:${PATH}"
    return 0
  fi
  die "kubectl was not found. Install it, or run: az aks install-cli"
}

# --- Azure -----------------------------------------------------------------

require_azure_login() {
  if ! az account show >/dev/null 2>&1; then
    die "Not signed in to Azure. Run 'az login' (or 'az login --use-device-code') and retry."
  fi
}

# --- State -----------------------------------------------------------------

state_write() {
  # Usage: state_write <<< "$json"
  cat > "${STATE_FILE}"
  chmod 600 "${STATE_FILE}"
}

state_get() {
  local key="$1" fallback="${2:-}"
  if [[ ! -f "${STATE_FILE}" ]]; then
    printf '%s' "${fallback}"
    return 0
  fi
  local value
  value="$(jq -r --arg k "${key}" '.[$k] // empty' "${STATE_FILE}" 2>/dev/null || true)"
  printf '%s' "${value:-${fallback}}"
}

require_state() {
  [[ -f "${STATE_FILE}" ]] ||
    die "No lab state found at ${STATE_FILE}. Run scripts/deploy.sh first, or set RESOURCE_GROUP and AZURE_SUBSCRIPTION_ID."
}

# --- Environment file ------------------------------------------------------

load_env_file() {
  local file="${REPO_ROOT}/.env"
  [[ -f "${file}" ]] || return 0
  info "Loading configuration from .env"
  # Only export simple KEY=VALUE lines; ignore comments and blanks.
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" =~ ^[[:space:]]*# ]] && continue
    [[ "${line}" =~ ^[[:space:]]*$ ]] && continue
    [[ "${line}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    local key="${line%%=*}"
    local value="${line#*=}"
    value="${value%\"}"; value="${value#\"}"
    # Command-line arguments and pre-set variables win over the file.
    if [[ -z "${!key:-}" ]]; then
      export "${key}=${value}"
    fi
  done < "${file}"
}

# --- Misc ------------------------------------------------------------------

random_suffix() {
  # Lowercase alphanumeric, safe for storage-style names.
  local hex
  hex="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '%s' "${hex:0:6}"
}

# Reads a BOUNDED amount of entropy and slices in the shell.
#
# The obvious `tr -dc ... < /dev/urandom | head -c 32` cannot be used here: head
# closes the pipe after 32 bytes, tr dies with SIGPIPE (141), `set -o pipefail`
# propagates that as the pipeline's status and `set -e` then aborts the script.
# Bounding the producer means every stage exits 0.
generate_password() {
  local raw
  raw="$(head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  if (( ${#raw} < 32 )); then
    raw="${raw}$(date +%s%N | sha256sum | cut -c1-32)"
  fi
  # Alphanumeric only: avoids quoting hazards in psql, YAML and shell.
  printf '%s' "${raw:0:32}"
}

detect_public_ip() {
  local ip=""
  for endpoint in "https://api.ipify.org" "https://ifconfig.me/ip" "https://icanhazip.com"; do
    ip="$(curl -fsS --max-time 8 "${endpoint}" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "${ip}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
      printf '%s' "${ip}"
      return 0
    fi
  done
  return 1
}

confirm() {
  local prompt="$1"
  if [[ "${ASSUME_YES:-false}" == "true" ]]; then return 0; fi
  read -r -p "${prompt} [y/N] " reply
  [[ "${reply}" =~ ^[Yy]$ ]]
}

# Retries a command with linear backoff. Azure control-plane calls are eventually
# consistent often enough that this matters more than it should.
retry() {
  local attempts="$1"; shift
  local delay="${RETRY_DELAY:-10}"
  local attempt=1
  until "$@"; do
    if (( attempt >= attempts )); then
      return 1
    fi
    warn "Attempt ${attempt}/${attempts} failed; retrying in ${delay}s..."
    sleep "${delay}"
    attempt=$(( attempt + 1 ))
  done
  return 0
}
