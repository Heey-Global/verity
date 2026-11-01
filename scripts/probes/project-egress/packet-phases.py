"""Temporary bounded packet-header evidence for disposable admission diagnosis."""
import json
import socket
import sys
import time

channel = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3))
channel.bind((sys.argv[1], 0))
channel.settimeout(0.1)
end = time.monotonic() + 20
with open('/evidence/packet-phases.jsonl', 'w') as output:
    print(json.dumps({'ready': True}), file=output, flush=True)
    for _ in range(2000):
        if time.monotonic() >= end:
            break
        try:
            data, address = channel.recvfrom(128)
        except TimeoutError:
            continue
        print(json.dumps({'boot_ns': str(time.clock_gettime_ns(time.CLOCK_BOOTTIME)),
                          'packet_type': address[2], 'header': data.hex()}), file=output, flush=True)
