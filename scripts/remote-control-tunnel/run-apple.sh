#!/bin/bash
# Test-only native TLS-over-WSS spike. No production credentials or relay.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This native smoke requires macOS, Xcode and (for ios) an iOS simulator.' >&2
  exit 2
fi
platform="${1:-macos}"
[[ "$platform" == macos || "$platform" == ios ]] || { echo 'usage: run-apple.sh [macos|ios]' >&2; exit 2; }
tmp="$(mktemp -d)"
fixture_pid=''
simulator_udid=''
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  if [[ -n "$simulator_udid" ]]; then
    xcrun simctl shutdown "$simulator_udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$simulator_udid" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/ca-key.pem"
openssl req -new -x509 -key "$tmp/ca-key.pem" -out "$tmp/ca.pem" -days 1 \
  -subj '/CN=Remote tunnel test CA' -addext 'basicConstraints=critical,CA:true,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/key.pem"
openssl req -new -key "$tmp/key.pem" -out "$tmp/leaf.csr" -subj '/CN=core.test'
printf '%s\n' 'subjectAltName=DNS:core.test,IP:127.0.0.1' \
  'basicConstraints=critical,CA:false' 'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' >"$tmp/leaf.ext"
openssl x509 -req -in "$tmp/leaf.csr" -CA "$tmp/ca.pem" -CAkey "$tmp/ca-key.pem" \
  -set_serial 1 -out "$tmp/leaf.pem" -days 1 -extfile "$tmp/leaf.ext"
cat "$tmp/leaf.pem" "$tmp/ca.pem" >"$tmp/cert.pem"
pin="sha256-$(openssl pkey -in "$tmp/key.pem" -pubout -outform DER | tail -c 65 | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=\n')"
node scripts/remote-control-tunnel/mock.mjs "$tmp/key.pem" "$tmp/cert.pem" >"$tmp/fixture.json" 2>"$tmp/fixture.log" &
fixture_pid=$!
for _ in {1..100}; do
  [[ -s "$tmp/fixture.json" ]] && break
  kill -0 "$fixture_pid" 2>/dev/null || { cat "$tmp/fixture.log" >&2; exit 1; }
  sleep 0.1
done
relay_port="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["relayPort"])' "$tmp/fixture.json")"
outer_url="wss://127.0.0.1:${relay_port}/tunnel"
sources=(apps/mobile/native/CertificatePinDelegate.swift scripts/remote-control-tunnel/NativeTunnel.swift scripts/remote-control-tunnel/Smoke.swift)
if [[ "$platform" == macos ]]; then
  xcrun swiftc -parse-as-library -target "$(uname -m)-apple-macosx14.0" "${sources[@]}" -o "$tmp/smoke"
  "$tmp/smoke" "$outer_url" "$pin" "$pin"
  exit 0
fi
app_plist="${VERITY_SMOKE_APP_PLIST:-}"
if [[ -z "$app_plist" ]]; then
  project="$(find apps/mobile/ios -maxdepth 1 -name '*.xcodeproj' -print -quit 2>/dev/null || true)"
  [[ -n "$project" ]] || { echo 'Run Expo iOS prebuild first, or set VERITY_SMOKE_APP_PLIST.' >&2; exit 2; }
  app_plist="apps/mobile/ios/$(basename "$project" .xcodeproj)/Info.plist"
fi
[[ -f "$app_plist" ]] || { echo 'Missing app Info.plist.' >&2; exit 2; }
selection="$(xcrun simctl list --json | python3 -c '
import json,sys
x=json.load(sys.stdin)
rs=[r for r in x["runtimes"] if r.get("isAvailable") and "SimRuntime.iOS-" in r["identifier"] and int(r["version"].split(".")[0])>=17]
if not rs: raise SystemExit("An iOS 17+ simulator is required")
r=max(rs,key=lambda a:tuple(map(int,a["version"].split("."))))
supported={d["identifier"] for d in r.get("supportedDeviceTypes",[])}
ds=[d["identifier"] for d in x["devicetypes"] if d["name"].startswith("iPhone") and (not supported or d["identifier"] in supported)]
if not ds: raise SystemExit("No supported iPhone")
print(r["identifier"],sorted(ds)[-1])
')"
read -r runtime device <<<"$selection"
simulator_udid="$(xcrun simctl create 'Verity remote tunnel spike' "$device" "$runtime")"
xcrun simctl boot "$simulator_udid"
xcrun simctl bootstatus "$simulator_udid" -b
app="$tmp/VerityRemoteTunnel.app"
mkdir -p "$app"
xcrun swiftc -parse-as-library -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -target "$(uname -m)-apple-ios17.0-simulator" "${sources[@]}" -framework UIKit -o "$app/VerityRemoteTunnel"
python3 - "$app_plist" "$app/Info.plist" <<'PY'
import plistlib,sys
with open(sys.argv[1],'rb') as f: source=plistlib.load(f)
info={'CFBundleExecutable':'VerityRemoteTunnel','CFBundleIdentifier':'app.verity.remote-tunnel-spike',
'CFBundleName':'VerityRemoteTunnel','CFBundlePackageType':'APPL','CFBundleShortVersionString':'1.0',
'CFBundleVersion':'1','CFBundleSupportedPlatforms':['iPhoneSimulator'],'MinimumOSVersion':'17.0',
'LSRequiresIPhoneOS':True,'UILaunchScreen':{}}
if 'NSAppTransportSecurity' in source: info['NSAppTransportSecurity']=source['NSAppTransportSecurity']
with open(sys.argv[2],'wb') as f: plistlib.dump(info,f)
PY
codesign --force --sign - "$app" >/dev/null
xcrun simctl install "$simulator_udid" "$app"
container="$(xcrun simctl get_app_container "$simulator_udid" app.verity.remote-tunnel-spike data)"
result="$container/Documents/result.txt"
mkdir -p "$(dirname "$result")"
SIMCTL_CHILD_VERITY_TUNNEL_URL="$outer_url" \
SIMCTL_CHILD_VERITY_TUNNEL_OUTER_PIN="$pin" \
SIMCTL_CHILD_VERITY_TUNNEL_CORE_PIN="$pin" \
SIMCTL_CHILD_VERITY_TUNNEL_RESULT="$result" \
  xcrun simctl launch "$simulator_udid" app.verity.remote-tunnel-spike
for _ in {1..180}; do
  if [[ -f "$result" ]]; then
    cat "$result"
    [[ "$(cat "$result")" == success ]] && exit 0
    exit 1
  fi
  sleep 1
done
echo 'Native tunnel smoke timed out without a result.' >&2
exit 1
