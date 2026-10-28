FROM rust:1.99.1-slim-bookworm@sha256:86234e857a413004348b471d11a4ebe1aa92d2eae2b6b143cac68fd1ac3c48be AS builder

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

FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data verity \
    && mkdir /data && chown 10001:10001 /data
COPY --from=builder /build/target/release/verity-matrix-connector /usr/local/bin/verity-matrix-connector
USER 10001:10001
VOLUME ["/data"]
ENV MATRIX_DATA_DIR=/data
ENTRYPOINT ["/usr/local/bin/verity-matrix-connector"]
