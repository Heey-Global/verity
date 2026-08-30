# verity-sandbox — the shared Verity agent-container base image.
#
# Bakes the `verity-sandbox-toolkit` devcontainer Feature (features/verity-sandbox-toolkit) at
# build time: the SAME install.sh that a user devcontainer runs via
# --additional-features. Single source of truth, no drift between the baked base
# and per-user builds (ADR migration #299, PR-A).
#
# Layout mirrors the legacy dev-server dev-base: node:24-bookworm runtime with
# Python 3.14 multi-stage-copied from python:3.14-bookworm (both debian-bookworm,
# so OS-level shared libs match and Python's C extensions link without rebuild).
#
# Built for linux/amd64 (the pinned gh/doppler tarballs are amd64-only).

# Digest-pinned (audit M12) so the Python runtime copied wholesale into every
# sandbox is reproducible, not whatever `python:3.14-bookworm` currently resolves
# to. Renovate (docker:pinDigests) bumps tag+digest together.
# renovate: datasource=docker depName=python
ARG PYTHON_VERSION=3.14-bookworm@sha256:ecac9e212daacda8a702eae372fceebc0ee36f5805abe087880367e8d061fa5b
FROM python:${PYTHON_VERSION} AS python-source

# Digest-pinned alongside the tag so the runtime base is reproducible and
# Renovate's stock docker manager (parses FROM natively) bumps tag+digest
# together. Digest reused from the legacy dev-base pin.
# renovate: datasource=docker depName=node
FROM node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b

# Build-time RUN shell with pipefail so `cmd1 | cmd2` failures aren't masked by
# a successful cmd2 exit code. (Hadolint DL4006.)
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG TZ=Europe/Berlin
ENV TZ=${TZ}

# Copying /usr/local from the official Python image does not copy the Debian
# shared libraries its standard-library extension modules link against. Keep
# the runtime set explicit so imports such as ssl, sqlite3, bz2, lzma, ctypes,
# readline, tkinter and uuid cannot fail only after a Sandbox has started.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates libbluetooth3 libbz2-1.0 libdb5.3 libexpat1 libffi8 \
      libgdbm6 liblzma5 libncursesw6 libreadline8 libsqlite3-0 libssl3 \
      tk libuuid1 zlib1g \
 && rm -rf /var/lib/apt/lists/*

# Python 3.14 — copied wholesale from python:3.14-bookworm. Placed under
# /usr/local/ to match python:3.14-bookworm's own layout so sys.prefix and
# shared-lib search paths resolve without env-var hacks. Symlink python3/pip3.
COPY --from=python-source /usr/local/bin/python3.14   /usr/local/bin/python3.14
COPY --from=python-source /usr/local/bin/pip3.14      /usr/local/bin/pip3.14
COPY --from=python-source /usr/local/lib/python3.14   /usr/local/lib/python3.14
COPY --from=python-source /usr/local/lib/libpython3.14.so.1.0 /usr/local/lib/libpython3.14.so.1.0
COPY --from=python-source /usr/local/include/python3.14 /usr/local/include/python3.14
RUN ldconfig \
 && ln -sf /usr/local/bin/python3.14 /usr/local/bin/python3 \
 && ln -sf /usr/local/bin/python3.14 /usr/local/bin/python \
 && ln -sf /usr/local/bin/pip3.14    /usr/local/bin/pip3 \
 && ln -sf /usr/local/bin/pip3.14    /usr/local/bin/pip \
 && python3 --version && pip3 --version \
 && python3 -c 'import bz2, ctypes, lzma, readline, sqlite3, ssl, tkinter, uuid'

# Unify the unprivileged user to 'dev' (uid 1000). The node base ships uid 1000
# named 'node'; renaming preserves the uid so existing project volumes
# (chown 1000:1000) stay mountable. The rename lives HERE, pre-Feature, so the
# Feature's install.sh writes config into an already-correct /home/dev.
RUN usermod -l dev -m -d /home/dev node \
 && groupmod -n dev node \
 && mkdir -p /home/dev/.claude /home/dev/.ssh \
 && chown -R dev:dev /home/dev/.claude /home/dev/.ssh \
 && chmod 0700 /home/dev/.ssh

# Bake the verity-sandbox-toolkit Feature: the same install.sh a user devcontainer runs.
# _REMOTE_USER / _REMOTE_USER_HOME emulate the devcontainer-injected env; the
# fixed-neutral-path options resolve to their /run/verity/... defaults (the
# provisioner binds real files there at runtime, PR-B).
COPY features/verity-sandbox-toolkit /tmp/verity-sandbox-toolkit
RUN _REMOTE_USER=dev _REMOTE_USER_HOME=/home/dev TZ=Europe/Berlin INSTALLRUNNERSUPERVISOR=true \
      /tmp/verity-sandbox-toolkit/install.sh \
 && rm -rf /tmp/verity-sandbox-toolkit

USER dev
WORKDIR /work

# Hard ENTRYPOINT (D2): the devcontainer path calls the same script from
# post-start.sh (in the background) instead.
ENTRYPOINT ["/usr/local/bin/verity-agent-run"]
