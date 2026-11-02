"""Disposable-host-only nftables fence; never imported by production code."""

import json
import subprocess
import sys
import time
from pathlib import Path

BRIDGES = {"a": "pe-a", "b": "pe-b"}
ADDRESSES = {
    "a": ("172.31.1.2", "fd42:7654:1::2"),
    "b": ("172.31.2.2", "fd42:7654:2::2"),
    "receiver": ("172.31.3.2", "fd42:7654:3::2"),
    "other": ("172.31.3.3", "fd42:7654:3::3"),
    "gateway": ("172.31.1.1", "fd42:7654:1::1"),
}
PORTS = (("tcp", 8080), ("udp", 8080), ("udp", 53), ("tcp", 53), ("udp", 4433))
LEASE_MS = 1000


def nft(script):
    subprocess.run(["nft", "-f", "-"], input=script, text=True, check=True, timeout=5)


def base_rules():
    source_guards = "\n".join(
        f'iifname "{bridge}" ip saddr != {ADDRESSES[project][0]} drop\n'
        f'iifname "{bridge}" ip6 saddr != {ADDRESSES[project][1]} drop'
        for project, bridge in BRIDGES.items()
    )
    return f"""
table inet project_egress {{
 set allow4 {{ type ifname . ipv4_addr . inet_proto . inet_service; flags timeout; }}
 set allow6 {{ type ifname . ipv6_addr . inet_proto . inet_service; flags timeout; }}
 chain fence {{
  ct state invalid counter drop
  {source_guards}
  iifname . ip daddr . meta l4proto . th dport @allow4 counter accept
  iifname . ip6 daddr . meta l4proto . th dport @allow6 counter accept
  counter drop
 }}
 chain forward {{
  type filter hook forward priority -200; policy accept;
  iifname {{ "pe-a", "pe-b" }} jump fence
 }}
 chain input {{
  type filter hook input priority -200; policy accept;
  iifname {{ "pe-a", "pe-b" }} ip6 hoplimit 255 icmpv6 type {{ nd-neighbor-solicit, nd-neighbor-advert }} accept
  iifname {{ "pe-a", "pe-b" }} jump fence
 }}
}}
"""


def refresh_rules(grants):
    # A single transaction has no flush/add opening. No established-flow exemption.
    commands = [f"flush set inet project_egress allow{family}" for family in (4, 6)]
    for project, target in grants:
        bridge = BRIDGES[project]
        addresses = ADDRESSES[target]
        for index, family in enumerate((4, 6)):
            for protocol, port in PORTS:
                commands.append(
                    f'add element inet project_egress allow{family} {{ "{bridge}" . '
                    f"{addresses[index]} . {protocol} . {port} timeout {LEASE_MS}ms }}"
                )
    return "\n".join(commands) + "\n"


def controller(grants, duration, ready):
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        expiry = Path(ready + ".expiry")
        if expiry.exists() and time.monotonic() >= float(expiry.read_text()):
            return
        nft(refresh_rules(grants))
        Path(ready).touch()
        time.sleep(0.15)
    # Expiry is enforced by the kernel even if this process is killed before here.


if __name__ == "__main__":
    controller(json.loads(sys.argv[1]), float(sys.argv[2]), sys.argv[3])
