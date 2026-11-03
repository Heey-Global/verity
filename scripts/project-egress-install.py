#!/usr/bin/env python3
"""Explicit experimental offline host installation; never enables the app setting."""
import argparse
import ctypes
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

ASSETS = (
    'project-egress-host-main.mjs', 'project-egress-deadline.py',
    'project-egress-deadline.bpf.o', 'project-egress-renew.bpf.o',
    'verity-egress-bootstrap.service', 'verity-egress-host.service', 'docker-egress.conf',
)
UNITS = {
    'verity-egress-bootstrap.service': 'etc/systemd/system/verity-egress-bootstrap.service',
    'verity-egress-host.service': 'etc/systemd/system/verity-egress-host.service',
    'docker-egress.conf': 'etc/systemd/system/docker.service.d/egress.conf',
}
# Populate only with exact releases backed by native install/upgrade/recovery
# evidence. Tool availability alone does not establish kernel compatibility.
ACCEPTED_KERNEL_RELEASES = frozenset()


def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=45,
                          env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin',
                               'DOCKER_HOST': 'unix:///var/run/docker.sock'}).stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def release_files(source):
    """Digest checks catch damaged transfers; the release itself must be trusted."""
    manifest = json.loads((source / 'manifest.json').read_text())
    if not isinstance(manifest, dict) or set(manifest) != set(ASSETS):
        raise ValueError('Release must contain exactly the supported asset manifest')
    files = {}
    for name in ASSETS:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Release asset must be a regular file: ' + name)
        data = path.read_bytes()
        if manifest[name] != digest(data):
            raise ValueError('Release checksum mismatch: ' + name)
        files[name] = data
    return files


def stage(source, destination):
    """Copy prebuilt, reviewed assets; does not install dependencies or compile code."""
    if destination.exists():
        raise ValueError('Staging destination already exists')
    files = {}
    for name in ASSETS:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Missing prebuilt regular asset: ' + name)
        files[name] = path.read_bytes()
    destination.mkdir(parents=True)
    for name, data in files.items():
        (destination / name).write_bytes(data)
    (destination / 'manifest.json').write_text(json.dumps(
        {name: digest(data) for name, data in files.items()}, sort_keys=True, indent=2) + '\n')


def private_config(root, name):
    path = root / 'etc/verity-egress' / name
    # Reject writable or symlinked ancestors as well as the file itself.
    for item in (path, *path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Untrusted configuration path: ' + str(item))
        if item == root:
            break
    if not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('Configuration must be a root-owned private regular file: ' + name)
    return path


def preflight(root, run=command):
    if os.geteuid() != 0 or sys.platform != 'linux':
        raise ValueError('Installation requires root on the Linux host')
    if platform.machine() != 'x86_64' or sys.byteorder != 'little':
        raise ValueError('Experimental host installation requires x86_64 little-endian')
    if (root / 'proc/1/comm').read_text().strip() != 'systemd':
        raise ValueError('Requires systemd as PID 1')
    version = run('/usr/bin/systemctl', '--version')
    match = re.match(r'systemd (\d+)\b', version)
    if not match or int(match[1]) < 249:
        raise ValueError('Requires systemd >=249')
    node = run('/usr/bin/node', '--version').strip()
    if not re.fullmatch(r'v26\.(\d+)\.(\d+)', node) or tuple(map(int, node[4:].split('.'))) < (12, 1):
        raise ValueError('Requires Node 26.12.1 or newer in the 26.x release line')
    info = json.loads(run('/usr/bin/docker', '--host=unix:///var/run/docker.sock',
                          'info', '--format', '{{json .}}'))
    if (info.get('OSType') != 'linux' or info.get('ServerVersion') != '29.9.2'
            or info.get('LiveRestoreEnabled') is not False
            or any('rootless' in item for item in info.get('SecurityOptions', []))):
        raise ValueError('Requires validated rootful Docker 29.9.2 with live restore off')
    if not {'runsc-project', 'runsc-relay'} <= set(info.get('Runtimes', {})):
        raise ValueError('Requires reviewed runsc-project and runsc-relay runtimes')
    if platform.release() not in ACCEPTED_KERNEL_RELEASES:
        raise ValueError('Kernel has no accepted native installation profile; host installation is unavailable')
    for path in ('usr/sbin/nft', 'usr/sbin/bpftool', 'sbin/tc', 'sbin/ip',
                 'usr/bin/flock', 'usr/bin/nsenter', 'usr/bin/python3'):
        if not os.access(root / path, os.X_OK):
            raise ValueError('Missing executable: /' + path)
    grp.getgrnam('verity-egress-control')
    if not hasattr(os, 'setns') or not hasattr(ctypes.CDLL('libnftables.so.1'), 'nft_ctx_buffer_output'):
        raise ValueError('Requires Python setns and libnftables buffer API')
    mounts = (root / 'proc/mounts').read_text().splitlines()
    if not any(len(line.split()) >= 3 and line.split()[1:3] == ['/sys/fs/bpf', 'bpf'] for line in mounts):
        raise ValueError('Requires persistent bpffs mount at /sys/fs/bpf')
    pin = root / 'sys/fs/bpf/verity_egress_deadline'
    if not pin.is_dir() or pin.is_symlink() or pin.stat().st_uid != 0 or pin.stat().st_mode & 0o077:
        raise ValueError('Requires root-owned private persistent BPF pin directory')
    private_config(root, 'control.key')
    authority = private_config(root, 'authority.json')
    relay = private_config(root, 'relay.json')
    # Full authoritative schemas remain enforced by controller readiness.
    if not isinstance(json.loads(authority.read_text()), dict) or json.loads(relay.read_text()).get('packetEnforcement') is not True:
        raise ValueError('Requires configured direct authority and packet enforcement')


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_mkdir(path, mode=0o755):
    if path.exists():
        return
    durable_mkdir(path.parent)
    path.mkdir(mode=mode)
    sync_directory(path.parent)
    sync_directory(path)


def atomic_file(path, data, mode=0o644):
    durable_mkdir(path.parent)
    descriptor, name = tempfile.mkstemp(prefix=path.name + '.verity-', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def switch_link(path, target):
    temporary = path.with_name(path.name + '.verity-' + uuid.uuid4().hex)
    try:
        temporary.symlink_to(target)
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def trusted_parent(path, root):
    """Install destinations must never traverse writable or symlinked directories."""
    for item in (path.parent, *path.parent.parents):
        if item.exists() or item.is_symlink():
            info = item.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise ValueError('Untrusted installation directory: ' + str(item))
        if item == root:
            break


def stop_docker(run):
    # A live docker.socket can restart the daemon immediately after stop.
    socket = run('/usr/bin/systemctl', 'show', '--property=LoadState', '--value', 'docker.socket').strip()
    if socket not in ('loaded', 'not-found'):
        raise ValueError('Cannot establish Docker socket activation state')
    units = ('docker.service', 'docker.socket') if socket == 'loaded' else ('docker.service',)
    run('/usr/bin/systemctl', 'stop', *units)


def stop_controller(run):
    state = run('/usr/bin/systemctl', 'show', '--property=LoadState', '--value',
                'verity-egress-host.service').strip()
    if state == 'loaded':
        run('/usr/bin/systemctl', 'stop', 'verity-egress-host.service')
    elif state != 'not-found':
        raise ValueError('Cannot establish controller service state')


def prepare_release(release, files):
    """Publish complete immutable assets atomically while install.lock is held."""
    if release.exists() or release.is_symlink():
        info = release.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o222:
            raise ValueError('Installed release directory is not trusted and read-only')
        if {path.name for path in release.iterdir()} != set(ASSETS):
            raise ValueError('Installed release contains unexpected entries')
        for name, data in files.items():
            path = release / name
            info = path.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or info.st_mode & 0o222 or path.read_bytes() != data):
                raise ValueError('Installed release does not match trusted read-only staged content')
    else:
        durable_mkdir(release.parent)
        temporary = Path(tempfile.mkdtemp(prefix='.prepare-', dir=release.parent))
        try:
            for name, data in files.items():
                atomic_file(temporary / name, data, mode=0o444)
            temporary.chmod(0o555)
            sync_directory(temporary)
            os.rename(temporary, release)
            sync_directory(release.parent)
        finally:
            if temporary.exists():
                temporary.chmod(0o700)
                shutil.rmtree(temporary)


def install(source, root=Path('/'), run=command, check=preflight):
    files = release_files(source)
    check(root, run)
    current = root / 'opt/verity-egress'
    for path in (current, root / 'opt/verity-egress-releases/entry',
                 root / 'var/lib/verity-egress/install.lock',
                 *(root / relative for relative in UNITS.values())):
        trusted_parent(path, root)
    identity = digest(b''.join(name.encode() + files[name] for name in ASSETS))
    release = root / 'opt/verity-egress-releases' / identity
    state = root / 'var/lib/verity-egress'
    durable_mkdir(state, mode=0o700)
    with os.fdopen(os.open(state / 'install.lock', os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if current.exists() and not current.is_symlink():
            raise ValueError('Existing unmanaged /opt/verity-egress requires separate migration')
        prepare_release(release, files)
        old_target = os.readlink(current) if current.is_symlink() else None
        if old_target is not None:
            previous = Path(old_target)
            if previous.parent != root / 'opt/verity-egress-releases' or not re.fullmatch('[a-f0-9]{64}', previous.name):
                raise ValueError('Current release link is outside the managed release directory')
            trusted_parent(previous / 'entry', root)
            if previous.stat().st_mode & 0o222 or {path.name for path in previous.iterdir()} != set(ASSETS):
                raise ValueError('Previous release directory is not read-only or has unexpected entries')
            previous_files = {}
            for name in ASSETS:
                path = previous / name
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o222:
                    raise ValueError('Previous release asset is not trusted and read-only')
                previous_files[name] = path.read_bytes()
            if digest(b''.join(name.encode() + previous_files[name] for name in ASSETS)) != previous.name:
                raise ValueError('Previous release content no longer matches its identity')
        snapshots = {}
        for relative in UNITS.values():
            path = root / relative
            if path.exists() or path.is_symlink():
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
                    raise ValueError('Refusing untrusted unit destination')
            snapshots[relative] = path.read_bytes() if path.exists() else None
        # Fence before switching either bundle or boot integration. The same
        # controller lock excludes admitted commands and independent stop cleanup.
        deny = ('/usr/bin/flock', '--exclusive', '--timeout', '15',
                '/var/lib/verity-egress/service.lock', '/usr/bin/node',
                str(release / 'project-egress-host-main.mjs'), 'deny')
        try:
            # The live controller holds service.lock for its entire lifetime.
            # Stop Docker (and socket activation) before controller shutdown so
            # Upholds cannot resurrect it; stopped rootful containers cannot leak
            # while the independent new bundle establishes denial.
            stop_docker(run)
            stop_controller(run)
            run(*deny)
            switch_link(current, str(release))
            for name, relative in UNITS.items():
                atomic_file(root / relative, files[name])
            run('/usr/bin/systemctl', 'daemon-reload')
            run('/usr/bin/systemctl', 'start', 'verity-egress-bootstrap.service')
            run('/usr/bin/systemctl', 'start', 'docker.service')
            run('/usr/bin/systemctl', 'start', 'verity-egress-host.service')
            run('/usr/bin/systemctl', 'is-active', '--quiet', 'verity-egress-host.service')
        except Exception:
            # Restore reviewed files only after independently restoring denial.
            # Never restart the old controller automatically or open the fence.
            try:
                stop_docker(run)
                stop_controller(run)
            finally:
                run(*deny)
            for relative, data in snapshots.items():
                path = root / relative
                if data is None:
                    path.unlink(missing_ok=True)
                    sync_directory(path.parent)
                else:
                    atomic_file(path, data)
            if old_target is None:
                current.unlink(missing_ok=True)
                sync_directory(current.parent)
            else:
                switch_link(current, old_target)
            run('/usr/bin/systemctl', 'daemon-reload')
            raise
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    staging = commands.add_parser('stage')
    staging.add_argument('assets', type=Path)
    staging.add_argument('destination', type=Path)
    commands.add_parser('preflight')
    apply = commands.add_parser('apply')
    apply.add_argument('release', type=Path)
    apply.add_argument('--experimental-host-install', action='store_true', required=True)
    args = parser.parse_args()
    if args.action == 'stage':
        stage(args.assets, args.destination)
    elif args.action == 'preflight':
        preflight(Path('/'))
        print('Preflight passed; native lifecycle evidence and installation approval still required.')
    else:
        print('Installed release ' + install(args.release.resolve()))
        print('App setting unchanged. Verify host readiness and obtain activation approval separately.')


if __name__ == '__main__':
    main()
