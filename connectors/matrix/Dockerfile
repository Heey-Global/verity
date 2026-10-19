FROM rust:1.99.1-slim-bookworm@sha256:a24e292b4af7bdee351a31d3a6379972a5652f0ea22a1b6d6883324ac4f5097c AS builder

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

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data verity \
    && mkdir /data && chown 10001:10001 /data
COPY --from=builder /build/target/release/verity-matrix-connector /usr/local/bin/verity-matrix-connector
USER 10001:10001
VOLUME ["/data"]
ENV MATRIX_DATA_DIR=/data
ENTRYPOINT ["/usr/local/bin/verity-matrix-connector"]
