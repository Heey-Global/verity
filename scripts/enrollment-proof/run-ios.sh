#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Requires macOS, Xcode and an available iOS 17+ simulator.' >&2
  exit 2
fi
tmp="$(mktemp -d)"
simulator=''
cleanup() {
  if [[ -n "$simulator" ]]; then
    xcrun simctl shutdown "$simulator" >/dev/null 2>&1 || true
    xcrun simctl delete "$simulator" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
selection="$(xcrun simctl list -j | python3 -c '
import json,sys
x=json.load(sys.stdin)
rs=[r for r in x["runtimes"] if r.get("isAvailable") and "iOS" in r["name"] and int(r["version"].split(".")[0])>=17]
if not rs: raise SystemExit("No available iOS 17+ runtime")
r=max(rs,key=lambda v:tuple(map(int,v["version"].split("."))))
supported={d["identifier"] for d in r.get("supportedDeviceTypes",[])}
ds=[d["identifier"] for d in x["devicetypes"] if d["name"].startswith("iPhone") and (not supported or d["identifier"] in supported)]
if not ds: raise SystemExit("No supported iPhone")
print(r["identifier"],sorted(ds)[-1])
')"
read -r runtime device <<<"$selection"
simulator="$(xcrun simctl create 'Verity enrollment proof' "$device" "$runtime")"
xcrun simctl boot "$simulator"
xcrun simctl bootstatus "$simulator" -b
app="$tmp/EnrollmentProof.app"
mkdir -p "$app"
xcrun swiftc -parse-as-library -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -target "$(uname -m)-apple-ios17.0-simulator" scripts/enrollment-proof/IOSProof.swift \
  -framework UIKit -o "$app/EnrollmentProof"
python3 - "$app/Info.plist" <<'PY'
import plistlib,sys
with open(sys.argv[1], 'wb') as f:
 plistlib.dump(dict(CFBundleExecutable='EnrollmentProof', CFBundleIdentifier='app.verity.enrollment-proof',
 CFBundleName='EnrollmentProof',CFBundlePackageType='APPL',CFBundleShortVersionString='1.0',
 CFBundleVersion='1',CFBundleSupportedPlatforms=['iPhoneSimulator'],MinimumOSVersion='17.0',
 LSRequiresIPhoneOS=True,UILaunchScreen={}),f)
PY
# The standalone simulator app has no Xcode-generated signing identity.
# Without an application identifier, securityd rejects SecItemAdd with -34018.
python3 - "$app/Info.plist" "$tmp/Entitlements.plist" <<'PYENT'
import plistlib,sys
with open(sys.argv[1], 'rb') as f:
 identifier = plistlib.load(f)['CFBundleIdentifier']
with open(sys.argv[2], 'wb') as f:
 plistlib.dump({'application-identifier': identifier,
               'keychain-access-groups': [identifier]}, f)
PYENT
codesign --force --sign - --entitlements "$tmp/Entitlements.plist" "$app" >/dev/null
codesign --verify --strict "$app"
codesign --display --entitlements - "$app" > "$tmp/SignedEntitlements.plist"
python3 - "$tmp/Entitlements.plist" "$tmp/SignedEntitlements.plist" <<'PYENT'
import plistlib,sys
with open(sys.argv[1], 'rb') as f:
 expected = plistlib.load(f)
with open(sys.argv[2], 'rb') as f:
 actual = plistlib.load(f)
if actual != expected:
 raise SystemExit('Simulator Keychain entitlements missing from signed app')
PYENT
xcrun simctl install "$simulator" "$app"
container="$(xcrun simctl get_app_container "$simulator" app.verity.enrollment-proof data)"
result="$container/Documents/result.txt"
service="verity.enrollment.ios.$(uuidgen)"
for phase in create verify; do
  rm -f "$result"
  SIMCTL_CHILD_VERITY_PROOF_PHASE="$phase" SIMCTL_CHILD_VERITY_PROOF_SERVICE="$service" \
    xcrun simctl launch "$simulator" app.verity.enrollment-proof
  for _ in {1..60}; do
    [[ -f "$result" ]] && break
    sleep 1
  done
  if [[ ! -f "$result" ]]; then echo "No result for $phase" >&2; exit 1; fi
  cat "$result"
  [[ "$(cat "$result")" == success ]] || exit 1
  # A fresh process must retrieve the original key; it cannot reuse process memory.
  xcrun simctl terminate "$simulator" app.verity.enrollment-proof
 done
echo 'PASS: iOS attributes, key continuity across app launches, signing and deletion'
