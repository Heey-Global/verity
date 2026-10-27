# The workflow supplies its digest-pinned Node base; test containers stay offline.
ARG VERITY_INSTALLER_BASE_IMAGE
FROM ${VERITY_INSTALLER_BASE_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends jq \
    && rm -rf /var/lib/apt/lists/*
