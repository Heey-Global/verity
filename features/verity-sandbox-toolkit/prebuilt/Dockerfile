# One pinned amd64 compiler environment emits both static architectures, avoiding
# emulation and preventing host/target toolchain drift.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ARG ZIG_VERSION=0.13.0
ARG ZIG_SHA256=d45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea
ENV SOURCE_DATE_EPOCH=0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL --retry 5 --retry-all-errors -o /tmp/zig.tar.xz \
      "https://ziglang.org/download/${ZIG_VERSION}/zig-linux-x86_64-${ZIG_VERSION}.tar.xz" \
    && echo "${ZIG_SHA256}  /tmp/zig.tar.xz" | sha256sum --check --strict \
    && tar -xJf /tmp/zig.tar.xz -C /opt \
    && mv "/opt/zig-linux-x86_64-${ZIG_VERSION}" /opt/zig \
    && rm /tmp/zig.tar.xz
COPY bin/verity-script-sandbox.c /src/verity-script-sandbox.c
RUN for target in x86_64:amd64 aarch64:arm64; do \
      zig_target="${target%%:*}-linux-musl"; arch="${target##*:}"; \
      mkdir -p "/out/linux-${arch}"; \
      /opt/zig/zig cc -target "$zig_target" -O2 -static -s -Wl,--build-id=none \
        /src/verity-script-sandbox.c -o "/out/linux-${arch}/verity-script-sandbox"; \
    done

FROM scratch
COPY --from=0 /out/ /
