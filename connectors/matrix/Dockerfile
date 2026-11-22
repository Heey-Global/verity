FROM rust:1.100.0-slim-bookworm@sha256:7c7d4eb4d05b7781187a327809466cfddf29753f6defdc3d19a0e291951b7a37 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake pkg-config libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Dependencies compile in a layer keyed only by the manifest and lockfile, so a
# connector source change rebuilds one crate instead of all of matrix-sdk (a cold
# build ran 21 minutes on ARM64). `-j 3` matches the three CPUs the CI and
# release builders are capped at.
#
# The placeholder crate must never reach the image: it starts, prints nothing
# and exits 0, so a restart policy loops on it silently. `cargo clean -p` lets
# Cargo remove the placeholder's artifacts wherever its target layout keeps them
# (hand-written globs into `target/` go stale when that layout changes), the
# `touch` makes the real sources newer than any fingerprint that survives, and
# the final `--version` check fails the build if the placeholder ships anyway.
COPY connectors/matrix/Cargo.toml connectors/matrix/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo build --locked --release -j 3 \
    && cargo clean --release -p verity-matrix-connector \
    && rm -rf src
COPY connectors/matrix/src ./src
RUN touch src/*.rs \
    && cargo build --locked --release -j 3 \
    && version="$(target/release/verity-matrix-connector --version)" \
    && echo "$version" \
    && echo "$version" | grep -qx 'verity-matrix-connector [0-9][0-9A-Za-z.+-]*'

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data verity \
    && mkdir /data && chown 10001:10001 /data
COPY --from=builder /build/target/release/verity-matrix-connector /usr/local/bin/verity-matrix-connector
USER 10001:10001
VOLUME ["/data"]
ENV MATRIX_DATA_DIR=/data
ENTRYPOINT ["/usr/local/bin/verity-matrix-connector"]
