# Record the resolved digest in evidence; this image contains no real credentials.
FROM python:3.13-slim-bookworm
RUN pip install --no-cache-dir aioquic==1.3.0
COPY scripts/probes/project-egress/agent.py scripts/probes/project-egress/install.sh /probe/
RUN mkdir /work && chown 65532:65532 /work
USER 65532:65532
ENTRYPOINT ["python3", "/probe/agent.py"]
