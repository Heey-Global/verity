"""Local checks exercise observation failures; they are not a gVisor runtime proof."""

import asyncio
import copy
import importlib.util
import socket
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import agent
import policy
import probe
from verify import BOUNDARY_CASES, expected_result, required_cases, verify


class EvidenceTests(unittest.TestCase):
    def report(self):
        cases = [
            {
                "id": name,
                "type": "boundary" if name in BOUNDARY_CASES else "network",
                "status": "pass",
                "expected": expected_result(name),
                "observed": expected_result(name),
                "control": "positive",
            }
            for name in sorted(required_cases())
        ]
        # Add a real observer pair to test the failure paths, not merely return codes.
        cases.extend(
            [
                {
                    "id": "positive",
                    "type": "network",
                    "status": "pass",
                    "expected": True,
                    "observed": True,
                },
                {
                    "id": "negative",
                    "type": "network",
                    "status": "pass",
                    "expected": False,
                    "observed": False,
                    "control": "positive",
                },
            ]
        )
        return {
            "complete": True,
            "runtime": {"attested": True, "name": "runsc-project"},
            "image_id": "sha256:synthetic",
            "profiles": {"a": {}, "b": {}},
            "mutations": {
                "removed_fence": {"observed": True},
                "suppressed_positive_detected": True,
            },
            "cases": cases,
            "closure_seconds": dict.fromkeys(
                ("revoke", "expiry", "controller-crash"), 1.2
            ),
        }

    def test_complete_fixture_and_missing_quic(self):
        report = self.report()
        self.assertEqual(verify(report), [])
        report["cases"] = [
            row for row in report["cases"] if row["id"] != "allow-a-quic-6"
        ]
        self.assertIn("missing: allow-a-quic-6", verify(report))

    def test_removed_fence_observed_payload_rejected_even_if_client_failed(self):
        report = self.report()
        report["cases"][-1]["observed"] = True
        report["cases"][-1]["result"] = {"error": "TimeoutError"}
        self.assertTrue(
            any("receiver mismatch" in message for message in verify(report))
        )

    def test_suppressed_receiver_positive_control_is_rejected(self):
        report = self.report()
        report["cases"][-2]["observed"] = False
        self.assertTrue(
            any("broken positive control" in message for message in verify(report))
        )

    def test_incomplete_missing_runtime_late_closure_and_skip_fail(self):
        for mutation in ("incomplete", "runtime", "late", "skip", "duplicate"):
            report = self.report()
            if mutation == "incomplete":
                report["complete"] = False
            elif mutation == "runtime":
                report["runtime"]["attested"] = False
            elif mutation == "late":
                report["closure_seconds"]["expiry"] = 2.01
            elif mutation == "skip":
                report["cases"][0]["status"] = "skip"
            else:
                report["cases"].append(copy.deepcopy(report["cases"][0]))
            self.assertTrue(verify(report), mutation)

    def test_network_case_cannot_be_relabelled_or_inverted(self):
        for field, value in (("type", "boundary"), ("expected", True)):
            report = self.report()
            denied = next(
                case for case in report["cases"] if case["id"] == "deny-b-tcp-4"
            )
            denied[field] = value
            self.assertTrue(verify(report))

    def test_late_receipt_after_regrant_is_not_lost(self):
        case = {
            "id": "delayed",
            "type": "network",
            "marker": "unique",
            "expected": False,
            "observed": False,
            "observer": "receiver",
            "transport": None,
            "status": "pass",
        }
        with (
            patch.object(probe, "REPORT", {"cases": [case]}),
            patch.object(
                probe,
                "observations",
                return_value=[{"marker": "unique", "transport": "tcp"}],
            ),
        ):
            probe.recheck_receipts()
        self.assertEqual(case["status"], "fail")


class PolicyTests(unittest.TestCase):
    def test_grants_are_scoped_and_cannot_accept_caller_identity(self):
        script = policy.refresh_rules([["a", "receiver"]])
        self.assertIn('"pe-a"', script)
        self.assertNotIn('"pe-b"', script)
        self.assertNotIn(policy.ADDRESSES["other"][0], script)
        self.assertIn("timeout 1000ms", script)
        with self.assertRaises(KeyError):
            policy.refresh_rules([["forged", "receiver"]])

    def test_empty_grants_clear_both_families_in_one_transaction(self):
        self.assertEqual(
            policy.refresh_rules([]).splitlines(),
            [
                "flush set inet project_egress allow4",
                "flush set inet project_egress allow6",
            ],
        )

    def test_controller_exit_leaves_only_bounded_kernel_lease(self):
        now = [0.0]
        transactions = []

        def sleep(duration):
            now[0] += duration

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(policy.time, "monotonic", side_effect=lambda: now[0]),
            patch.object(policy.time, "sleep", side_effect=sleep),
            patch.object(policy, "nft", side_effect=transactions.append),
        ):
            ready = str(Path(directory) / "ready")
            policy.controller([["a", "receiver"]], 0.3, ready)
            self.assertTrue(Path(ready).exists())
        self.assertEqual(len(transactions), 2)
        self.assertTrue(all("timeout 1000ms" in script for script in transactions))

    def test_expiry_request_stops_controller_without_refresh(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(policy, "nft") as nft,
        ):
            ready = str(Path(directory) / "ready")
            Path(ready + ".expiry").write_text("0")
            policy.controller([["a", "receiver"]], 10, ready)
            nft.assert_not_called()


class ObserverTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.events = []
        self.emit = patch.object(
            agent,
            "emit",
            side_effect=lambda marker, kind: self.events.append((marker, kind)),
        )
        self.emit.start()
        self.server = await asyncio.start_server(agent.receive_stream, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        self.emit.stop()

    async def test_real_tcp_positive_and_removed_fence_mutation(self):
        request = {
            "host": "127.0.0.1",
            "port": self.port,
            "kind": "tcp",
            "marker": "positive",
        }
        self.assertTrue((await agent.bounded(request))["received"])
        self.assertIn(("positive", "tcp"), self.events)
        # Mutation: route the nominally denied request to a live receiver.
        request["marker"] = "should-have-been-denied"
        await agent.bounded(request)
        self.assertIn(("should-have-been-denied", "tcp"), self.events)

    async def test_dns_is_nonrecursive_and_returns_changed_target(self):
        addresses = [policy.ADDRESSES["receiver"], policy.ADDRESSES["other"]]
        answer = agent.dns_response(agent.dns_query("marker.switch.test"), addresses)
        self.assertEqual(socket.inet_ntoa(answer[-4:]), addresses[1][0])
        rejected = agent.dns_response(
            agent.dns_query("marker.external.invalid"), addresses
        )
        self.assertEqual(struct.unpack("!H", rejected[2:4])[0] & 15, 3)

    async def test_udp_observation(self):
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(
            agent.DatagramReceiver, local_addr=("127.0.0.1", 0)
        )
        try:
            result = await agent.bounded(
                {
                    "host": "127.0.0.1",
                    "port": transport.get_extra_info("sockname")[1],
                    "kind": "udp",
                    "marker": "udp-control",
                }
            )
            self.assertTrue(result["received"])
            self.assertIn(("udp-control", "udp"), self.events)
        finally:
            transport.close()

    @unittest.skipUnless(
        importlib.util.find_spec("aioquic"),
        "QUIC dependency is installed in the runtime fixture",
    )
    async def test_real_quic_stream(self):
        from aioquic.asyncio import serve
        from aioquic.quic.configuration import QuicConfiguration

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                agent, "Path", side_effect=lambda p: Path(directory) / Path(p).name
            ),
        ):
            agent.certificate()
            configuration = QuicConfiguration(
                is_client=False, alpn_protocols=["egress-probe"]
            )
            configuration.load_cert_chain(
                directory + "/cert.pem", directory + "/key.pem"
            )
            server = await serve(
                "::",
                4433,
                configuration=configuration,
                stream_handler=lambda r, w: asyncio.create_task(
                    agent.receive_stream(r, w, "quic")
                ),
            )
            try:
                for host, marker in (("127.0.0.1", "quic-ipv4"), ("::1", "quic-ipv6")):
                    result = await agent.bounded(
                        {"host": host, "kind": "quic", "marker": marker}
                    )
                    self.assertTrue(result.get("received"), result)
                    self.assertIn((marker, "quic"), self.events)
            finally:
                server.close()


if __name__ == "__main__":
    unittest.main()
