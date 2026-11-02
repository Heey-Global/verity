"""Continuously exercise inherited and SCM_RIGHTS-transferred project sockets."""
import array
import os
import socket
import time
import sys

destination = (sys.argv[1] if len(sys.argv) > 1 else '172.30.105.2',
               int(sys.argv[2]) if len(sys.argv) > 2 else 8080)
udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
left, right = socket.socketpair()
if os.fork() == 0:
    left.close()
    _, ancillary, _, _ = right.recvmsg(1, socket.CMSG_SPACE(array.array('i').itemsize))
    descriptors = array.array('i')
    descriptors.frombytes(ancillary[0][2][:descriptors.itemsize])
    transferred = socket.socket(fileno=descriptors[0])
    print('transferred-socket-ready', flush=True)
    while True:
        transferred.sendto(b'transferred-startup-marker', destination)
        time.sleep(0.02)
right.close()
left.sendmsg([b'x'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [udp.fileno()]))])
print('sending', flush=True)
while True:
    udp.sendto(b'host-startup-marker', destination)
    time.sleep(0.02)
