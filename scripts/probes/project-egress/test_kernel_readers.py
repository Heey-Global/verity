"""Wire-derived Linux UAPI checks for the narrowly scoped deadline readers."""
import ctypes
import importlib.util
import json
import socket
import struct
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('kernel_readers', Path(__file__).resolve().parents[3] / 'deploy/egress/project-egress-deadline.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


def attribute(kind, value):
    raw = struct.pack('<HH', len(value) + 4, kind) + value
    return raw + bytes((-len(raw)) % 4)


def message(kind, body, flags=2, seq=7, pid=9):
    raw = struct.pack('<IHHII', len(body) + 16, kind, flags, seq, pid) + body
    return raw + bytes((-len(raw)) % 4)


def classifier(identity=42, generic=9, direct=1, extra=b'', parent=0xfffffff2, index=5):
    options = b''.join(attribute(kind, struct.pack('<I', value)) for kind, value in [(8, direct), (9, generic), (11, identity)]) + extra
    return struct.pack('<BBHiIII', 0, 0, 0, index, 1, parent, 1 << 16 | socket.htons(3)) + attribute(1, b'bpf\0') + attribute(2, options)


class RouteReaders(unittest.TestCase):
    def test_complete_multipart_and_exact_sequence_sender_identity(self):
        data = message(16, b'link') + message(3, bytes(4))
        self.assertEqual(host.route_frames(data, 7, 9, 16), ([b'link'], True))
        self.assertEqual(host.route_frames(message(16, b'link'), 7, 9, 16), ([b'link'], False))

    def test_rejects_interrupted_truncated_foreign_or_failed_messages(self):
        valid = message(16, b'link')
        for data in [valid[:-1], b'bad', message(16, b'x', seq=8), message(16, b'x', pid=0),
                     message(16, b'x', flags=18), message(2, bytes(4)), message(3, struct.pack('<i', -1)),
                     message(3, bytes(4)) + valid, message(17, b'wrong')]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                host.route_frames(data, 7, 9, 16)

    def test_attributes_reject_duplicate_short_and_unsupported_byte_order(self):
        good = attribute(3, b'eth0\0')
        self.assertEqual(host.route_string(host.route_attributes(good)[3]), 'eth0')
        for data in [good + good, b'bad', struct.pack('<HH', 2, 1), good[:-1], attribute(0x4003, b'bad')]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                host.route_attributes(data)
        for value in [b'missing-nul', b'a\0b\0', b'\xff\0']:
            with self.assertRaises((ValueError, UnicodeError)):
                host.route_string(value)

    def test_tc_normalization_preserves_existing_attestation_decisions(self):
        with patch.object(host, 'route_dump', return_value=[classifier()]):
            result = host.kernel_filters(5, 'ingress')
        host.attest_filters(result, 42)
        for changes in [{'generic': 1 | 2}, {'generic': 1 | 4}, {'direct': 0}, {'identity': 43},
                        {'extra': attribute(1, b'action')}, {'parent': 0xfffffff3}, {'index': 6}]:
            with self.subTest(changes=changes), patch.object(host, 'route_dump', return_value=[classifier(**changes)]):
                with self.assertRaises(ValueError):
                    host.attest_filters(host.kernel_filters(5, 'ingress'), 42)

    def test_link_normalization_retains_peer_bridge_kind_mac_and_index(self):
        link = struct.pack('<BBHiII', 0, 0, 1, 5, 0, 0) + attribute(3, b'veth5\0') + attribute(1, bytes.fromhex('021122334455')) + attribute(5, struct.pack('<I', 7)) + attribute(18, attribute(1, b'veth\0'))
        with patch.object(host, 'route_dump', return_value=[link]):
            self.assertEqual(host.kernel_links(), [{'ifindex': 5, 'ifname': 'veth5', 'address': '02:11:22:33:44:55', 'link_index': 7, 'linkinfo': {'info_kind': 'veth'}}])
        with patch.object(host, 'route_dump', return_value=[link[:15]]), self.assertRaises(ValueError):
            host.kernel_links()

    def test_socket_dump_checks_kernel_sender_truncation_count_deadline_and_done(self):
        connection = Mock()
        connection.__enter__ = Mock(return_value=connection)
        connection.__exit__ = Mock(return_value=False)
        connection.getsockname.return_value = (9, 0)
        connection.recvmsg.side_effect = [(message(16, b'link'), [], 0, (0, 0)), (message(3, bytes(4)), [], 0, (0, 0))]
        with patch.object(host.socket, 'socket', return_value=connection), patch.object(host.os, 'urandom', return_value=(7).to_bytes(4, 'little')):
            self.assertEqual(host.route_dump(18, bytes(16)), [b'link'])
            for flags, sender in [(socket.MSG_TRUNC, (0, 0)), (0, (10, 0))]:
                connection.recvmsg.side_effect = [(message(3, bytes(4)), [], flags, sender)]
                with self.assertRaises(ValueError):
                    host.route_dump(18, bytes(16))
            with patch.object(host.time, 'monotonic', side_effect=[0, 2]), self.assertRaises(TimeoutError):
                host.route_dump(18, bytes(16))


class NamespaceReaders(unittest.TestCase):
    def context(self):
        self.enterContext(patch.object(host.os, 'open', side_effect=[10, 11]))
        self.close = self.enterContext(patch.object(host.os, 'close'))
        self.enterContext(patch.object(host.fcntl, 'ioctl', return_value=0x40000000))
        self.enterContext(patch.object(host.os, 'fstat', return_value=types.SimpleNamespace(st_dev=1, st_ino=2)))
        self.enterContext(patch.object(host.os, 'stat', return_value=types.SimpleNamespace(st_dev=1, st_ino=2)))
        self.setns = self.enterContext(patch.object(host.os, 'setns', create=True))

    def test_restores_namespace_even_when_inspection_fails(self):
        self.context()
        with patch.object(host, 'kernel_links', side_effect=ValueError('failed')), self.assertRaises(ValueError):
            host.namespace_links('/var/run/docker/netns/abc')
        self.assertEqual([c.args for c in self.setns.call_args_list], [(11, 0x40000000), (10, 0x40000000)])
        self.assertEqual(self.close.call_count, 2)

    def test_failed_restoration_is_terminal_not_an_operation_error(self):
        self.context()
        self.setns.side_effect = [None, OSError('restore')]
        with patch.object(host, 'kernel_links', return_value=[]), self.assertRaises(SystemExit):
            host.namespace_links('/var/run/docker/netns/abc')

    def test_invalid_namespace_path_never_opens_a_descriptor(self):
        with patch.object(host.os, 'open') as opened, self.assertRaises(ValueError):
            host.namespace_links('/tmp/project-controlled')
        opened.assert_not_called()


class NftReaders(unittest.TestCase):
    def library(self):
        library = Mock()
        library.nft_ctx_new.return_value = 123
        library.nft_ctx_buffer_output.return_value = 0
        library.nft_ctx_buffer_error.return_value = 0
        library.nft_run_cmd_from_buffer.return_value = 0
        library.nft_ctx_get_output_buffer.return_value = b'{"nftables":[]}'
        return library

    def test_only_fixed_reads_use_a_new_freed_context(self):
        library = self.library()
        with patch.object(host.ctypes, 'CDLL', return_value=library):
            self.assertEqual(host.nft_read(), {'nftables': []})
            host.nft_read('verity_egress_' + 'a' * 24)
        self.assertEqual(library.nft_ctx_new.call_count, 2)
        self.assertEqual(library.nft_ctx_free.call_count, 2)
        self.assertEqual(library.nft_run_cmd_from_buffer.call_args_list[0].args, (123, b'list ruleset'))
        with patch.object(host.ctypes, 'CDLL') as load, self.assertRaises(ValueError):
            host.nft_read('x; flush ruleset')
        load.assert_not_called()

    def test_errors_and_oversized_or_malformed_output_free_the_context(self):
        for output in [b'bad', b'{}', b'x' * (host.MAX_KERNEL_BYTES + 1)]:
            library = self.library()
            library.nft_ctx_get_output_buffer.return_value = output
            with patch.object(host.ctypes, 'CDLL', return_value=library), self.assertRaises(ValueError):
                host.nft_read()
            library.nft_ctx_free.assert_called_once_with(123)
        library = self.library()
        library.nft_run_cmd_from_buffer.return_value = -1
        with patch.object(host.ctypes, 'CDLL', return_value=library), self.assertRaises(ValueError):
            host.nft_read()
        library.nft_ctx_free.assert_called_once_with(123)


class ProgramReaders(unittest.TestCase):
    def test_bpf_identity_reads_the_pinned_fd_and_closes_it(self):
        def syscall(command, attr):
            if command == 7:
                self.assertEqual(ctypes.string_at(attr.pathname), b'/pins/guard')
                return 12
            self.assertEqual(command, 15)
            self.assertEqual(attr.fd, 12)
            ctypes.memmove(attr.info, struct.pack('<II', 3, 42), 8)
            return 0
        with patch.object(host, 'bpf', side_effect=syscall), patch.object(host.os, 'close') as close:
            self.assertEqual(host.kernel_program(Path('/pins')), {'id': 42, 'type': 'sched_cls'})
        close.assert_called_once_with(12)

    def test_bpf_read_failure_never_leaks_the_pin_fd(self):
        with patch.object(host, 'bpf', side_effect=[12, OSError('refused')]), patch.object(host.os, 'close') as close:
            with self.assertRaises(OSError):
                host.kernel_program(Path('/pins'))
        close.assert_called_once_with(12)


if __name__ == '__main__':
    unittest.main()
