#!/bin/bash
set -euo pipefail

tmp="$(mktemp -d)"
server_pid=''
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT

openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/ca-key.pem"
openssl req -new -x509 -key "$tmp/ca-key.pem" -out "$tmp/ca.pem" -days 1 \
  -subj '/CN=Verity smoke CA' \
  -addext 'basicConstraints=critical,CA:true,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/key.pem"
openssl req -new -key "$tmp/key.pem" -out "$tmp/leaf.csr" -subj '/CN=127.0.0.1'
printf '%s\n' \
  'subjectAltName=IP:127.0.0.1' \
  'basicConstraints=critical,CA:false' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' >"$tmp/leaf.ext"
openssl x509 -req -in "$tmp/leaf.csr" -CA "$tmp/ca.pem" -CAkey "$tmp/ca-key.pem" \
  -set_serial 1 -out "$tmp/leaf.pem" -days 1 -extfile "$tmp/leaf.ext"
cat "$tmp/leaf.pem" "$tmp/ca.pem" >"$tmp/cert.pem"
pin="sha256-$(openssl pkey -in "$tmp/key.pem" -pubout -outform DER | tail -c 65 | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=\n')"

cp scripts/ios-pinned-tls-smoke.swift "$tmp/main.swift"
swiftc apps/mobile/native/CertificatePinDelegate.swift "$tmp/main.swift" -o "$tmp/smoke"
python3 - "$tmp/cert.pem" "$tmp/key.pem" <<'PY' &
import http.server, ssl, sys
server = http.server.HTTPServer(('127.0.0.1', 18443), http.server.SimpleHTTPRequestHandler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[1], sys.argv[2])
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
PY
server_pid=$!

for _ in {1..20}; do
  if nc -z 127.0.0.1 18443; then break; fi
  sleep 0.1
done
"$tmp/smoke" 'https://127.0.0.1:18443/' "$pin" success
"$tmp/smoke" 'https://127.0.0.1:18443/' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' PIN_MISMATCH
# A matching key must not erase the TLS hostname check. This catches a fallback
# to basic X.509 evaluation, which would accept this certificate for localhost.
"$tmp/smoke" 'https://localhost:18443/' "$pin" PINNED_LEAF_TRUST_FAILED
echo 'Pinned TLS smoke test passed'
