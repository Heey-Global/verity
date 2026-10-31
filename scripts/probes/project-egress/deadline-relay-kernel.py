"""Run the relay packet matrix against the loaded kernel TC program in the disposable VM.

BPF_PROG_TEST_RUN verifies program execution, not end-to-end network delivery.
No production host configuration is installed by this fixture.
"""
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest

from test_deadline_relay import RelayPacketTests

# Import the guest helper without invoking its command-line entry point.
import importlib.util
spec = importlib.util.spec_from_file_location('deadline_guest', Path(__file__).with_name('deadline-guest.py'))
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
spec = importlib.util.spec_from_file_location('deadline_host', Path(__file__).with_name('project-egress-deadline.py'))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class KernelRelayPacketTests(RelayPacketTests):
    @classmethod
    def setUpClass(cls):
        assert os.geteuid() == 0 and os.environ.get('PROJECT_EGRESS_DISPOSABLE') == 'yes'
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        cls.index = int((Path('/sys/class/net') / guest.PEER / 'ifindex').read_text())

    def setUp(self):
        super().setUp()
        # Zero direct lease: only the explicitly enabled system class can pass.
        guest.element('deadline', struct.pack('<QII', 0, self.index, 0), True)
        self.context_index = self.index

    def tearDown(self):
        # Never leave the synthetic endpoints enabled for subsequent deadline probes.
        host.write_relay(guest.PINS)
        guest.element('deadline', struct.pack('<QII', 0, self.index, 0), True)

    def matches(self, data, length=None):
        host.write_relay(guest.PINS, bytes(self.policy))
        packet = bytes(data[:length]) if length is not None else bytes(data)
        # The kernel requires at least an Ethernet header for a TC test skb.
        (self.root / 'packet').write_bytes(packet.ljust(14, b'\0'))
        context = bytearray(72)
        struct.pack_into('<I', context, 40, self.context_index)  # __sk_buff.ifindex
        (self.root / 'context').write_bytes(context)
        result = json.loads(subprocess.check_output([
            'bpftool', '-j', 'prog', 'run', 'pinned', str(guest.PINS / 'guard'),
            'data_in', str(self.root / 'packet'), 'ctx_in', str(self.root / 'context'),
            'repeat', '1'], text=True))
        self.assertIn(result['retval'], (0, 2), result)
        return result['retval'] == 0

    def test_interface_and_reserved_binding_are_required(self):
        self.assertTrue(self.matches(self.packet()))
        guest.element('deadline', struct.pack('<QII', 0, self.index + 10000, 0), True)
        self.assertFalse(self.matches(self.packet()))
        guest.element('deadline', struct.pack('<QII', 0, self.index, 1), True)
        self.assertFalse(self.matches(self.packet()))
        guest.element('deadline', struct.pack('<QII', 0, self.index, 0), True)
        self.assertTrue(self.matches(self.packet()))


if __name__ == '__main__':
    # Select only the kernel subclass; the ordinary C suite runs separately.
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(KernelRelayPacketTests)
    outcome = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if outcome.wasSuccessful() else 1)
