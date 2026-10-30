"""Exercise actual project capability checks through the real relay TCP connection."""
import http.client
import json
import os
from pathlib import Path
import socket
import sys
import time
from urllib.parse import urlsplit


def connect():
    url = urlsplit(os.environ['VERITY_PROJECT_MEMORY_URL'])
    return http.client.HTTPConnection(url.hostname, url.port, timeout=1), url.path


def append(connection, path, text, token=None):
    capability = Path(os.environ['VERITY_GH_BROKER_CAPABILITY_FILE']).read_text().strip() if token is None else token
    body = json.dumps({'text': text}).encode()
    # The relay intentionally rejects Accept-Encoding, including http.client's
    # implicit identity header. Send only the actual broker request contract.
    connection.putrequest('POST', path, skip_accept_encoding=True)
    connection.putheader('Authorization', f'Bearer {capability}')
    connection.putheader('Content-Type', 'application/json')
    connection.putheader('Content-Length', str(len(body)))
    connection.endheaders(body)
    response = connection.getresponse()
    body = response.read()
    return response.status, body


def main():
    mode = sys.argv[1]
    if mode == 'external':
        for family, address in [(socket.AF_INET, '172.30.105.2'), (socket.AF_INET6, 'fd42:feed:5::2')]:
            for port in (53, 8080):
                with socket.socket(family, socket.SOCK_DGRAM) as channel:
                    channel.sendto(b'direct-own-credential-marker', (address, port))
            with socket.socket(family, socket.SOCK_STREAM) as channel:
                channel.settimeout(0.5)
                try:
                    channel.connect((address, 443))
                    channel.sendall(b'GET /direct-own-credential-marker HTTP/1.1\r\nAuthorization: Bearer fixture-own-credential\r\n\r\n')
                    channel.recv(1024)
                except OSError:
                    pass
        return
    if mode == 'positive':
        channel, path = connect()
        status, body = append(channel, path, 'boot-positive\n')
        assert status == 200 and json.loads(body)['ok'] is True, (status, body)
        channel.close()
        channel, path = connect()
        status, _ = append(channel, path, 'forged\n', 'forged-capability')
        assert status == 401, status
        print('authenticated-memory-positive; forged-capability-denied', flush=True)
        return
    assert mode == 'stream'
    phase = sys.argv[2]
    channel, path = connect()
    # Connect once. Never reconnect an old stream after revocation/readmission.
    channel.connect()
    original = channel.sock
    attempts = successes = 0
    last_success = 0
    while True:
        attempts += 1
        try:
            if channel.sock is not original:
                break
            status, _ = append(channel, path, f'boot-stream-{phase}\n')
            successes += int(status == 200)
            if status == 200:
                last_success = time.time_ns()
        except (OSError, http.client.HTTPException):
            # HTTPConnection can automatically reconnect after an error: retaining
            # the raw failed socket prevents this from becoming a fresh positive.
            break
        checkpoint = Path(f'/work/.boot-stream-{phase}.json.tmp')
        checkpoint.write_text(json.dumps({
            'attempts': attempts, 'successes': successes, 'last_success_ns': last_success,
        }))
        checkpoint.replace(f'/work/.boot-stream-{phase}.json')
        time.sleep(0.05)
    # Keep the original descriptor attempting bytes without the HTTP helper's retry.
    raw = original
    while True:
        attempts += 1
        try:
            if raw:
                raw.send(b'POST /internal/project/memory HTTP/1.1\r\n')
        except OSError:
            pass
        Path(f'/work/.boot-alive-{phase}').write_text(str(time.time_ns()))
        time.sleep(0.05)


if __name__ == '__main__':
    main()
