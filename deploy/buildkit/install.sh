#!/usr/bin/env bash
# Explicit host administration; never invoked automatically by the Server.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run as root on the Docker host.' >&2; exit 1; }
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# renovate: datasource=docker depName=moby/buildkit
buildkit_image=moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c
builder_gid=${VERITY_BUILDKIT_GID:-1102}
[[ $builder_gid =~ ^[0-9]+$ && $builder_gid -gt 0 && $builder_gid -lt 65535 ]] || { echo 'Invalid VERITY_BUILDKIT_GID' >&2; exit 1; }
# Serialize release installation with the separately scheduled snapshotter transaction.
install -d -m 0700 /var/lib/verity/buildkit-snapshotter
if [[ ${VERITY_BUILDKIT_RELEASE_LOCK_HELD:-} == 1 ]]; then
    # FD 6 is held by the root bridge and inherited with its admission fence.
    flock -n 6 || { echo 'Missing inherited release lock' >&2; exit 1; }
    exec 7>&6
else
    exec 7>/var/lib/verity/buildkit-snapshotter/lock
fi
flock -w 60 7 || { echo 'Snapshotter maintenance is still running; retry the update.' >&2; exit 1; }
# Recover an interrupted configuration transaction before replacing its backup.
if [[ -x /usr/local/libexec/verity-buildkit/snapshotter-migrate.sh ]]; then
    /usr/local/libexec/verity-buildkit/snapshotter-migrate.sh recover
    if [[ -e /var/lib/verity/buildkit-snapshotter/pending.json ]]; then
        systemctl restart verity-buildkit.service
        /usr/local/libexec/verity-buildkit/snapshotter-migrate.sh recover-verify
    fi
fi
# Validate storage policy before changing binaries, service files or runtimes.
rendered_config=$(bash "$source_dir/storage-policy.sh" "$source_dir/buildkitd.toml" \
    /etc/verity-buildkit/buildkitd.toml /etc/verity-buildkit/storage-policy.conf "$builder_gid")
diagnostic_dir=${VERITY_HOST_DIAGNOSTIC_DIR:-}
if [[ -z $diagnostic_dir && -f /etc/verity-buildkit/diagnostic-path ]]; then
    diagnostic_dir=$(cat /etc/verity-buildkit/diagnostic-path)
fi
diagnostic_dir=${diagnostic_dir:-/var/lib/verity/host-diagnostics}
[[ ! -L $diagnostic_dir ]] || { echo 'Build diagnostic directory must not be a symlink' >&2; exit 1; }
storage_unit=$(bash "$source_dir/storage-service.sh" "$source_dir/verity-build-storage.service" "$diagnostic_dir")
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
docker cp "$container:/usr/bin/buildctl" /usr/local/libexec/verity-buildkit/buildctl.new
chmod 0755 /usr/local/libexec/verity-buildkit/buildctl.new
/usr/local/libexec/verity-buildkit/buildctl.new --version
mv /usr/local/libexec/verity-buildkit/buildctl.new /usr/local/libexec/verity-buildkit/buildctl
docker cp "$container:/usr/bin/buildkitd" /usr/local/libexec/verity-buildkit/buildkitd.new
chmod 0755 /usr/local/libexec/verity-buildkit/buildkitd.new
/usr/local/libexec/verity-buildkit/buildkitd.new --version
mv /usr/local/libexec/verity-buildkit/buildkitd.new /usr/local/libexec/verity-buildkit/buildkitd
ln -sfn "/opt/verity/runsc/$RUNSC_RELEASE/runsc" /usr/local/libexec/verity-buildkit/runsc-real
install -m 0755 "$source_dir/runsc" "$source_dir/runsc-buildkit-args.sh" "$source_dir/runsc-netns.sh" "$source_dir/network.sh" "$source_dir/storage-report.sh" "$source_dir/publish-storage-report.sh" "$source_dir/snapshotter-migrate.sh" /usr/local/libexec/verity-buildkit/
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
printf '%s\n' "$rendered_config" > /etc/verity-buildkit/buildkitd.toml.new
chmod 0644 /etc/verity-buildkit/buildkitd.toml.new
mv /etc/verity-buildkit/buildkitd.toml.new /etc/verity-buildkit/buildkitd.toml
resources=$(bash "$source_dir/resources.sh")
cpu_quota=$(sed -n 's/^CPU_QUOTA=//p' <<<"$resources")
memory_max=$(sed -n 's/^MEMORY_MAX=//p' <<<"$resources")
sed -e "s/@CPU_QUOTA@/$cpu_quota/" -e "s/@MEMORY_MAX@/$memory_max/" "$source_dir/verity-buildkit.service" \
    > /etc/systemd/system/verity-buildkit.service.new
chmod 0644 /etc/systemd/system/verity-buildkit.service.new
mv /etc/systemd/system/verity-buildkit.service.new /etc/systemd/system/verity-buildkit.service
install -d -m 0755 "$diagnostic_dir"
printf '%s\n' "$diagnostic_dir" > /etc/verity-buildkit/diagnostic-path
printf '%s\n' "$storage_unit" > /etc/systemd/system/verity-build-storage.service.new
chmod 0644 /etc/systemd/system/verity-build-storage.service.new
mv /etc/systemd/system/verity-build-storage.service.new /etc/systemd/system/verity-build-storage.service
install -m 0644 "$source_dir/verity-build-storage.timer" /etc/systemd/system/
install -m 0644 "$source_dir/snapshotter-policy.conf" /etc/verity-buildkit/
install -m 0644 "$source_dir/verity-buildkit-snapshotter.service" "$source_dir/verity-buildkit-snapshotter.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable verity-buildkit.service
systemctl restart verity-buildkit.service
/usr/local/libexec/verity-buildkit/snapshotter-migrate.sh init
systemctl enable --now verity-buildkit-snapshotter.timer
systemctl enable --now verity-build-storage.timer
systemctl start verity-build-storage.service
# Snapshotter state is not an installer artifact. Old workers can hold references
# needed for rollback; removing their directories requires separate maintenance.
printf 'Builder installed. Configure the Server socket mount and GID using deploy/docker-compose.buildkit.yml.\n'
