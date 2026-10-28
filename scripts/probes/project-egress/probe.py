"""Run only inside the dedicated privileged CI fixture, never on a production daemon."""

import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

from policy import ADDRESSES, BRIDGES, LEASE_MS, base_rules, refresh_rules, nft
from verify import KINDS, verify

ROOT = Path(__file__).parent
OUT = Path("/evidence")
IMAGE = "project-egress-fixture:local"
REPORT = {"complete": False, "cases": [], "closure_seconds": {}, "profiles": {}}
CONTROLLER = None


def run(*args, timeout=20, check=True, **kwargs):
    return subprocess.run(
        args, text=True, capture_output=True, timeout=timeout, check=check, **kwargs
    )


def docker(*args, **kwargs):
    return run("docker", *args, **kwargs).stdout.strip()


def save():
    OUT.mkdir(exist_ok=True)
    (OUT / "result.json").write_text(json.dumps(REPORT, indent=2) + "\n")


def wait_until(check, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.1)
    raise RuntimeError("fixture readiness timed out")


def stop_controller():
    global CONTROLLER
    if CONTROLLER is not None:
        if CONTROLLER.poll() is None:
            CONTROLLER.kill()
        CONTROLLER.wait(timeout=5)
        CONTROLLER = None


def grant(grants, duration=120):
    global CONTROLLER
    revoke()
    ready = OUT / "controller-ready"
    ready.unlink(missing_ok=True)
    Path(str(ready) + ".expiry").unlink(missing_ok=True)
    with (OUT / "controller.log").open("a") as log:
        CONTROLLER = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "policy.py"),
                json.dumps(grants),
                str(duration),
                str(ready),
            ],
            stdout=log,
            stderr=log,
        )
    wait_until(lambda: ready.exists() or CONTROLLER.poll() is not None, 5)
    if not ready.exists() or CONTROLLER.poll() is not None:
        raise RuntimeError("policy controller failed")


def revoke():
    stop_controller()
    nft(refresh_rules([]))
    # Deleting tracked TCP sessions plus tcp_loose=0 prevents old buffered data
    # from reviving after a later grant. UDP has no transport retransmission.
    for project in ("a", "b"):
        for address in ADDRESSES[project]:
            result = run(
                "conntrack",
                "-D",
                "-f",
                "ipv6" if ":" in address else "ipv4",
                "-s",
                address,
                check=False,
            )
            if result.returncode not in (0, 1):
                raise RuntimeError("failed to invalidate project conntrack")


def command(project, request, child=False):
    text = json.dumps(request)
    if child:
        # The same executable is launched through a shell/lifecycle child, not the PID 1 control channel.
        script = (
            'exec python3 /probe/agent.py send "$1"'
            if child != "install"
            else 'exec /bin/sh /probe/install.sh "$1"'
        )
        return json.loads(
            docker(
                "exec",
                "pe-" + project,
                "/bin/sh",
                "-c",
                script,
                "synthetic-child",
                text,
            )
        )
    return json.loads(
        docker("exec", "pe-" + project, "python3", "/probe/agent.py", "command", text)
    )


def observations(target):
    logs = docker("logs", "pe-" + target)
    events = []
    for line in logs.splitlines():
        try:
            record = json.loads(line)
            if "marker" in record:
                events.append(record)
        except json.JSONDecodeError:
            pass
    return events


def network(
    case_id,
    project,
    target,
    kind,
    family,
    expected,
    control=None,
    *,
    request=None,
    observer=None,
    child=False,
    transport=None,
):
    marker = uuid.uuid4().hex
    address = ADDRESSES[target][family == 6]
    payload = {"host": address, "kind": kind, "marker": marker, "ipv6": family == 6}
    payload.update(request or {})
    result = command(project, payload, child)
    # Absence is judged after the bounded client attempt, never from its error code.
    time.sleep(0.15)
    observer = observer or target
    records = observations(observer)
    observed = any(
        row["marker"] == marker and (transport is None or row["transport"] == transport)
        for row in records
    )
    case = {
        "id": case_id,
        "type": "network",
        "marker": marker,
        "expected": expected,
        "observed": observed,
        "control": control,
        "result": result,
        "observer": observer,
        "transport": transport,
        "status": "pass" if observed == expected else "fail",
    }
    REPORT["cases"].append(case)
    save()
    print(json.dumps(case), flush=True)


def forwarding():
    # Docker's cross-bridge isolation must not masquerade as the tested policy.
    # nft priority -200 drops first; these later accepts provide the positive path.
    for tool in ("iptables", "ip6tables"):
        for bridge in BRIDGES.values():
            for incoming, outgoing in ((bridge, "pe-r"), ("pe-r", bridge)):
                args = ("FORWARD", "-i", incoming, "-o", outgoing, "-j", "ACCEPT")
                if run(tool, "-C", *args, check=False).returncode:
                    run(tool, "-I", *args)


def wait_project(project):
    def ready():
        # A stale socket inode survives on the volume until the new agent starts.
        try:
            result = run(
                "docker",
                "exec",
                "pe-" + project,
                "python3",
                "/probe/agent.py",
                "command",
                json.dumps({"action": "ping"}),
                timeout=1,
                check=False,
            )
            return result.returncode == 0 and json.loads(result.stdout) == {
                "ready": True
            }
        except (subprocess.TimeoutExpired, json.JSONDecodeError):
            return False

    wait_until(ready)


def profiles():
    for project in ("a", "b"):
        inspected = json.loads(docker("inspect", "pe-" + project))[0]
        config = inspected["HostConfig"]
        REPORT["profiles"][project] = {
            "id": inspected["Id"],
            "runtime": config["Runtime"],
            "user": inspected["Config"]["User"],
            "cap_drop": config["CapDrop"],
            "cap_add": config["CapAdd"],
            "security": config["SecurityOpt"],
            "network": config["NetworkMode"],
            "pid_mode": config["PidMode"],
            "privileged": config["Privileged"],
            "mounts": [
                {key: mount.get(key) for key in ("Type", "Name", "Destination", "RW")}
                for mount in inspected["Mounts"]
            ],
        }
        assert config["Runtime"] == "runsc-project" and not config["Privileged"]
        assert config["CapDrop"] == ["ALL"] and not config["CapAdd"]
        assert inspected["Config"]["User"] == "65532:65532"
        assert (
            len(inspected["Mounts"]) == 1
            and inspected["Mounts"][0]["Name"] == "pe-" + project
        )
    assert REPORT["profiles"]["a"]["id"] != REPORT["profiles"]["b"]["id"]
    save()


def setup():
    if (
        not Path("/probe/host-entrypoint.sh").exists()
        or os.environ.get("PROJECT_EGRESS_DISPOSABLE") != "yes"
    ):
        raise RuntimeError("dedicated disposable host required")
    runtime = json.loads(
        docker("info", "--format", '{{json (index .Runtimes "runsc-project")}}')
    )
    pins = dict(
        line.split("=", 1)
        for line in Path("/probe/runtime-pins.env").read_text().splitlines()
        if "=" in line
    )
    expected_args = json.loads(pins["RUNSC_PROJECT_ARGS"].strip("'"))
    assert runtime["runtimeArgs"] == expected_args
    binary = runtime["path"]
    assert binary == "/opt/verity/runsc/" + pins["RUNSC_RELEASE"] + "/runsc"
    version = run(binary, "--version").stdout
    assert version.splitlines()[0] == "runsc version " + pins["RUNSC_RELEASE"]
    import hashlib

    architecture = run("uname", "-m").stdout.strip()
    checksum = pins[
        "RUNSC_SHA512_X86_64" if architecture == "x86_64" else "RUNSC_SHA512_AARCH64"
    ]
    assert hashlib.sha512(Path(binary).read_bytes()).hexdigest() == checksum
    REPORT["runtime"] = {
        "attested": True,
        "name": "runsc-project",
        "version": version,
        "registration": runtime,
        "sha512": checksum,
    }
    REPORT["image_id"] = docker("image", "inspect", IMAGE, "--format", "{{.Id}}")
    for index, suffix in enumerate(("a", "b", "r"), 1):
        docker(
            "network",
            "create",
            "--driver",
            "bridge",
            "--ipv6",
            "--subnet",
            f"172.31.{index}.0/24",
            "--subnet",
            f"fd42:7654:{index}::/64",
            "--opt",
            f"com.docker.network.bridge.name=pe-{suffix}",
            "--opt",
            "com.docker.network.bridge.enable_ip_masquerade=false",
            "pe-" + suffix,
        )
    forwarding()
    for name in ("receiver", "other"):
        docker(
            "run",
            "-d",
            "--name",
            "pe-" + name,
            "--runtime",
            "runc",
            "--network",
            "pe-r",
            "--ip",
            ADDRESSES[name][0],
            "--ip6",
            ADDRESSES[name][1],
            "--restart",
            "unless-stopped",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges=true",
            "--sysctl",
            "net.ipv4.ip_unprivileged_port_start=0",
            "--memory",
            "192m",
            "--memory-swap",
            "192m",
            "--cpus",
            "0.5",
            "--pids-limit",
            "64",
            "-e",
            "DNS_ADDRESSES=" + json.dumps([ADDRESSES["receiver"], ADDRESSES["other"]]),
            "-e",
            "REDIRECT_TARGET=" + ADDRESSES["other"][0],
            IMAGE,
            "receiver",
        )
        wait_until(lambda: '"ready": true' in docker("logs", "pe-" + name))
    for project in ("a", "b"):
        docker("volume", "create", "pe-" + project)
        # Only this trusted initialization helper runs as root, with no networking.
        docker(
            "run",
            "--rm",
            "--network",
            "none",
            "--user",
            "0:0",
            "--cap-drop",
            "ALL",
            "--cap-add",
            "CHOWN",
            "--security-opt",
            "no-new-privileges=true",
            "--entrypoint",
            "chown",
            "-v",
            "pe-" + project + ":/work",
            IMAGE,
            "65532:65532",
            "/work",
        )
        docker(
            "run",
            "-d",
            "--name",
            "pe-" + project,
            "--runtime",
            "runsc-project",
            "--network",
            "pe-" + project,
            "--ip",
            ADDRESSES[project][0],
            "--ip6",
            ADDRESSES[project][1],
            "--dns",
            ADDRESSES["receiver"][0],
            "--user",
            "65532:65532",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges=true",
            "--pids-limit",
            "512",
            "--memory",
            "512m",
            "--memory-swap",
            "512m",
            "--cpus",
            "0.5",
            "--restart",
            "unless-stopped",
            "-v",
            "pe-" + project + ":/work",
            IMAGE,
            "project",
            project,
        )
        wait_project(project)
    run("sysctl", "-w", "net.netfilter.nf_conntrack_tcp_loose=0")
    profiles()


def controls():
    grant([["a", "receiver"], ["b", "receiver"], ["a", "other"], ["b", "other"]])
    for family in (4, 6):
        for kind in KINDS:
            for phase, project, target in (
                ("control-a", "a", "receiver"),
                ("control-b", "b", "receiver"),
                ("control-other", "a", "other"),
                ("control-b-other", "b", "other"),
            ):
                network(f"{phase}-{kind}-{family}", project, target, kind, family, True)
    grant([["a", "receiver"]])
    for family in (4, 6):
        for kind in KINDS:
            for phase, project, target, allowed, control in (
                ("allow-a", "a", "receiver", True, None),
                ("deny-b", "b", "receiver", False, "control-b"),
                ("deny-other", "a", "other", False, "control-other"),
                ("deny-b-other", "b", "other", False, "control-b-other"),
            ):
                network(
                    f"{phase}-{kind}-{family}",
                    project,
                    target,
                    kind,
                    family,
                    allowed,
                    f"{control}-{kind}-{family}" if control else None,
                )
    grant([["b", "receiver"]])
    for family in (4, 6):
        for kind in KINDS:
            network(f"grant-b-{kind}-{family}", "b", "receiver", kind, family, True)
    revoke()
    for family in (4, 6):
        for kind in KINDS:
            network(
                f"revoke-b-{kind}-{family}",
                "b",
                "receiver",
                kind,
                family,
                False,
                f"grant-b-{kind}-{family}",
            )


def bypasses():
    grant([["b", "receiver"], ["a", "receiver"], ["a", "other"]])
    network(
        "embedded-dns-control",
        "b",
        "receiver",
        "dns",
        4,
        True,
        request={"host": "127.0.0.11"},
        observer="receiver",
    )
    network("shell-control", "b", "receiver", "tcp", 4, True, child=True)
    network("install-control", "a", "other", "tcp", 4, True, child="install")
    network("redirect-control", "a", "receiver", "redirect", 4, True, observer="other")
    network(
        "dns-target-control",
        "a",
        "receiver",
        "resolve",
        4,
        True,
        request={"suffix": ".switch.test"},
        observer="other",
        transport="tcp",
    )
    grant([["a", "receiver"]])
    network(
        "shell-child", "b", "receiver", "tcp", 4, False, "shell-control", child=True
    )
    network(
        "install-child",
        "a",
        "other",
        "tcp",
        4,
        False,
        "install-control",
        child="install",
    )
    network(
        "forged-project",
        "b",
        "receiver",
        "tcp",
        4,
        False,
        "control-b-tcp-4",
        request={"project": "a", "generation": 1},
    )
    network(
        "redirect",
        "a",
        "receiver",
        "redirect",
        4,
        False,
        "redirect-control",
        observer="other",
    )
    network(
        "dns-target-change",
        "a",
        "receiver",
        "resolve",
        4,
        False,
        "dns-target-control",
        request={"suffix": ".switch.test"},
        observer="other",
        transport="tcp",
    )
    network(
        "embedded-dns",
        "b",
        "receiver",
        "dns",
        4,
        False,
        "embedded-dns-control",
        request={"host": "127.0.0.11"},
        observer="receiver",
    )
    # A reachable host-side synthetic receiver proves that the input fence, not
    # absence of a service, denies gateway access. No Docker API is exposed.
    docker(
        "run",
        "-d",
        "--name",
        "pe-gateway",
        "--network",
        "host",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--memory",
        "192m",
        "--memory-swap",
        "192m",
        "--cpus",
        "0.5",
        "--pids-limit",
        "64",
        "-e",
        "DNS_ADDRESSES=" + json.dumps([ADDRESSES["receiver"], ADDRESSES["other"]]),
        "-e",
        "REDIRECT_TARGET=" + ADDRESSES["other"][0],
        IMAGE,
        "receiver",
    )
    wait_until(lambda: '"ready": true' in docker("logs", "pe-gateway"))
    grant([["a", "gateway"]])
    network("gateway-control", "a", "gateway", "tcp", 4, True)
    revoke()
    network("gateway-denied", "a", "gateway", "tcp", 4, False, "gateway-control")
    # Route synthetic metadata and foreign-project addresses to a listening
    # receiver only in this disposable host. Their absence cannot fake a denial.
    for case_id, address in (
        ("metadata-denied", "169.254.169.254"),
        ("foreign-project-denied", ADDRESSES["b"][0]),
    ):
        # Destination changes after prerouting must still hit the ingress-bound fence.
        run(
            "iptables",
            "-t",
            "nat",
            "-I",
            "PREROUTING",
            "-i",
            "pe-a",
            "-d",
            address,
            "-p",
            "tcp",
            "--dport",
            "8080",
            "-j",
            "DNAT",
            "--to-destination",
            ADDRESSES["receiver"][0] + ":8080",
        )
        control_id = case_id.replace("-denied", "-control")
        grant([["a", "receiver"]])
        network(control_id, "a", "receiver", "tcp", 4, True, request={"host": address})
        revoke()
        network(
            case_id,
            "a",
            "receiver",
            "tcp",
            4,
            False,
            control_id,
            request={"host": address},
        )
        run(
            "iptables",
            "-t",
            "nat",
            "-D",
            "PREROUTING",
            "-i",
            "pe-a",
            "-d",
            address,
            "-p",
            "tcp",
            "--dport",
            "8080",
            "-j",
            "DNAT",
            "--to-destination",
            ADDRESSES["receiver"][0] + ":8080",
        )
    for project, foreign in (("a", "b"), ("b", "a")):
        foreign_pid = docker("inspect", "pe-" + foreign, "--format", "{{.State.Pid}}")
        result = command(
            project,
            {
                "action": "boundary",
                "paths": [
                    f"/work/{foreign}-only",
                    "/var/run/docker.sock",
                    "/run/docker.sock",
                    "/proc/1/root/var/run/docker.sock",
                    "/var/lib/docker/volumes",
                    f"/proc/{foreign_pid}/ns/net",
                    f"/proc/{foreign_pid}/root/work/{foreign}-only",
                ],
                "socket": f"/work/{foreign}.sock",
            },
        )
        own = command(
            project,
            {
                "action": "boundary",
                "paths": [f"/work/{project}-only"],
                "socket": f"/work/{project}.sock",
            },
        )
        passed = (
            result.get("visible") == []
            and result.get("socket_access") is False
            and "/probe/agent.py project" in result.get("pid1", "")
            and own.get("socket_access") is True
            and own.get("visible") == [f"/work/{project}-only"]
        )
        REPORT["cases"].append(
            {
                "id": "boundary-" + project,
                "type": "boundary",
                "result": result,
                "control": own,
                "status": "pass" if passed else "fail",
            }
        )
    REPORT["cases"].append(
        {
            "id": "host-control",
            "type": "boundary",
            "status": "pass"
            if all(
                not p["privileged"] and p["pid_mode"] == ""
                for p in REPORT["profiles"].values()
            )
            else "fail",
        }
    )
    save()


def mutation_checks():
    grant([["a", "receiver"]])
    # An actual missing external fence must be noticed by the independent receiver.
    nft("flush chain inet project_egress fence")
    try:
        network(
            "mutation-removed-fence",
            "b",
            "receiver",
            "tcp",
            4,
            False,
            "control-b-tcp-4",
        )
        mutation = REPORT["cases"].pop()
        if mutation["status"] != "fail" or not mutation["observed"]:
            raise RuntimeError("removed-fence mutation was not detected")
        REPORT["mutations"] = {"removed_fence": mutation}
    finally:
        stop_controller()
        nft("delete table inet project_egress\n" + base_rules())
    # Suppress the receiver's positive observation and require evaluator rejection.
    positive = next(case for case in REPORT["cases"] if case["id"] == "control-b-tcp-4")
    original = positive["observed"]
    positive["observed"] = False
    errors = verify(REPORT)
    positive["observed"] = original
    detected = "receiver mismatch: control-b-tcp-4" in errors
    REPORT["mutations"]["suppressed_positive_detected"] = detected
    if not detected:
        raise RuntimeError("suppressed-observer mutation was not detected")
    save()


def established_closure(event, started):
    # One command submits all four retained sockets, avoiding serial Docker
    # startup delays that would move later observations past the deadline.
    flows = [
        {
            "id": f"{event}-{kind}-{family}",
            "marker": uuid.uuid4().hex,
            "kind": kind,
            "family": family,
        }
        for family in (4, 6)
        for kind in ("tcp", "udp")
    ]
    batch = command("a", {"action": "flow-send-batch", "flows": flows})
    results = batch.get("results", [])
    if len(results) != len(flows):
        raise RuntimeError("incomplete established-flow closure batch")
    time.sleep(0.15)
    receipts = observations("receiver")
    # This is a conservative upper bound shared by all four observations,
    # including command and observer overhead, not a clock inside the sandbox.
    elapsed = time.monotonic() - started
    REPORT["closure_seconds"][event] = {}
    for flow, result in zip(flows, results):
        kind, family = flow["kind"], flow["family"]
        attempted = result.get("sent") is True or result.get("error") in (
            "BrokenPipeError",
            "ConnectionResetError",
            "ConnectionAbortedError",
        )
        observed = any(row["marker"] == flow["marker"] for row in receipts)
        REPORT["closure_seconds"][event][f"{kind}-{family}"] = elapsed
        REPORT["cases"].append(
            {
                "id": f"{event}-after-{kind}-{family}",
                "type": "network",
                "marker": flow["marker"],
                "expected": False,
                "observed": observed,
                "control": f"{event}-before-{kind}-{family}",
                "result": result,
                "observer": "receiver",
                "transport": None,
                "attempted": attempted,
                "status": "pass"
                if attempted and not observed and elapsed <= 2
                else "fail",
            }
        )
    save()


def lifecycle():
    for event in ("revoke", "expiry", "controller-crash"):
        grant([["a", "receiver"]])
        for family in (4, 6):
            for kind in ("tcp", "udp"):
                flow_id = f"{event}-{kind}-{family}"
                result = command(
                    "a",
                    {
                        "action": "flow-start",
                        "kind": kind,
                        "host": ADDRESSES["receiver"][family == 6],
                        "id": flow_id,
                    },
                )
                assert result.get("opened") is True, result
                network(
                    f"{event}-before-{kind}-{family}",
                    "a",
                    "receiver",
                    kind,
                    family,
                    True,
                    request={"action": "flow-send", "id": flow_id},
                )
        start = time.monotonic()
        if event == "revoke":
            revoke()
        elif event == "expiry":
            # Stop refreshing naturally; no revoke transaction supplies the result.
            (OUT / "controller-ready.expiry").write_text(str(time.monotonic() + 0.3))
            CONTROLLER.wait(timeout=3)
            time.sleep((LEASE_MS + 100) / 1000)
        else:
            stop_controller()  # SIGKILL, not graceful cleanup.
            time.sleep((LEASE_MS + 100) / 1000)
        established_closure(event, start)
        for family in (4, 6):
            for kind in ("tcp", "udp"):
                network(
                    f"{event}-new-{kind}-{family}",
                    "a",
                    "receiver",
                    kind,
                    family,
                    False,
                    f"control-a-{kind}-{family}",
                )
    grant([])
    restart_checks("controller-restart")
    grant([["a", "receiver"]])
    # The supervisor clears the old generation before permitting a replacement.
    revoke()
    docker("restart", "pe-a", timeout=30)
    wait_project("a")
    restart_checks("project-restart")


def restart_checks(event):
    for family in (4, 6):
        network(
            f"{event}-denied-{family}",
            "a",
            "receiver",
            "tcp",
            family,
            False,
            f"control-a-tcp-{family}",
        )
    grant([["a", "receiver"]])
    for family in (4, 6):
        network(f"{event}-fresh-{family}", "a", "receiver", "tcp", family, True)
        network(
            f"{event}-b-denied-{family}",
            "b",
            "receiver",
            "tcp",
            family,
            False,
            f"control-b-tcp-{family}",
        )
    revoke()


def recheck_receipts():
    logs = {target: observations(target) for target in ("receiver", "other", "gateway")}
    for case in REPORT["cases"]:
        if case["type"] != "network":
            continue
        case["observed"] = any(
            row["marker"] == case["marker"]
            and (case["transport"] is None or row["transport"] == case["transport"])
            for row in logs[case["observer"]]
        )
        case["status"] = (
            "pass"
            if case["observed"] == case["expected"] and case.get("attempted", True)
            else "fail"
        )


def snapshot(label):
    (OUT / f"firewall-{label}.txt").write_text(run("nft", "list", "ruleset").stdout)
    for name in ("receiver", "other", "gateway"):
        (OUT / f"{name}-{label}.jsonl").write_text(docker("logs", "pe-" + name) + "\n")
    save()


def main():
    global REPORT
    if sys.argv[1] == "before-restart":
        setup()
        controls()
        mutation_checks()
        bypasses()
        lifecycle()
        # Leave a live lease and running projects at daemon shutdown. The outer
        # restart must destroy it and install an empty fence before auto-start.
        grant([["a", "receiver"]])
        snapshot("before-restart")
        return
    REPORT = json.loads((OUT / "result.json").read_text())
    forwarding()
    for project in ("a", "b"):
        wait_project(project)
    wait_until(lambda: '"ready": true' in docker("logs", "pe-receiver"))
    profiles()
    restart_checks("daemon-restart")
    grant([["a", "receiver"]])
    for family in (4, 6):
        for kind in KINDS:
            network(
                f"final-control-{kind}-{family}", "a", "receiver", kind, family, True
            )
    revoke()
    recheck_receipts()
    REPORT["complete"] = True
    snapshot("final")
    failures = verify(REPORT)
    (OUT / "verification.json").write_text(
        json.dumps({"passed": not failures, "failures": failures}, indent=2)
    )
    if failures:
        raise RuntimeError("; ".join(failures))


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        REPORT["error"] = type(error).__name__ + ": " + str(error)
        save()
        stop_controller()
        raise
