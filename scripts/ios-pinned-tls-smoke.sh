#!/bin/bash
set -euo pipefail

tmp="$(mktemp -d)"
server_pid=''
simulator_udid=''
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$simulator_udid" ]]; then
    xcrun simctl shutdown "$simulator_udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$simulator_udid" >/dev/null 2>&1 || true
  fi
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
"$tmp/smoke" 'https://localhost:18443/' "$pin" PINNED_CHAIN_TRUST_FAILED

# The macOS process above catches Security-framework mistakes but not the second
# trust evaluation performed by iOS CFNetwork. Run the same executable inside an
# iOS simulator so a native release cannot repeat a device-only -1200 failure
# while this smoke remains green.
runtime_id="$(xcrun simctl list runtimes --json | python3 -c '
import json, sys
runtimes = [r for r in json.load(sys.stdin)["runtimes"] if r.get("isAvailable") and r["identifier"].startswith("com.apple.CoreSimulator.SimRuntime.iOS-")]
if not runtimes: raise SystemExit("no available iOS simulator runtime")
print(max(runtimes, key=lambda r: tuple(map(int, r["version"].split("."))))["identifier"])
')"
device_type="$(xcrun simctl list devicetypes --json | python3 -c '
import json, sys
devices = [d for d in json.load(sys.stdin)["devicetypes"] if d["name"].startswith("iPhone")]
if not devices: raise SystemExit("no iPhone simulator device type")
print(devices[0]["identifier"])
')"
simulator_udid="$(xcrun simctl create "Verity pinned TLS smoke" "$device_type" "$runtime_id")"
xcrun simctl boot "$simulator_udid"
xcrun simctl bootstatus "$simulator_udid" -b
simulator_sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
simulator_version="$(xcrun --sdk iphonesimulator --show-sdk-version)"
app="$tmp/VerityPinnedTLSSmoke.app"
mkdir -p "$app"
xcrun swiftc \
  -sdk "$simulator_sdk" \
  -target "$(uname -m)-apple-ios${simulator_version}-simulator" \
  -parse-as-library \
  apps/mobile/native/CertificatePinDelegate.swift \
  scripts/ios-pinned-tls-smoke-app.swift \
  -framework UIKit \
  -o "$app/VerityPinnedTLSSmoke"
cat >"$app/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>VerityPinnedTLSSmoke</string>
  <key>CFBundleIdentifier</key><string>app.verity.pinned-tls-smoke</string>
  <key>CFBundleName</key><string>VerityPinnedTLSSmoke</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSRequiresIPhoneOS</key><true/>
  <key>UILaunchScreen</key><dict/>
</dict></plist>
PLIST
codesign --force --sign - "$app"
xcrun simctl install "$simulator_udid" "$app"
data_container="$(xcrun simctl get_app_container "$simulator_udid" app.verity.pinned-tls-smoke data)"
result_file="$data_container/tmp/pinned-tls-result"
SIMCTL_CHILD_VERITY_SMOKE_ORIGIN='https://127.0.0.1:18443/' \
SIMCTL_CHILD_VERITY_SMOKE_PIN="$pin" \
SIMCTL_CHILD_VERITY_SMOKE_RESULT="$result_file" \
  xcrun simctl launch --terminate-running-process "$simulator_udid" app.verity.pinned-tls-smoke
for _ in {1..150}; do
  [[ -f "$result_file" ]] && break
  sleep 0.2
done
if [[ ! -f "$result_file" ]]; then
  echo 'iOS app smoke did not produce a result within 30 seconds' >&2
  exit 1
fi
result="$(cat "$result_file")"
if [[ "$result" != success ]]; then
  echo "iOS app pinned TLS smoke failed: $result" >&2
  exit 1
fi
echo 'Pinned TLS smoke test passed on macOS and iOS Simulator'
