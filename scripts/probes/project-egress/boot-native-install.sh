#!/usr/bin/env bash
# Only the disposable KVM guest receives experimental units or runtime configuration.
set -euo pipefail
[[ ${PROJECT_EGRESS_DISPOSABLE:-} == yes && $(id -u) == 0 ]]
[[ $(cat /var/lib/cloud/data/instance-id) == verity-boot-probe ]]
[[ $(cat /proc/1/comm) == systemd ]]
assets=/opt/verity-fixture
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends nftables iptables conntrack iproute2 util-linux acl python3 libatomic1 libstdc++6
cp -a "$assets/runtime/bin/." /usr/local/bin/
cp -a "$assets/runtime/opt/." /opt/
install -m 0755 "$assets/node" /usr/bin/node
ln -sf /usr/local/bin/docker /usr/bin/docker
mkdir -p /etc/docker /etc/verity-egress /opt/verity-egress /var/lib/verity-egress /var/lib/verity-egress-fixture
chmod 0700 /var/lib/verity-egress /var/lib/verity-egress-fixture
chown 1000:1000 /var/lib/verity-egress-fixture
getent group verity-egress-control >/dev/null || groupadd verity-egress-control
getent group 1101 >/dev/null || groupadd --gid 1101 verity-runner
getent group 1102 >/dev/null || groupadd --gid 1102 verity-relay
cp "$assets/runtime/daemon.json" /etc/docker/daemon.json
python3 - <<'PY'
import json
from pathlib import Path
p = Path('/etc/docker/daemon.json')
c = json.loads(p.read_text())
c['live-restore'] = False
c['runtimes']['runsc-relay'] = dict(c['runtimes']['runsc-project'])
c['runtimes']['runsc-relay']['runtimeArgs'] = ['--platform=systrap','--network=sandbox','--host-uds=open']
p.write_text(json.dumps(c))
PY
install -m 0644 "$assets/project-egress-host-main.mjs" /opt/verity-egress/
install -m 0644 "$assets/units/verity-egress-bootstrap.service" "$assets/units/verity-egress-host.service" /etc/systemd/system/
mkdir -p /etc/systemd/system/docker.service.d
install -m 0644 "$assets/units/docker-egress.conf" /etc/systemd/system/docker.service.d/egress.conf
openssl rand -hex 32 > /etc/verity-egress/control.key
chmod 0600 /etc/verity-egress/control.key
(cd "$assets" && sha256sum --check runtime-sha256.txt)
cat > /etc/systemd/system/docker.service <<'UNIT'
[Unit]
Description=Pinned disposable Docker daemon
After=network-online.target
Wants=network-online.target
[Service]
Type=notify
ExecStart=/usr/local/bin/dockerd --host=unix:///var/run/docker.sock --group=verity-egress-control
Restart=on-failure
RestartSec=1
KillMode=process
Delegate=yes
LimitNOFILE=infinity
LimitNPROC=infinity
TasksMax=infinity
TimeoutStartSec=60
TimeoutStopSec=30
[Install]
WantedBy=multi-user.target
UNIT
# The second NIC carries only fixture observation. SSH remains on QEMU usernet.
cat > /etc/systemd/system/verity-boot-observation.service <<'UNIT'
[Unit]
Description=Disposable external observation link
Before=docker.service
After=systemd-udev-settle.service
[Service]
Type=oneshot
ExecStart=/bin/bash -ec 'link=$(for p in /sys/class/net/*; do [ "$(cat "$p/address")" != "52:54:00:be:ef:02" ] || basename "$p"; done); test -n "$link"; ip link set "$link" up; ip addr replace 172.30.105.3/24 dev "$link"; ip -6 addr replace fd42:feed:5::3/64 nodad dev "$link"; sysctl -w net.ipv4.ip_forward=1 net.ipv6.conf.all.forwarding=1'
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
for component in gateway server; do
  dependencies='After=verity-egress-host.service verity-boot-gateway.service'
  if [[ $component == gateway ]]; then dependencies='After=network.target'; fi
  cat > "/etc/systemd/system/verity-boot-$component.service" <<UNIT
[Unit]
Description=Disposable real Verity $component
$dependencies
[Service]
User=1000
Group=1000
Environment=PROJECT_EGRESS_DISPOSABLE=yes
ExecStart=/usr/bin/node /opt/verity-fixture/boot-server.mjs $component
WorkingDirectory=/opt/verity-fixture
SupplementaryGroups=verity-runner verity-relay verity-egress-control
Restart=no
TimeoutStopSec=15
UNIT
done
systemctl daemon-reload
systemctl enable verity-boot-observation.service docker.service
systemctl start verity-boot-observation.service docker.service
# No Server is enabled at boot: recovery must be explicitly verified, then admitted.
docker load --input "$assets/images.tar"
docker volume create verity-boot-data
# The native Server uses the same UID as the actual managed Runner. Give it
# traversal to its volume without exposing Docker's other private state.
setfacl -m u:1000:x /var/lib/docker /var/lib/docker/volumes
fixture_volume_root=$(docker volume inspect --format '{{.Mountpoint}}' verity-boot-data)
setfacl -m u:1000:x "$(dirname "$fixture_volume_root")"
chown 1000:1000 "$fixture_volume_root"
docker run --rm --runtime runsc-project --entrypoint /bin/true verity-boot-observed-runner:local
