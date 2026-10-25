#!/usr/bin/env bash
# Sourced by the CI harness. Synthetic credentials exist only for this run.
registry_start() {
    registry_address=registry.verity.test:5443
    registry_container="$name-registry"
    registry_cert_dir="/etc/docker/certs.d/$registry_address"
    [[ ! -e $registry_cert_dir ]] || { echo 'Registry trust directory already exists' >&2; return 1; }
    if getent hosts registry.verity.test > /dev/null; then echo 'Probe registry hostname already resolves' >&2; return 1; fi
    printf '127.0.0.1 registry.verity.test # %s\n' "$name" | sudo tee -a /etc/hosts > /dev/null
    registry_host_owned=true
    mkdir -p "$work/registry" "$work/publisher"
    registry_password=$(openssl rand -hex 32)
    printf '::add-mask::%s\n' "$registry_password"
    printf '%s\n' "$registry_password" | htpasswd -Bni probe > "$work/registry/htpasswd"
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=registry.verity.test \
        -addext subjectAltName=DNS:registry.verity.test,IP:127.0.0.1 \
        -keyout "$work/registry/key.pem" -out "$work/registry/cert.pem" 2>/dev/null
    sudo mkdir -p "$registry_cert_dir"
    registry_trust_owned=true
    sudo cp "$work/registry/cert.pem" "$registry_cert_dir/ca.crt"
    # renovate: datasource=docker depName=registry
    docker run -d --name "$registry_container" --memory 256m --cpus 0.5 --pids-limit 128 \
        -p 127.0.0.1:5443:5000 \
        --mount "type=bind,src=$work/registry,dst=/certs,readonly" \
        -e REGISTRY_AUTH=htpasswd -e REGISTRY_AUTH_HTPASSWD_REALM=probe \
        -e REGISTRY_AUTH_HTPASSWD_PATH=/certs/htpasswd \
        -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/cert.pem \
        -e REGISTRY_HTTP_TLS_KEY=/certs/key.pem \
        registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e > /dev/null
    registry_ready=false
    for attempt in $(seq 1 30); do
        if [[ $(curl --silent --cacert "$work/registry/cert.pem" -o /dev/null -w '%{http_code}' \
            "https://$registry_address/v2/" || true) == 401 ]]; then registry_ready=true; break; fi
        sleep 1
    done
    [[ $registry_ready == true ]] || return 1
    export NODE_EXTRA_CA_CERTS="$work/registry/cert.pem"
    registry_login
    cp -R "$probe_dir/.devcontainer/features" "$work/registry-features"
    DOCKER_CONFIG="$work/publisher" "$DEVCONTAINER_CLI" features publish \
        "$work/registry-features" --registry "$registry_address" --namespace probe \
        > "$work/publish.log" 2>&1
}

# dockerd can briefly retain its hosts-file cache after the fixture adds its name.
# Retry only that DNS miss; TLS and authentication failures stay immediate failures.
registry_login() {
    local attempt
    for attempt in $(seq 1 10); do
        if printf '%s\n' "$registry_password" | timeout 10 docker --config "$work/publisher" login \
            "$registry_address" --username probe --password-stdin > "$work/login.log" 2>&1; then return 0; fi
        if ! grep -F "lookup ${registry_address%:*}" "$work/login.log" > /dev/null || \
            ! grep -F 'no such host' "$work/login.log" > /dev/null; then return 1; fi
        sleep 1
    done
    return 1
}

registry_seed_base() {
    # Push a private alias of the repository-pinned public image. No fixture RUN uses runc.
    local public_base=$1
    docker pull "$public_base" > "$work/pull.log" 2>&1
    docker tag "$public_base" "$registry_address/probe/base:fixture"
    docker --config "$work/publisher" push "$registry_address/probe/base:fixture" > "$work/push.log" 2>&1
    docker image rm "$registry_address/probe/base:fixture" > /dev/null
}

registry_scrub_evidence() {
    [[ -n ${registry_password:-} ]] || return 0
    # Defend the artifact boundary even if a future CLI starts logging credentials.
    local scrub_status=0
    REGISTRY_PROBE_PASSWORD="$registry_password" node --input-type=module - "$PROBE_EVIDENCE" <<'NODE' || scrub_status=$?
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const password = process.env.REGISTRY_PROBE_PASSWORD;
const needles = [password, Buffer.from(`probe:${password}`).toString('base64')];
function scrub(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) scrub(path);
    else if (entry.isFile()) {
      let content = readFileSync(path, 'utf8');
      for (const needle of needles) content = content.replaceAll(needle, '[REDACTED]');
      writeFileSync(path, content);
    }
  }
}
scrub(process.argv[2]);
NODE
    unset registry_password
    return "$scrub_status"
}

registry_cleanup() {
    docker rm -fv "$registry_container"
    if [[ ${registry_trust_owned:-false} == true ]]; then
        sudo rm -f "$registry_cert_dir/ca.crt"
        sudo rmdir "$registry_cert_dir"
    fi
    if [[ ${registry_host_owned:-false} == true ]]; then
        sudo sed -i "/^127\.0\.0\.1 registry\.verity\.test # $name\$/d" /etc/hosts
    fi
    # Preserve diagnostics for redaction before upload; never retain config or keys.
    for diagnostic in login publish pull push; do
        if [[ -f $work/$diagnostic.log ]]; then cp "$work/$diagnostic.log" "$PROBE_EVIDENCE/registry-$diagnostic.log"; fi
    done
    # Never upload auth material, certificates or registry request logs.
    rm -rf "$work/publisher" "$work/registry"
}

# The pinned CLI handles a Basic challenge without printing the HTTP status when
# no credential exists. Require that specific denial, never just any nonzero exit.
expect_auth_failure() {
    local tag=$1 log=$2 status
    set +e
    build_probe "$tag" > "$log" 2>&1
    status=$?
    set -e
    [[ $status -ne 0 && $status -ne 124 && $status -ne 137 ]] || return 1
    if ! grep -Ei '401|unauthorized|authentication required' "$log" > /dev/null; then
        grep -F "No basic auth credentials to send for registry service '$registry_address'" "$log" > /dev/null || return 1
    fi
    if docker image inspect "$tag" > /dev/null 2>&1; then return 1; fi
    printf 'expected anonymous registry rejection: status=%s, no output image\n' "$status"
}
