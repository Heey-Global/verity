#!/usr/bin/env python3
"""Bounded metadata-only TCP sampling on an explicitly authorized Docker host."""
import argparse
import datetime
import json
import os
import re
import resource
import shutil
import subprocess
import time

MAX_OUTPUT = 256 * 1024


def run(argv):
    # A file avoids retaining unbounded child stdout in memory.
    import tempfile
    with tempfile.TemporaryFile() as output:
        try:
            result = subprocess.run(
                argv, stdout=output, stderr=subprocess.DEVNULL, timeout=2,
                check=False, preexec_fn=lambda: resource.setrlimit(
                    resource.RLIMIT_FSIZE, (MAX_OUTPUT + 1, MAX_OUTPUT + 1)))
        except subprocess.TimeoutExpired:
            raise RuntimeError("subcommand_timeout") from None
        if result.returncode:
            raise RuntimeError("command_failed_or_permission_denied")
        if output.tell() > MAX_OUTPUT:
            raise RuntimeError("subcommand_output_limit")
        output.seek(0)
        return output.read(MAX_OUTPUT).decode("utf-8", errors="replace")


def identity(container):
    raw = run(["docker", "inspect", "--format",
               "{{.Id}} {{.State.Pid}} {{.State.Running}} {{.State.StartedAt}}", container]).strip()
    fields = raw.split()
    if len(fields) != 4 or not re.fullmatch(r"[a-f0-9]{64}", fields[0]) or fields[2] != "true":
        raise RuntimeError("container_not_running")
    pid = int(fields[1])
    if pid <= 1:
        raise RuntimeError("invalid_container_pid")
    # PID start time protects against a reused PID within the same collection.
    with open(f"/proc/{pid}/stat", encoding="utf-8") as source:
        start = source.read().rsplit(")", 1)[1].split()[19]
    return fields[0], pid, fields[3], start


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True)
    parser.add_argument("--output", required=True, help="new JSONL output file (mode 0600)")
    parser.add_argument("--seconds", type=int, default=120, choices=range(1, 121), metavar="1..120")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", args.container):
        parser.error("invalid container name or ID")
    for tool in ("docker", "nsenter", "ss"):
        if not shutil.which(tool):
            parser.error(f"missing prerequisite: {tool}")
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as sink:
        def emit(record):
            record["at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            sink.write(json.dumps(record) + "\n")
            sink.flush()
        try:
            initial = identity(args.container)
            emit({"event": "start", "containerId": initial[0], "seconds": args.seconds,
                  "scope": "established destination TCP port 443; all matching sockets"})
            deadline = time.monotonic() + args.seconds
            count = 0
            while time.monotonic() < deadline:
                tick = time.monotonic()
                if identity(args.container) != initial:
                    raise RuntimeError("container_or_pid_changed")
                raw = run(["nsenter", "--target", str(initial[1]), "--net", "--",
                           "ss", "-tinH", "state", "established", "dst", ":443"])
                if identity(args.container) != initial:
                    raise RuntimeError("container_or_pid_changed")
                emit({"event": "sample", "index": count, "tcp": raw})
                count += 1
                time.sleep(max(0, min(deadline - time.monotonic(), tick + 1 - time.monotonic())))
            emit({"event": "end", "samples": count})
        except (RuntimeError, OSError, ValueError) as error:
            # Never print Docker output, arbitrary OS errors, or host paths.
            reason = str(error) if isinstance(error, RuntimeError) else "host_inspection_failed"
            emit({"event": "failed", "reason": reason})
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
