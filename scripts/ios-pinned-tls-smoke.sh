#!/bin/bash
# Runs from the repository root, after `expo prebuild --platform ios`: the iOS
# half of this smoke reads App Transport Security out of the generated app
# Info.plist. Point VERITY_SMOKE_APP_PLIST at that file to run it standalone.
# It also needs a routable IPv4 address, because loopback is exempt from the
# rules under test — a machine with only a VPN interface cannot run it.
set -euo pipefail

tmp="$(mktemp -d)"
server_pid=''
simulator_udid=''
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$simulator_udid" ]]; then
    xcrun simctl shutdown "$simulator_udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$simulator_udid" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
# Without an explicit exit these resume at the interrupted line, with the
# temporary directory and the simulator already gone.
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# App Transport Security exempts loopback, so a smoke that only ever talks to
# 127.0.0.1 stays green under rules that reject every real Verity server. Serve
# the same certificate on a routable address and let the iOS run use that.
host_ip=''
# The default route often points at a utun interface that carries no IPv4 of its
# own, so an empty address has to fall through to the wired and wireless ones
# rather than being taken as the answer.
for interface in "$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')" en0 en1; do
  [[ -n "$interface" ]] || continue
  host_ip="$(ipconfig getifaddr "$interface" 2>/dev/null || true)"
  if [[ -n "$host_ip" ]]; then break; fi
done
# A self-assigned link-local address routes nowhere and would surface as an
# opaque TLS error minutes later, so it counts as no address at all. The macOS
# cases below still run without one; only the iOS half needs it.
case "$host_ip" in
  127.* | 169.254.*) host_ip='' ;;
esac
san='IP:127.0.0.1'
if [[ -n "$host_ip" ]]; then san="$san,IP:$host_ip"; fi

openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/ca-key.pem"
openssl req -new -x509 -key "$tmp/ca-key.pem" -out "$tmp/ca.pem" -days 1 \
  -subj '/CN=Verity smoke CA' \
  -addext 'basicConstraints=critical,CA:true,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/key.pem"
openssl req -new -key "$tmp/key.pem" -out "$tmp/leaf.csr" -subj '/CN=127.0.0.1'
printf '%s\n' \
  "subjectAltName=$san" \
  'basicConstraints=critical,CA:false' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' >"$tmp/leaf.ext"
openssl x509 -req -in "$tmp/leaf.csr" -CA "$tmp/ca.pem" -CAkey "$tmp/ca-key.pem" \
  -set_serial 1 -out "$tmp/leaf.pem" -days 1 -extfile "$tmp/leaf.ext"
cat "$tmp/leaf.pem" "$tmp/ca.pem" >"$tmp/cert.pem"
pin="sha256-$(openssl pkey -in "$tmp/key.pem" -pubout -outform DER | tail -c 65 | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=\n')"

cp scripts/ios-pinned-tls-smoke.swift "$tmp/main.swift"
swiftc apps/mobile/native/CertificatePinDelegate.swift "$tmp/main.swift" -o "$tmp/smoke"
addresses=(127.0.0.1)
if [[ -n "$host_ip" ]]; then addresses+=("$host_ip"); fi
python3 - "$tmp/cert.pem" "$tmp/key.pem" "${addresses[@]}" <<'PY' &
import http.server, ssl, sys, threading


class Handler(http.server.BaseHTTPRequestHandler):
    # The socket is reachable from the runner's subnet for the ATS case, so this
    # answers a fixed body instead of serving the checkout.
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *args):
        pass


context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[1], sys.argv[2])
# Bound to the addresses under test rather than every interface the runner
# happens to have. All sockets are bound before any is served, so a failed bind
# cannot hide behind an already-answering listener and let the readiness probe
# through.
servers = []
for address in sys.argv[3:]:
    server = http.server.ThreadingHTTPServer((address, 18443), Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    servers.append(server)
for server in servers:
    threading.Thread(target=server.serve_forever, daemon=True).start()
threading.Event().wait()
PY
server_pid=$!

# Both listeners are probed: waiting only on loopback would let the iOS run
# start against an address that never came up and read as a TLS failure.
for address in "${addresses[@]}"; do
  ready=''
  for _ in {1..50}; do
    if nc -z "$address" 18443; then
      ready=1
      break
    fi
    sleep 0.1
  done
  [[ -n "$ready" ]] || {
    echo "TLS smoke server never accepted connections on $address:18443" >&2
    exit 1
  }
done
"$tmp/smoke" 'https://127.0.0.1:18443/' "$pin" success
"$tmp/smoke" 'https://127.0.0.1:18443/' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' PIN_MISMATCH
# A matching key must not erase the TLS hostname check. This catches a fallback
# to basic X.509 evaluation, which would accept this certificate for localhost.
"$tmp/smoke" 'https://localhost:18443/' "$pin" PINNED_CHAIN_TRUST_FAILED

# The macOS process above catches Security-framework mistakes but not the second
# trust evaluation performed by iOS CFNetwork. Run the same executable inside an
# iOS simulator, against a routable address and under the shipping App Transport
# Security rules, so a native release cannot repeat a device-only -1200 failure
# while this smoke remains green.
#
# ATS decides whether CFNetwork keeps a connection our delegate has already
# accepted, so the harness has to run under the dictionary the released app
# ships. Take it from the generated project rather than restating it here, and
# resolve it before anything expensive: a missing prebuild should not cost a
# simulator boot and a compile first.
[[ -n "$host_ip" ]] || {
  echo 'the iOS half needs a routable IPv4 address, because ATS exempts loopback' >&2
  exit 1
}
app_plist="${VERITY_SMOKE_APP_PLIST:-}"
if [[ -z "$app_plist" ]]; then
  # Picking the first match would silently run under a second target's rules.
  # A missing directory has to reach the message below, not abort under set -e.
  app_plist="$(find apps/mobile/ios -maxdepth 2 -name Info.plist -not -path '*/Pods/*' 2>/dev/null || true)"
  [[ "$(printf '%s\n' "$app_plist" | grep -c .)" == 1 ]] || {
    echo "expected exactly one generated app Info.plist, found: ${app_plist:-none}" >&2
    exit 1
  }
fi
[[ -f "$app_plist" ]] || {
  echo "no generated iOS Info.plist at ${app_plist:-apps/mobile/ios}" >&2
  exit 1
}
read -r runtime_id runtime_version device_type < <(xcrun simctl list --json | python3 -c '
import json, sys

data = json.load(sys.stdin)
runtimes = [r for r in data["runtimes"] if r.get("isAvailable") and r["identifier"].startswith("com.apple.CoreSimulator.SimRuntime.iOS-")]
if not runtimes: raise SystemExit("no available iOS simulator runtime")
runtime = max(runtimes, key=lambda r: tuple(map(int, r["version"].split("."))))
# A device type this runtime does not support is refused at create time. Any
# supported iPhone will do; the sort is only there so which one is picked does
# not depend on the order the runner image happens to list them in.
supported = {d["identifier"] for d in runtime.get("supportedDeviceTypes", [])}
devices = sorted(
    d["identifier"]
    for d in data["devicetypes"]
    if d["name"].startswith("iPhone") and (not supported or d["identifier"] in supported)
)
if not devices: raise SystemExit("no iPhone device type for " + runtime["identifier"])
print(runtime["identifier"], runtime["version"], devices[-1])
')
simulator_udid="$(xcrun simctl create "Verity pinned TLS smoke" "$device_type" "$runtime_id")"
xcrun simctl boot "$simulator_udid"
xcrun simctl bootstatus "$simulator_udid" -b
simulator_sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
sdk_version="$(xcrun --sdk iphonesimulator --show-sdk-version)"
# Deriving the deployment target from the SDK alone breaks on any image whose
# newest runtime is older than it: `simctl install` then rejects the bundle for
# requiring an iOS the simulator does not have.
target_version="$(printf '%s\n%s\n' "$sdk_version" "$runtime_version" | sort -V | head -n 1)"
app="$tmp/VerityPinnedTLSSmoke.app"
mkdir -p "$app"
xcrun swiftc \
  -sdk "$simulator_sdk" \
  -target "$(uname -m)-apple-ios${target_version}-simulator" \
  -parse-as-library \
  apps/mobile/native/CertificatePinDelegate.swift \
  scripts/ios-pinned-tls-smoke-app.swift \
  -framework UIKit \
  -o "$app/VerityPinnedTLSSmoke"
cat >"$app/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>VerityPinnedTLSSmoke</string>
  <key>CFBundleIdentifier</key><string>app.verity.pinned-tls-smoke</string>
  <key>CFBundleName</key><string>VerityPinnedTLSSmoke</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
  <key>DTPlatformName</key><string>iphonesimulator</string>
  <!-- Declared, not just compiled in: simctl reads the minimum OS from here, so
       leaving it out means the target chosen above is never actually stated. -->
  <key>MinimumOSVersion</key><string>${target_version}</string>
  <key>LSRequiresIPhoneOS</key><true/>
  <key>UILaunchScreen</key><dict/>
</dict></plist>
PLIST
# Canonical JSON, so the comparison below is about content: PlistBuddy prints a
# dictionary in stored order, and a merge is under no obligation to preserve it.
ats_json() {
  plutil -extract NSAppTransportSecurity json -o - "$1" \
    | python3 -c 'import json, sys; print(json.dumps(json.load(sys.stdin), sort_keys=True))'
}
# An absent key is a valid (strict) configuration; a failed merge is not, and
# would leave the harness testing rules nobody ships.
merged=''
if shipped_ats="$(ats_json "$app_plist" 2>/dev/null)"; then
  /usr/libexec/PlistBuddy -x -c 'Print :NSAppTransportSecurity' "$app_plist" >"$tmp/ats.plist"
  /usr/libexec/PlistBuddy -c 'Add :NSAppTransportSecurity dict' \
    -c "Merge $tmp/ats.plist :NSAppTransportSecurity" "$app/Info.plist"
  # A half-completed merge reads exactly like an app that ships no ATS key, so
  # the copy is compared against its source instead of assumed.
  merged="$(ats_json "$app/Info.plist" 2>/dev/null || true)"
  [[ "$merged" == "$shipped_ats" ]] || {
    echo "App Transport Security did not survive the copy out of $app_plist" >&2
    echo "  shipped: $shipped_ats" >&2
    echo "  copied:  ${merged:-none}" >&2
    exit 1
  }
fi
echo "App Transport Security rules under test (from $app_plist): ${merged:-none — ATS defaults}"
# A rejected bundle or a refused launch is the first thing a new runner image
# breaks, and simctl's one-line message rarely says why. The simulator log does.
simulator_log() {
  xcrun simctl spawn "$simulator_udid" log show --style compact --last 5m \
    --predicate 'process == "VerityPinnedTLSSmoke"' 2>/dev/null | tail -n 40 >&2 || true
}
codesign --force --sign - "$app"
xcrun simctl install "$simulator_udid" "$app" || { simulator_log; exit 1; }
data_container="$(xcrun simctl get_app_container "$simulator_udid" app.verity.pinned-tls-smoke data)"
result_file="$data_container/tmp/pinned-tls-result"
launch_output="$(
  SIMCTL_CHILD_VERITY_SMOKE_ORIGIN="https://$host_ip:18443/" \
  SIMCTL_CHILD_VERITY_SMOKE_WRONG_HOST_ORIGIN='https://localhost:18443/' \
  SIMCTL_CHILD_VERITY_SMOKE_PIN="$pin" \
  SIMCTL_CHILD_VERITY_SMOKE_RESULT="$result_file" \
    xcrun simctl launch --terminate-running-process "$simulator_udid" app.verity.pinned-tls-smoke
)" || { simulator_log; exit 1; }
echo "$launch_output"
app_pid="$(sed -n 's/.*: *\([0-9][0-9]*\) *$/\1/p' <<<"$launch_output")"
if [[ -z "$app_pid" ]]; then
  echo 'no PID in the simctl launch output; a crashed app will only surface at the deadline' >&2
fi
# Three cases at up to 15 seconds each: a budget below that reports a timeout
# where the app was about to report the actual TLS failure.
deadline=$((SECONDS + 120))
while [[ ! -f "$result_file" && $SECONDS -lt $deadline ]]; do
  # An app that has already exited is never going to write the file, and waiting
  # out the deadline only delays the same failure by two minutes.
  if [[ -n "$app_pid" ]] && ! kill -0 "$app_pid" 2>/dev/null; then
    sleep 0.5
    break
  fi
  sleep 0.2
done
if [[ ! -f "$result_file" ]]; then
  echo "iOS app smoke exited or timed out without writing $result_file" >&2
  # A crash, a launch failure and an unwritable result path are otherwise all
  # the same silent timeout. The app's log lines say which one happened.
  simulator_log
  exit 1
fi
result="$(cat "$result_file")"
if [[ "$result" != success ]]; then
  echo "iOS app pinned TLS smoke failed: $result" >&2
  exit 1
fi
# Checked only once the run passed, so the failure above stays the one reported.
# A runner only ever reaches itself over its own subnet, and ATS can be relaxed
# for exactly that subnet — by NSAllowsLocalNetworking, or since iOS 17 by an
# exception keyed to an address or CIDR range. Under either, this run says
# nothing about the routable address a paired server actually has.
python3 - "$merged" <<'PY'
import ipaddress, json, sys

rules = json.loads(sys.argv[1] or '{}')
scoped = ['NSAllowsLocalNetworking'] if rules.get('NSAllowsLocalNetworking') else []
for domain in rules.get('NSExceptionDomains', {}):
    try:
        ipaddress.ip_network(domain, strict=False)
    except ValueError:
        continue  # a hostname exception cannot match the address used here
    scoped.append('NSExceptionDomains:' + domain)
if scoped:
    raise SystemExit('these rules exempt by address, so the iOS run proves nothing: ' + ', '.join(scoped))
PY
echo 'Pinned TLS smoke test passed on macOS and iOS Simulator'
