"""Execute the actual packet classifier as ordinary C; not a BPF verifier proof."""
import ctypes
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest


class Policy(ctypes.Structure):
    _fields_ = [('enabled', ctypes.c_uint32), ('codex', ctypes.c_uint32),
                ('sandbox_ip', ctypes.c_ubyte * 4), ('relay_ip', ctypes.c_ubyte * 4),
                ('sandbox_mac', ctypes.c_ubyte * 6), ('relay_mac', ctypes.c_ubyte * 6)]


class RelayPacketTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which('cc'):
            raise RuntimeError('Packet classifier tests require a C compiler')
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        root = Path(cls.temporary.name)
        source = Path(__file__).resolve().parents[3] / 'deploy/egress/project-egress-deadline.bpf.c'
        (root / 'test.c').write_text('#define VERITY_RELAY_PACKET_TEST 1\n#include ' + json.dumps(str(source)) + '\n'
            'int match(const unsigned char *data, unsigned int length, '
            'const struct relay_policy *policy) { return relay_packet_matches(data, length, policy); }\n')
        subprocess.run(['cc', '-O2', '-shared', '-fPIC', '-nostdlib', '-Werror', '-Wno-unknown-pragmas',
                        str(root / 'test.c'), '-o', str(root / 'test.so')], check=True)
        cls.library = ctypes.CDLL(str(root / 'test.so'))
        cls.library.match.argtypes = [ctypes.POINTER(ctypes.c_ubyte), ctypes.c_uint32, ctypes.POINTER(Policy)]
        cls.library.match.restype = ctypes.c_int

    def setUp(self):
        self.policy = Policy(1, 0, (172, 30, 106, 2), (172, 30, 106, 3),
                             (2, 1, 2, 3, 4, 5), (2, 6, 7, 8, 9, 10))

    def matches(self, data, length=None):
        packet = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
        return bool(self.library.match(packet, len(data) if length is None else length,
                                       ctypes.byref(self.policy)))

    def packet(self, reverse=False, port=8080, arp=None):
        source_ip, target_ip = self.policy.sandbox_ip, self.policy.relay_ip
        source_mac, target_mac = self.policy.sandbox_mac, self.policy.relay_mac
        if reverse:
            source_ip, target_ip = target_ip, source_ip
            source_mac, target_mac = target_mac, source_mac
        if arp is not None:
            destination = bytes([255] * 6) if arp == 1 else bytes(target_mac)
            target_hardware = bytes(6) if arp == 1 else bytes(target_mac)
            return bytearray(destination + bytes(source_mac) + bytes.fromhex('0806') +
                struct.pack('!HHBBH', 1, 0x0800, 6, 4, arp) + bytes(source_mac) +
                bytes(source_ip) + target_hardware + bytes(target_ip))
        data = bytearray(54)
        data[:14] = bytes(target_mac) + bytes(source_mac) + bytes.fromhex('0800')
        data[14] = 0x45
        data[16:18] = struct.pack('!H', 40)
        data[20] = 0x40
        data[22:24] = bytes([64, 6])
        data[26:34] = bytes(source_ip) + bytes(target_ip)
        data[34:38] = struct.pack('!HH', port if reverse else 12345, 12345 if reverse else port)
        data[46] = 0x50
        data[47] = 0x02
        return data

    def test_only_exact_service_ports_in_both_directions(self):
        for reverse in (False, True):
            for port in (8080, 8443):
                self.assertTrue(self.matches(self.packet(reverse, port)))
            for port in (0, 53, 80, 443, 8079, 8081, 8442, 8444, 8445, 65535):
                self.assertFalse(self.matches(self.packet(reverse, port)))
            self.policy.codex = 1
            self.assertTrue(self.matches(self.packet(reverse, 8444)))
            self.policy.codex = 0

    def test_no_exception_without_an_enabled_unambiguous_policy(self):
        data = self.packet()
        for enabled, codex in ((0, 0), (2, 0), (1, 2)):
            self.policy.enabled, self.policy.codex = enabled, codex
            self.assertFalse(self.matches(data))
        self.policy.enabled, self.policy.codex = 1, 0
        self.policy.relay_ip = self.policy.sandbox_ip
        self.assertFalse(self.matches(data))
        self.setUp()
        self.policy.relay_mac = self.policy.sandbox_mac
        self.assertFalse(self.matches(data))

    def test_every_endpoint_byte_is_bound(self):
        for reverse in (False, True):
            for position in list(range(12)) + list(range(26, 34)):
                data = self.packet(reverse)
                data[position] ^= 1
                self.assertFalse(self.matches(data), (reverse, position))

    def test_no_truncated_or_alternative_protocol_exception(self):
        data = self.packet()
        for length in range(54):
            self.assertFalse(self.matches(data, length), length)
        for position, value in ((12, 0x86), (13, 0xdd), (12, 0x81), (14, 0x46),
                                (14, 0x65), (23, 17), (20, 0x20), (20, 0x80),
                                (21, 1), (17, 39), (46, 0x40)):
            changed = data.copy()
            changed[position] = value
            self.assertFalse(self.matches(changed), (position, value))

    def test_exact_arp_pair_and_hardware_identity(self):
        for reverse in (False, True):
            for opcode in (1, 2):
                data = self.packet(reverse, arp=opcode)
                self.assertTrue(self.matches(data))
                for length in range(42):
                    self.assertFalse(self.matches(data, length))
                for position in list(range(6, 12)) + list(range(14, 42)):
                    changed = data.copy()
                    changed[position] ^= 0x80
                    self.assertFalse(self.matches(changed), (reverse, opcode, position))
            reply = self.packet(reverse, arp=2)
            reply[:6] = bytes([255] * 6)
            self.assertFalse(self.matches(reply))


if __name__ == '__main__':
    unittest.main()
