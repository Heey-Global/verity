ARG PROBE_BASE_IMAGE
FROM ${PROBE_BASE_IMAGE}

# Every repository devcontainer that installs packages needs name resolution
# and outbound HTTP(S) from a RUN step. A builder that isolates the step but
# cannot resolve a name fails every real Dockerfile and Feature, so each check
# below is fatal: no retries, no `|| true`, no fallback mirror.
RUN set -eux; \
    cat /etc/resolv.conf; \
    getent hosts deb.debian.org; \
    apt-get -o Acquire::Retries=0 update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    curl --fail --silent --show-error --max-time 30 --output /dev/null https://deb.debian.org/debian/; \
    printf 'network-egress\n' > /verity-network-probe
