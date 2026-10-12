#!/bin/bash
# Actual App/Core production code through a separately built local Uplink test adapter.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This native smoke requires macOS, Xcode and (for ios) an iOS simulator.' >&2
  exit 2
fi
platform="${1:-macos}"
uplink_root="${2:?Expected an Uplink checkout with its integration adapter built}"
[[ "$platform" == macos || "$platform" == ios ]] || { echo 'usage: run-apple.sh [macos|ios] UPLINK_CHECKOUT' >&2; exit 2; }
[[ -f "$uplink_root/packages/uplink/dist/testing/remote-integration-fixture.js" ]] || { echo 'Build the actual Uplink integration adapter first.' >&2; exit 2; }
[[ -f packages/server/dist/remote-control-connector.js ]] || { echo 'Build Core first: npx tsc -b packages/server' >&2; exit 2; }
umask 077
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
start_fixture() {
node scripts/remote-control-integration/fixture.ts "$uplink_root" "$tmp" "$pin" >"$tmp/fixture.log" 2>&1 &
fixture_pid=$!
for _ in {1..100}; do
  [[ -s "$tmp/manifest.json" ]] && break
  kill -0 "$fixture_pid" 2>/dev/null || { echo 'Local fixture failed before readiness.' >&2; exit 1; }
  sleep 0.1
done
[[ -s "$tmp/manifest.json" ]] || { echo 'Local fixture readiness timed out.' >&2; exit 1; }
}
sources=(apps/mobile/native/RemoteDataDiagnostics.swift apps/mobile/native/RemoteAppTunnel.swift apps/mobile/native/RemoteSmokeTunnel.swift apps/mobile/native/CertificatePinDelegate.swift apps/mobile/native/PinnedHTTPSessionPool.swift scripts/remote-control-tunnel/NativeProtocol.swift scripts/remote-control-integration/Integration.swift)
verify_result() {
  kill "$fixture_pid"
  wait "$fixture_pid"
  fixture_pid=''
  python3 - "$1" "$tmp/core-result.json" "$tmp/provenance.json" <<'VERIFY'
import json,sys
native,core,provenance=[json.load(open(p)) for p in sys.argv[1:]]
if native.get('success') is not True or core.get('success') is not True:
    raise SystemExit('Native/Core integration assertions failed')
print(json.dumps({'success': True, 'native':native, 'core':core, 'provenance':provenance}))
VERIFY
}
if [[ "$platform" == macos ]]; then
  xcrun swiftc -parse-as-library -target "$(uname -m)-apple-macosx14.0" "${sources[@]}" -o "$tmp/integration"
  start_fixture
  VERITY_INTEGRATION_MANIFEST="$tmp/manifest.json" VERITY_INTEGRATION_RESULT="$tmp/native-result.json" "$tmp/integration"
  verify_result "$tmp/native-result.json"
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
simulator_udid="$(xcrun simctl create 'Verity remote integration' "$device" "$runtime")"
xcrun simctl boot "$simulator_udid"
xcrun simctl bootstatus "$simulator_udid" -b
app="$tmp/VerityRemoteIntegration.app"
mkdir -p "$app"
xcrun swiftc -parse-as-library -module-name VerityRemoteIntegration \
  -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -target "$(uname -m)-apple-ios17.0-simulator" "${sources[@]}" -framework UIKit -o "$app/VerityRemoteIntegration"
python3 - "$app_plist" "$app/Info.plist" <<'PY'
import plistlib,sys
with open(sys.argv[1],'rb') as f: source=plistlib.load(f)
info={'CFBundleExecutable':'VerityRemoteIntegration','CFBundleIdentifier':'app.verity.remote-integration',
'CFBundleName':'VerityRemoteIntegration','CFBundlePackageType':'APPL','CFBundleShortVersionString':'1.0',
'CFBundleVersion':'1','CFBundleSupportedPlatforms':['iPhoneSimulator'],'MinimumOSVersion':'17.0',
'LSRequiresIPhoneOS':True,'UILaunchScreen':{},
# Current iOS SDKs refuse to launch an app without scene adoption.
'UIApplicationSceneManifest':{'UIApplicationSupportsMultipleScenes':False,
  'UISceneConfigurations':{'UIWindowSceneSessionRoleApplication':[{
    'UISceneConfigurationName':'VerityRemoteIntegration',
    'UISceneDelegateClassName':'VerityRemoteIntegration.IntegrationSceneDelegate'}]}}}
if 'NSAppTransportSecurity' in source: info['NSAppTransportSecurity']=source['NSAppTransportSecurity']
with open(sys.argv[2],'wb') as f: plistlib.dump(info,f)
PY
codesign --force --sign - "$app" >/dev/null
xcrun simctl install "$simulator_udid" "$app"
container="$(xcrun simctl get_app_container "$simulator_udid" app.verity.remote-integration data)"
result="$container/Documents/result.txt"
mkdir -p "$(dirname "$result")"
start_fixture
cp "$tmp/manifest.json" "$container/Documents/manifest.json"
SIMCTL_CHILD_VERITY_INTEGRATION_MANIFEST="$container/Documents/manifest.json" \
SIMCTL_CHILD_VERITY_INTEGRATION_RESULT="$result" \
  xcrun simctl launch "$simulator_udid" app.verity.remote-integration
for _ in {1..180}; do
  if [[ -f "$result" ]]; then
    cat "$result"
    verify_result "$result"
    exit 0
  fi
  sleep 1
done
echo 'Native integration timed out without a result.' >&2
exit 1
