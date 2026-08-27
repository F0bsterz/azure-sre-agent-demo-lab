#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# gen-certs.sh — creates the demo certificate authority and two server
# certificates for Magic 8 Ball: one valid, one already expired.
#
# Why a private CA rather than a public certificate: the lab must be deployable
# into any subscription with no domain, no DNS control and no purchase. A local
# CA gives a genuine TLS failure with genuine validity dates, and because the
# synthetic checker is configured to trust this CA, scenario 06 fails for the
# right reason — expiry — rather than for an unknown issuer.
#
# Backdating is done with `openssl ca -startdate/-enddate`. The simpler
# `openssl x509 -req` route cannot express an absolute validity window before
# OpenSSL 3.2, and this lab must build on the OpenSSL 3.0 that ships with
# current LTS distributions.
#
# Output (git-ignored):
#   certs/ca.crt, ca.key
#   certs/valid.crt,   valid.key
#   certs/expired.crt, expired.key
# -----------------------------------------------------------------------------

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

CERT_DIR="${REPO_ROOT}/certs"
COMMON_NAME="${MAGIC8BALL_CN:-magic8ball.sre-demo.local}"
LB_IP="${MAGIC8BALL_LB_IP:-}"
FORCE="${FORCE_REGENERATE:-false}"

usage() {
  cat <<'USAGE'
Usage: scripts/gen-certs.sh [--cn <common-name>] [--ip <load-balancer-ip>] [--force]

Generates a demo CA plus a valid and an expired server certificate.
Certificates are written to certs/ and are git-ignored.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cn) COMMON_NAME="$2"; shift 2 ;;
    --ip) LB_IP="${LB_IP:+${LB_IP},}$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

require_tool openssl

mkdir -p "${CERT_DIR}"
chmod 700 "${CERT_DIR}"

if [[ -f "${CERT_DIR}/valid.crt" && "${FORCE}" != "true" ]]; then
  info "Certificates already exist in ${CERT_DIR}. Use --force to regenerate."
  exit 0
fi

# Subject Alternative Names. The IP entry matters because the lab is reached by
# load balancer address, not by DNS name.
SAN="DNS:${COMMON_NAME},DNS:magic8ball,DNS:magic8ball.sre-demo.svc.cluster.local,DNS:localhost,IP:127.0.0.1"
# --ip may be given more than once; every address the service is reached on must
# be present or TLS validation fails for a reason unrelated to scenario 06.
if [[ -n "${LB_IP}" ]]; then
  IFS=',' read -ra LB_IPS <<< "${LB_IP}"
  for ip in "${LB_IPS[@]}"; do
    [[ -n "${ip}" ]] && SAN="${SAN},IP:${ip}"
  done
fi

# Portable UTC date arithmetic across GNU and BSD userlands.
utc_stamp() {
  local offset="$1"
  date -u -d "${offset}" +%Y%m%d%H%M%SZ 2>/dev/null \
    || date -u -v"$(printf '%s' "${offset}" | tr -d ' ')" +%Y%m%d%H%M%SZ
}

step "Generating demo certificate authority"
rm -f "${CERT_DIR}"/*.crt "${CERT_DIR}"/*.key "${CERT_DIR}"/*.csr "${CERT_DIR}"/*.cnf
rm -rf "${CERT_DIR}/db"

openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -keyout "${CERT_DIR}/ca.key" -out "${CERT_DIR}/ca.crt" \
  -days 3650 \
  -subj "/C=US/O=Azure SRE Agent Demo Lab/CN=SRE Demo Lab Root CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"
ok "CA created (valid 10 years)"

# `openssl ca` needs a small certificate database alongside its config.
mkdir -p "${CERT_DIR}/db"
: > "${CERT_DIR}/db/index.txt"
echo "1000" > "${CERT_DIR}/db/serial"

cat > "${CERT_DIR}/ca.cnf" <<EOF
[ ca ]
default_ca = CA_default

[ CA_default ]
dir             = ${CERT_DIR}
database        = \$dir/db/index.txt
serial          = \$dir/db/serial
new_certs_dir   = \$dir/db
certificate     = \$dir/ca.crt
private_key     = \$dir/ca.key
default_md      = sha256
policy          = policy_any
email_in_dn     = no
rand_serial     = no
unique_subject  = no
copy_extensions = none
preserve        = no

[ policy_any ]
countryName            = optional
stateOrProvinceName    = optional
organizationName       = optional
organizationalUnitName = optional
commonName             = supplied
emailAddress           = optional

[ req ]
distinguished_name = req_dn

[ req_dn ]

[ server_ext ]
basicConstraints       = CA:FALSE
keyUsage               = critical,digitalSignature,keyEncipherment
extendedKeyUsage       = serverAuth
subjectAltName         = ${SAN}
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid,issuer
EOF

issue_cert() {
  local name="$1" start_date="$2" end_date="$3" description="$4"

  openssl req -newkey rsa:2048 -nodes \
    -keyout "${CERT_DIR}/${name}.key" -out "${CERT_DIR}/${name}.csr" \
    -subj "/C=US/O=Azure SRE Agent Demo Lab/CN=${COMMON_NAME}"

  openssl ca -config "${CERT_DIR}/ca.cnf" -batch -notext \
    -in "${CERT_DIR}/${name}.csr" \
    -out "${CERT_DIR}/${name}.crt" \
    -startdate "${start_date}" \
    -enddate "${end_date}" \
    -extensions server_ext

  rm -f "${CERT_DIR}/${name}.csr"
  ok "${description}: notAfter=$(openssl x509 -in "${CERT_DIR}/${name}.crt" -noout -enddate | cut -d= -f2)"
}

step "Issuing server certificates for ${COMMON_NAME}"

issue_cert "valid" "$(utc_stamp '-1 day')" "$(utc_stamp '+365 days')" "Valid certificate"

# Expired 30 days ago after a normal one-year life: a realistic "nobody renewed
# it" artefact rather than something obviously synthetic.
issue_cert "expired" "$(utc_stamp '-395 days')" "$(utc_stamp '-30 days')" "Expired certificate"

chmod 600 "${CERT_DIR}"/*.key
rm -f "${CERT_DIR}/ca.srl"

step "Verifying the certificates behave as intended"
if openssl verify -CAfile "${CERT_DIR}/ca.crt" "${CERT_DIR}/valid.crt" >/dev/null 2>&1; then
  ok "valid.crt chains to the demo CA and is within its validity window"
else
  die "valid.crt failed verification against the demo CA"
fi

# Must fail ONLY because of expiry. -no_check_time isolates that: if the chain
# verifies with time checking disabled but fails with it enabled, expiry is
# provably the sole reason — which is what makes scenario 06 unambiguous.
if openssl verify -CAfile "${CERT_DIR}/ca.crt" "${CERT_DIR}/expired.crt" >/dev/null 2>&1; then
  die "expired.crt unexpectedly passed verification; the scenario would not fail"
elif openssl verify -no_check_time -CAfile "${CERT_DIR}/ca.crt" "${CERT_DIR}/expired.crt" >/dev/null 2>&1; then
  ok "expired.crt chains correctly but is rejected on validity dates only"
else
  die "expired.crt fails for a reason other than expiry; scenario 06 would be misleading"
fi

info "Certificates written to ${CERT_DIR} (git-ignored)"
