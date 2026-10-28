ARG PROBE_BASE_IMAGE
FROM ${PROBE_BASE_IMAGE}

# Run without cache and correlate this output with host-side runsc evidence.
RUN printf 'verity-probe: dockerfile-run\n' && cat /proc/version \
    && (dmesg || true) && printf 'dockerfile-run\n' > /verity-dockerfile-probe
