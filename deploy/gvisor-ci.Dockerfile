# Ephemeral Docker daemon for the live Secret Job CI path. Keeping runsc inside this
# privileged test container avoids mutating the shared self-hosted runner. A release pinned
# as an archive brings the sidecars in gvisor-bin/ next to runsc, which it cannot run without.
# renovate: datasource=docker depName=docker
FROM docker:29.9.2-dind@sha256:9e79b879b177fbd72c34376a3dd3d91747da5db49e1f560f76aea59561471977

COPY deploy/gvisor/versions.env /tmp/versions.env

RUN set -eu; \
    apk add --no-cache curl coreutils tar bzip2; \
    . /tmp/versions.env; \
    case "$(uname -m)" in \
      x86_64) arch=x86_64; checksum="$RUNSC_SHA512_X86_64"; archive_checksum="${RUNSC_ARCHIVE_SHA512_X86_64:-}" ;; \
      aarch64|arm64) arch=aarch64; checksum="$RUNSC_SHA512_AARCH64"; archive_checksum="${RUNSC_ARCHIVE_SHA512_AARCH64:-}" ;; \
      *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    install_path="/opt/verity/runsc/$RUNSC_RELEASE/runsc"; \
    install -d -m 0755 "$(dirname "$install_path")"; \
    if [ -z "$archive_checksum" ]; then \
      curl --fail --silent --show-error --location \
        --retry 3 --retry-all-errors --connect-timeout 20 --max-time 120 --retry-max-time 300 \
        "https://storage.googleapis.com/gvisor/releases/release/${RUNSC_RELEASE#release-}/$arch/runsc" --output "$install_path"; \
    else \
      curl --fail --silent --show-error --location \
        --retry 3 --retry-all-errors --connect-timeout 20 --max-time 300 --retry-max-time 600 \
        "https://storage.googleapis.com/gvisor/releases/release/${RUNSC_RELEASE#release-}/$arch/gvisor.tar.bz2" --output /tmp/gvisor.tar.bz2; \
      printf '%s  %s\n' "$archive_checksum" /tmp/gvisor.tar.bz2 | sha512sum --check --status; \
      tar -xjf /tmp/gvisor.tar.bz2 -C "$(dirname "$install_path")" --no-same-owner runsc gvisor-bin; \
      rm -f /tmp/gvisor.tar.bz2; \
      test -f "$(dirname "$install_path")/gvisor-bin/gvisor_sentry"; \
    fi; \
    printf '%s  %s\n' "$checksum" "$install_path" | sha512sum --check --status; \
    chmod 0755 "$install_path"; \
    test "$("$install_path" --version | head -n 1)" = "runsc version $RUNSC_RELEASE"; \
    install -d -m 0755 /etc/docker; \
    printf '{"runtimes":{"runsc":{"path":"%s","runtimeArgs":["--platform=systrap","--network=none"]},"runsc-project":{"path":"%s","runtimeArgs":["--platform=systrap","--network=sandbox","--host-uds=create"]}}}\n' \
      "$install_path" "$install_path" >/etc/docker/daemon.json; \
    rm -f /tmp/versions.env
