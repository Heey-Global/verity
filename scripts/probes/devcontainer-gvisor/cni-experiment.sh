#!/usr/bin/env bash
# Disposable GitHub runner only. Experiment: give every build step its own
# network namespace through CNI instead of BuildKit's host-network default, so
# runsc's sandbox network stack has a real interface to route through.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'GitHub Actions only' >&2; exit 1; }
[[ $EUID == 0 ]] || { echo 'Run as root' >&2; exit 1; }
version=v1.6.2
case "$(uname -m)" in
    x86_64) arch=amd64 sha=b8e811578fb66023f90d2e238d80cec3bdfca4b44049af74c374d4fae0f9c090 ;;
    aarch64) arch=arm64 sha=01e0e22acc7f7004e4588c1fe1871cc86d7ab562cd858e1761c4641d89ebfaa4 ;;
    *) echo "unsupported architecture" >&2; exit 1 ;;
esac
bin=/usr/local/libexec/verity-buildkit/cni-$version
work=$(mktemp -d)
curl -fsSL -o "$work/cni.tgz" "https://github.com/containernetworking/plugins/releases/download/$version/cni-plugins-linux-$arch-$version.tgz"
printf '%s  %s\n' "$sha" "$work/cni.tgz" | sha256sum -c -
install -d -m 0755 "$bin"
tar -xzf "$work/cni.tgz" -C "$bin" ./bridge ./host-local ./loopback ./firewall
install -d -m 0700 /var/lib/verity-buildkit/cni
cat > /etc/verity-buildkit/cni.conflist <<JSON
{
  "cniVersion": "1.0.0",
  "name": "verity-buildkit",
  "plugins": [
    {
      "type": "bridge",
      "bridge": "verity-bk0",
      "isGateway": true,
      "ipMasq": true,
      "hairpinMode": false,
      "ipam": {
        "type": "host-local",
        "dataDir": "/var/lib/verity-buildkit/cni",
        "ranges": [[{ "subnet": "10.213.0.0/24" }]],
        "routes": [{ "dst": "0.0.0.0/0" }]
      }
    },
    { "type": "firewall", "backend": "iptables" }
  ]
}
JSON
python3 - <<'PY'
from pathlib import Path
p = Path('/etc/verity-buildkit/buildkitd.toml')
s = p.read_text()
s = s.replace('[worker.oci]\n  enabled = true\n', '[worker.oci]\n  enabled = true\n  networkMode = "cni"\n  cniConfigPath = "/etc/verity-buildkit/cni.conflist"\n  cniBinaryPath = "/usr/local/libexec/verity-buildkit/cni-v1.6.2"\n', 1)
assert 'networkMode = "cni"' in s
p.write_text(s)
PY
install -d -m 0755 /etc/systemd/system/verity-buildkit.service.d
cat > /etc/systemd/system/verity-buildkit.service.d/cni.conf <<'UNIT'
[Service]
ReadWritePaths=-/run/xtables.lock -/var/lib/cni
UNIT
systemctl daemon-reload
systemctl restart verity-buildkit
for attempt in $(seq 1 30); do
    if [[ -S /run/verity-buildkit/buildkitd.sock ]]; then break; fi
    sleep 1
done
[[ -S /run/verity-buildkit/buildkitd.sock ]]
cat /etc/verity-buildkit/buildkitd.toml
