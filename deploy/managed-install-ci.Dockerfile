# Add host installer prerequisites to the existing pinned runsc daemon fixture.
# Build deploy/gvisor-ci.Dockerfile first and pass its local image tag here.
ARG VERITY_GVISOR_CI_IMAGE
FROM ${VERITY_GVISOR_CI_IMAGE}
RUN apk add --no-cache bash jq openssl util-linux
