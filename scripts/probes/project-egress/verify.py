"""Fail closed on absent cases, broken controls, observed leakage or missing runtime evidence."""

import json
import sys
from pathlib import Path

KINDS = ("tcp", "udp", "dns", "dns-tcp", "quic")


def required_cases():
    cases = set()
    for family in (4, 6):
        for kind in KINDS:
            for phase in (
                "control-a",
                "control-b",
                "control-other",
                "control-b-other",
                "allow-a",
                "deny-b",
                "deny-other",
                "deny-b-other",
                "grant-b",
                "revoke-b",
                "final-control",
            ):
                cases.add(f"{phase}-{kind}-{family}")
    cases.update(
        {
            "shell-child",
            "shell-control",
            "install-child",
            "install-control",
            "redirect-control",
            "dns-target-control",
            "forged-project",
            "redirect",
            "dns-target-change",
            "embedded-dns",
            "host-control",
            "gateway-control",
            "gateway-denied",
            "metadata-denied",
            "metadata-control",
            "foreign-project-denied",
            "foreign-project-control",
            "boundary-a",
            "boundary-b",
        }
    )
    for event in ("revoke", "expiry", "controller-crash"):
        for kind in ("tcp", "udp"):
            for family in (4, 6):
                for phase in ("before", "after", "new"):
                    cases.add(f"{event}-{phase}-{kind}-{family}")
    for event in ("controller-restart", "project-restart", "daemon-restart"):
        for family in (4, 6):
            cases.add(f"{event}-denied-{family}")
            cases.add(f"{event}-fresh-{family}")
            cases.add(f"{event}-b-denied-{family}")
    return cases


BOUNDARY_CASES = {"boundary-a", "boundary-b", "host-control"}


def expected_result(name):
    return (
        name.startswith(("control-", "allow-", "grant-", "final-control-"))
        or "-before-" in name
        or "-fresh-" in name
        or name.endswith("-control")
    )


def verify(report):
    failures = []
    if not report.get("complete"):
        failures.append("run incomplete")
    runtime = report.get("runtime", {})
    if not runtime.get("attested") or runtime.get("name") != "runsc-project":
        failures.append("missing attested project runtime")
    if not report.get("image_id") or not report.get("profiles"):
        failures.append("missing image or launch profiles")
    mutations = report.get("mutations", {})
    if (
        mutations.get("removed_fence", {}).get("observed") is not True
        or mutations.get("suppressed_positive_detected") is not True
    ):
        failures.append("missing runtime mutation evidence")
    cases = report.get("cases", [])
    by_id = {case["id"]: case for case in cases}
    if len(by_id) != len(cases):
        failures.append("duplicate cases")
    for missing in sorted(required_cases() - by_id.keys()):
        failures.append("missing: " + missing)
    for case in cases:
        if case["id"] in required_cases():
            expected_type = "boundary" if case["id"] in BOUNDARY_CASES else "network"
            if case.get("type") != expected_type:
                failures.append("wrong case type: " + case["id"])
            if expected_type == "network" and case.get(
                "expected"
            ) is not expected_result(case["id"]):
                failures.append("wrong expectation: " + case["id"])
        if case.get("status") != "pass":
            failures.append("failed: " + case["id"])
        if case.get("type") == "network":
            if case.get("observed") is not case.get("expected"):
                failures.append("receiver mismatch: " + case["id"])
            if not case.get("expected"):
                control = by_id.get(case.get("control"), {})
                if (
                    control.get("expected") is not True
                    or control.get("observed") is not True
                    or control.get("status") != "pass"
                ):
                    failures.append("broken positive control: " + case["id"])
    for event in ("revoke", "expiry", "controller-crash"):
        latency = report.get("closure_seconds", {}).get(event)
        if not isinstance(latency, (int, float)) or not 0 <= latency <= 2:
            failures.append("missing/late closure: " + event)
    return failures


if __name__ == "__main__":
    result = json.loads(Path(sys.argv[1]).read_text())
    errors = verify(result)
    print(json.dumps({"passed": not errors, "failures": errors}, indent=2))
    sys.exit(bool(errors))
