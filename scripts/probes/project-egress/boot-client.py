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
                    channel.sendto(f'direct-{family}-udp-{port}-own-credential-marker'.encode(), (address, port))
            with socket.socket(family, socket.SOCK_STREAM) as channel:
                channel.settimeout(0.5)
                try:
                    channel.connect((address, 443))
                    channel.sendall(f'GET /direct-{family}-tcp-443-own-credential-marker HTTP/1.1\r\nAuthorization: Bearer fixture-own-credential\r\n\r\n'.encode())
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
    phase = sys.argv[2]
    if mode == 'inflight':
        channel, path = connect()
        channel.connect()
        body = json.dumps({'text': f'boot-inflight-{phase}' + ' ' * 4096}).encode()
        capability = Path(os.environ['VERITY_GH_BROKER_CAPABILITY_FILE']).read_text().strip()
        channel.putrequest('POST', path, skip_accept_encoding=True)
        channel.putheader('Authorization', f'Bearer {capability}')
        channel.putheader('Content-Type', 'application/json')
        channel.putheader('Content-Length', str(len(body)))
        channel.endheaders(body[:128])
        started = time.time_ns()
        Path(f'/work/.boot-inflight-{phase}-ready').write_text(str(started))
        deadline = time.monotonic() + 9
        while not Path(f'/work/.boot-inflight-{phase}-finish').exists():
            if time.monotonic() > deadline:
                raise RuntimeError('In-flight test exceeded the real relay request budget')
            time.sleep(0.01)
        status = None
        try:
            channel.send(body[128:])
            response = channel.getresponse()
            status = response.status
            response.read()
        except (OSError, http.client.HTTPException):
            pass
        Path(f'/work/.boot-inflight-{phase}-result').write_text(json.dumps({
            'status': status, 'started_ns': started, 'finished_ns': time.time_ns(),
        }))
        return
    assert mode == 'poll'
    attempts = successes = last_success = 0
    while not Path(f'/work/.boot-stop-{phase}').exists():
        attempts += 1
        channel, path = connect()
        try:
            status, _ = append(channel, path, f'boot-poll-{phase}\n')
            if status == 200:
                successes += 1
                last_success = time.time_ns()
        except (OSError, http.client.HTTPException):
            pass
        finally:
            channel.close()
        checkpoint = Path(f'/work/.boot-stream-{phase}.json.tmp')
        checkpoint.write_text(json.dumps({
            'attempts': attempts, 'successes': successes, 'last_success_ns': last_success,
            'heartbeat_ns': time.time_ns(),
        }))
        checkpoint.replace(f'/work/.boot-stream-{phase}.json')
        time.sleep(0.05)
    Path(f'/work/.boot-poll-{phase}-stopped').touch()


if __name__ == '__main__':
    main()
