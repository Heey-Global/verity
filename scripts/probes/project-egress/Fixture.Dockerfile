# Record the resolved digest in evidence; this image contains no real credentials.
FROM python:3.15-slim-bookworm@sha256:96599df822d0e1c6bb700014a05c7f3c8cabc6e0f7ff3c4f9f69cee033b4b5d9
RUN pip install --no-cache-dir aioquic==1.3.0
COPY scripts/probes/project-egress/agent.py scripts/probes/project-egress/install.sh /probe/
RUN mkdir /work && chown 65532:65532 /work
USER 65532:65532
ENTRYPOINT ["python3", "/probe/agent.py"]
