# Add host installer prerequisites to the existing pinned runsc daemon fixture.
# Build deploy/gvisor-ci.Dockerfile first and pass its local image tag here.
ARG VERITY_GVISOR_CI_IMAGE
FROM ${VERITY_GVISOR_CI_IMAGE}
# The managed egress preparation runs on the host even when native activation is
# unsupported. Alpine needs shadow for the fixed /usr/sbin/groupadd entrypoint.
RUN apk add --no-cache bash jq openssl util-linux python3 shadow \
    && python3 -c 'import fcntl, grp, pwd' \
    && test -x /usr/sbin/groupadd
