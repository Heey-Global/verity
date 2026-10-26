#!/usr/bin/env bash
# Explicit host administration; never invoked automatically by the Server.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root on the Docker host.' >&2; exit 1; }
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# renovate: datasource=docker depName=moby/buildkit
buildkit_image=moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c
builder_gid=${VERITY_BUILDKIT_GID:-1102}
[[ $builder_gid =~ ^[0-9]+$ && $builder_gid -gt 0 && $builder_gid -lt 65535 ]] || { echo 'Invalid VERITY_BUILDKIT_GID' >&2; exit 1; }
existing_gid=$(getent group verity-buildkit | cut -d: -f3 || true)
if [[ -n $existing_gid ]]; then
    [[ $existing_gid == "$builder_gid" ]] || { echo 'verity-buildkit group GID mismatch' >&2; exit 1; }
else
    groupadd --system --gid "$builder_gid" verity-buildkit
fi
# Reuse the host installer's checksum verification and release-version checks.
"$source_dir/../gvisor/install-runsc-host.sh"
source "$source_dir/../gvisor/versions.env"
install -d -m 0755 /usr/local/libexec/verity-buildkit /etc/verity-buildkit
container=
cleanup() { if [[ -n $container ]]; then docker rm -v "$container" > /dev/null; fi; }
trap cleanup EXIT
# Extract the pinned daemon; no Docker daemon or build worker runs in this container.
docker pull "$buildkit_image"
container=$(docker create "$buildkit_image")
docker cp "$container:/usr/bin/buildkitd" /usr/local/libexec/verity-buildkit/buildkitd.new
chmod 0755 /usr/local/libexec/verity-buildkit/buildkitd.new
/usr/local/libexec/verity-buildkit/buildkitd.new --version
mv /usr/local/libexec/verity-buildkit/buildkitd.new /usr/local/libexec/verity-buildkit/buildkitd
ln -sfn "/opt/verity/runsc/$RUNSC_RELEASE/runsc" /usr/local/libexec/verity-buildkit/runsc-real
install -m 0755 "$source_dir/runsc" "$source_dir/runsc-buildkit-args.sh" "$source_dir/runsc-netns.sh" "$source_dir/network.sh" /usr/local/libexec/verity-buildkit/
# CNI plugins for the per-step build network. The pinned archive is verified and
# extracted afresh every run, replacing any earlier or partial copy as a whole,
# so a hand-installed or interrupted directory is adopted rather than trusted.
cni_pin() { sed -n "s/^$1=//p" "$source_dir/cni.env" | head -n 1; }
cni_version=$(cni_pin CNI_VERSION)
case "$(uname -m)" in
    x86_64) cni_arch=amd64 cni_sha=$(cni_pin CNI_SHA256_AMD64) ;;
    aarch64) cni_arch=arm64 cni_sha=$(cni_pin CNI_SHA256_ARM64) ;;
    *) echo "Unsupported architecture for CNI plugins: $(uname -m)" >&2; exit 1 ;;
esac
[[ $cni_version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && $cni_sha =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid CNI pin' >&2; exit 1; }
cni_work=$(mktemp -d)
trap 'cleanup; rm -rf "$cni_work"' EXIT
curl -fsSL -o "$cni_work/cni.tgz" \
    "https://github.com/containernetworking/plugins/releases/download/$cni_version/cni-plugins-linux-$cni_arch-$cni_version.tgz"
printf '%s  %s\n' "$cni_sha" "$cni_work/cni.tgz" | sha256sum -c --quiet -
cni_dir=/usr/local/libexec/verity-buildkit/cni-$cni_version
install -d -m 0755 "$cni_work/plugins"
tar -xzf "$cni_work/cni.tgz" -C "$cni_work/plugins" ./bridge ./host-local ./loopback ./firewall
chmod 0755 "$cni_work"/plugins/*
rm -rf "$cni_dir.new"
cp -a "$cni_work/plugins" "$cni_dir.new"
rm -rf "$cni_dir"
mv "$cni_dir.new" "$cni_dir"
# A real directory at the link path would receive the link inside it instead.
if [[ -e /usr/local/libexec/verity-buildkit/cni && ! -L /usr/local/libexec/verity-buildkit/cni ]]; then
    rm -rf /usr/local/libexec/verity-buildkit/cni
fi
ln -sfn "cni-$cni_version" /usr/local/libexec/verity-buildkit/cni
install -d -m 0755 /var/lib/cni
sed "s/^  gid = 1102$/  gid = $builder_gid/" "$source_dir/buildkitd.toml" > /etc/verity-buildkit/buildkitd.toml
resources=$(bash "$source_dir/resources.sh")
cpu_quota=$(sed -n 's/^CPU_QUOTA=//p' <<<"$resources")
memory_max=$(sed -n 's/^MEMORY_MAX=//p' <<<"$resources")
sed -e "s/@CPU_QUOTA@/$cpu_quota/" -e "s/@MEMORY_MAX@/$memory_max/" "$source_dir/verity-buildkit.service" \
    > /etc/systemd/system/verity-buildkit.service.new
chmod 0644 /etc/systemd/system/verity-buildkit.service.new
mv /etc/systemd/system/verity-buildkit.service.new /etc/systemd/system/verity-buildkit.service
systemctl daemon-reload
systemctl enable verity-buildkit.service
systemctl restart verity-buildkit.service
# Once the worker runs on overlayfs, snapshots of the earlier native snapshotter
# are unreachable and only hold disk space; the daemon never reopens them. The
# unit is Type=notify, so the restart above returns once the worker has chosen.
if [[ -d /var/lib/verity-buildkit/runc-overlayfs ]]; then rm -rf /var/lib/verity-buildkit/runc-native; fi
printf 'Builder installed. Configure the Server socket mount and GID using deploy/docker-compose.buildkit.yml.\n'
