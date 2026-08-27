#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# no-committed-secrets.sh — verifies that nothing sensitive is tracked by git.
#
# Checks what git actually TRACKS rather than what is on disk, because the risk
# is committing a file, not creating one locally.
# -----------------------------------------------------------------------------

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

FAILURES=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; FAILURES=$(( FAILURES + 1 )); }

echo "Committed secret checks"

TRACKED="$(git ls-files 2>/dev/null || true)"
if [[ -z "${TRACKED}" ]]; then
  echo "  SKIP  not a git repository"
  exit 0
fi

# --- Forbidden file types ---------------------------------------------------
check_pattern() {
  local label="$1" pattern="$2"
  local hits
  hits="$(echo "${TRACKED}" | grep -E "${pattern}" || true)"
  if [[ -z "${hits}" ]]; then
    pass "${label}"
  else
    fail "${label} — tracked:"; echo "${hits}" | sed 's/^/         /'
  fi
}

check_pattern "No private keys tracked"            '\.(key|pem|pfx|p12)$'
check_pattern "No certificates tracked"            '^certs/|\.(crt|csr)$'
check_pattern "No .secrets directory tracked"      '^\.secrets/'
check_pattern "No kubeconfig tracked"              'kubeconfig'
check_pattern "No .env file tracked"               '(^|/)\.env$'
check_pattern "No lab state tracked"               '\.lab-state.*\.json$'
check_pattern "No SSH keys tracked"                'id_rsa|id_ed25519'
check_pattern "No service principal file tracked"  'sp-credentials|azureauth'

# --- .env.example must exist and be clean -----------------------------------
if [[ -f .env.example ]]; then
  pass ".env.example is present"
  # Any assignment with a long value that looks like a real credential.
  if grep -qiE '^(.*password|.*secret|.*token|.*key)=.{12,}' .env.example; then
    fail ".env.example appears to contain a real value"
    grep -inE '^(.*password|.*secret|.*token|.*key)=.{12,}' .env.example | sed 's/^/         /'
  else
    pass ".env.example contains no credential values"
  fi
else
  fail ".env.example is missing"
fi

# --- .gitignore coverage ----------------------------------------------------
for entry in '.env' 'certs/' '.secrets/' '.lab-state.json' '*.key' '*.pem'; do
  if grep -qF -- "${entry}" .gitignore 2>/dev/null; then
    pass ".gitignore covers ${entry}"
  else
    fail ".gitignore does NOT cover ${entry}"
  fi
done

# --- Credential-shaped strings in tracked source ----------------------------
# Excludes docs, which legitimately show placeholders and example commands.
SOURCE_FILES="$(echo "${TRACKED}" | grep -E '\.(ts|tsx|js|mjs|sh|bicep|ya?ml|json)$' | grep -v '^docs/' || true)"
if [[ -n "${SOURCE_FILES}" ]]; then
  HITS="$(grep -InE "(password|secret|token)\s*[:=]\s*['\"][A-Za-z0-9+/]{16,}['\"]" ${SOURCE_FILES} 2>/dev/null \
    | grep -viE 'secretKeyRef|secretName|@secure|process\.env|placeholder|example|REPLACE_ME|str\(|param ' || true)"
  if [[ -z "${HITS}" ]]; then
    pass "No credential-shaped literals in tracked source"
  else
    fail "Possible committed credential(s):"; echo "${HITS}" | head -10 | sed 's/^/         /'
  fi
fi

echo
if (( FAILURES > 0 )); then
  printf 'Secret checks FAILED (%d problem(s)).\n' "${FAILURES}" >&2
  exit 1
fi
printf 'No committed secrets detected.\n'
