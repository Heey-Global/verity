# Ephemeral Docker daemon for the live Secret Job CI path. Keeping runsc inside this
# privileged test container avoids mutating the shared self-hosted runner.
# renovate: datasource=docker depName=docker
FROM docker:29.7.2-dind@sha256:6acc6aaf783ac1c1100822e542534c3dab3f1d38782760b0bdcb688280574d9e

COPY deploy/gvisor/versions.env /tmp/versions.env

RUN set -eu; \
    apk add --no-cache curl coreutils; \
    . /tmp/versions.env; \
    case "$(uname -m)" in \
      x86_64) arch=x86_64; checksum="$RUNSC_SHA512_X86_64" ;; \
      aarch64|arm64) arch=aarch64; checksum="$RUNSC_SHA512_AARCH64" ;; \
      *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    install_path="/opt/verity/runsc/$RUNSC_RELEASE/runsc"; \
    install -d -m 0755 "$(dirname "$install_path")"; \
    curl --fail --silent --show-error --location \
      "https://storage.googleapis.com/gvisor/releases/release/${RUNSC_RELEASE#release-}/$arch/runsc" \
      --output "$install_path"; \
    printf '%s  %s\n' "$checksum" "$install_path" | sha512sum --check --status; \
    chmod 0755 "$install_path"; \
    test "$("$install_path" --version | head -n 1)" = "runsc version $RUNSC_RELEASE"; \
    install -d -m 0755 /etc/docker; \
    printf '{"runtimes":{"runsc":{"path":"%s","runtimeArgs":["--platform=systrap","--network=none"]}}}\n' \
      "$install_path" >/etc/docker/daemon.json; \
    rm -f /tmp/versions.env
