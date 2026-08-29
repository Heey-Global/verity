# The Verity repo's own sandbox layer: the shared fleet image plus the one thing
# only THIS repository needs — a PostgreSQL server for the test suite.
#
# Why here and not in `features/verity-sandbox-toolkit`: the toolkit is installed
# into every Verity sandbox, so a package added there is carried by every project
# container whether or not that project has ever seen a database. The test suite
# that wants a server is this repo's, so the layer that installs one is this
# repo's too. Nothing else in the fleet changes.
#
# What the server is FOR: `scripts/test-postgres.ts` starts one cluster per
# container, over a Unix socket, and `packages/store/src/testing.ts` hands each
# worker its own database inside it — instead of every test file booting a
# private pglite (a WASM PostgreSQL) and replaying all migrations into it. With
# no server installed that fallback still works unchanged, which is what keeps a
# plain checkout on a laptop running with nothing to set up.

# The same mutable channel tag `DEFAULT_SANDBOX_IMAGE_TAG` resolves to in
# packages/server/src/main.ts, so this project keeps tracking the fleet image
# rather than pinning itself to one build of it. Deliberately not digest-pinned:
# a pin here would mean this repo's sandbox silently stops following the image
# every other project gets. What triggers a rebuild is Verity's own resolved base
# ref changing — `devcontainerContentHash` mixes that in, not this line — so a
# fleet rollout invalidates the cached layer and the FROM below then resolves to
# the image that rollout published.
#
# The ARG exists so `verity-sandbox.yml` can point this layer at the image it
# just built, instead of at the published one — that job is the only place the
# base and this layer are proved to work together before either is published.
ARG VERITY_SANDBOX_IMAGE=ghcr.io/heey-global/verity/verity-sandbox:latest
FROM ${VERITY_SANDBOX_IMAGE}

# The base image ends on `USER dev`; apt needs root, and the container has to go
# back to `dev` before it is handed to an agent.
USER root

# Pinned to the major, not left to `postgresql`'s meta-package, so a base-image
# rebuild cannot move the server version underneath a suite that is already
# running against an initialised cluster: PostgreSQL data directories are not
# forward-compatible across majors, and the failure would surface as a cluster
# that suddenly refuses to start rather than as an upgrade.
# renovate: datasource=repology depName=debian_12/postgresql-15 versioning=loose
ARG POSTGRES_MAJOR=15

RUN set -eux; \
    # postgresql-common's postinst creates a system `main` cluster on install and
    # leaves a postmaster configured to start with the container. Nothing wants
    # it: the harness initialises its own cluster under a directory the agent
    # user owns, and a second server is wasted memory in a sandbox whose cgroup
    # limit is the reason this work exists. The drop-in is written BEFORE the
    # install so the postinst reads it; the explicit drop afterwards covers the
    # case where it did not.
    mkdir -p /etc/postgresql-common/createcluster.d; \
    printf 'create_main_cluster = false\n' \
      > /etc/postgresql-common/createcluster.d/verity-no-main-cluster.conf; \
    export DEBIAN_FRONTEND=noninteractive; \
    # Deliberately NOT fatal. This build is on the session provisioning path:
    # every first provision after a fleet rollout runs it, and a hard failure
    # here means no sandbox at all for this repo — over a Debian mirror being
    # unreachable, or a base image that moved to a release where this major is
    # not packaged. Everything downstream already degrades to pglite when no
    # server is installed, so that is what an install failure buys too: a slow
    # suite instead of no container. The loud signal belongs where it can be
    # acted on, and it is there — verity-sandbox.yml builds this file on every
    # PR that touches it or the base, and asserts the binaries afterwards.
    if apt-get update && \
       apt-get install -y --no-install-recommends "postgresql-${POSTGRES_MAJOR}"; then \
      "/usr/lib/postgresql/${POSTGRES_MAJOR}/bin/initdb" --version; \
    else \
      echo "WARNING: postgresql-${POSTGRES_MAJOR} did not install; the test suite will use pglite" >&2; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    # `|| true` for the same reason the install above is not fatal: this drops a
    # cluster nothing wants, and `pg_dropcluster` errors when the config dir and
    # the data dir disagree — which is precisely the "postinst ignored the
    # drop-in" world this line exists for. A leftover system cluster costs idle
    # memory; a failure here costs the sandbox.
    if [ -d "/var/lib/postgresql/${POSTGRES_MAJOR}/main" ]; then \
      pg_dropcluster --stop "${POSTGRES_MAJOR}" main || true; \
    fi; \
    # CLUSTER_ROOT in scripts/test-postgres.ts. Owned by the agent user because
    # the harness runs as that user and has no sudo; 0700 because the cluster
    # authenticates with `trust`, so the socket directory's permissions ARE the
    # access boundary.
    #
    # Created even when the install above failed: the harness looks for the
    # binaries too, so an empty root costs one `existsSync` and nothing else,
    # and creating it unconditionally keeps this layer's outcome the same shape
    # either way.
    install -d -o dev -g dev -m 0700 /var/lib/verity-test-postgres

USER dev
