FROM rust:1.99.0-slim-bookworm@sha256:452176c0cefca88c0b3184ce85a4eb03e3d4fa05d2afb5366abcba853221019e AS builder

RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake pkg-config libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Dependencies compile in a layer keyed only by the manifest and lockfile, so a
# connector source change rebuilds one crate instead of all of matrix-sdk (a cold
# build ran 21 minutes on ARM64). The placeholder crate's own artifacts are
# removed so the real build below cannot mistake them for up to date.
# `-j 3` matches the three CPUs the CI and release builders are capped at.
COPY connectors/matrix/Cargo.toml connectors/matrix/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo build --locked --release -j 3 \
    && rm -rf src target/release/verity-matrix-connector* \
        target/release/deps/verity_matrix_connector-* \
        target/release/.fingerprint/verity-matrix-connector-*
COPY connectors/matrix/src ./src
RUN cargo build --locked --release -j 3

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data verity \
    && mkdir /data && chown 10001:10001 /data
COPY --from=builder /build/target/release/verity-matrix-connector /usr/local/bin/verity-matrix-connector
USER 10001:10001
VOLUME ["/data"]
ENV MATRIX_DATA_DIR=/data
ENTRYPOINT ["/usr/local/bin/verity-matrix-connector"]
