ARG RUNNER_IMAGE
FROM ${RUNNER_IMAGE}
USER root
COPY scripts/probes/project-egress/boot-client.py /opt/verity-boot/boot-client.py
COPY scripts/probes/project-egress/startup-emitter.py /opt/verity-boot/startup-emitter.py
COPY scripts/probes/project-egress/boot-runner-entrypoint.sh /opt/verity-boot/entrypoint.sh
ENTRYPOINT ["/bin/bash", "/opt/verity-boot/entrypoint.sh"]
