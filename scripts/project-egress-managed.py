#!/usr/bin/env python3
"""Provision the managed host controller without restarting Docker or enabling projects."""
import argparse
import fcntl
import importlib.util
import grp
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import stat
import subprocess
import tempfile
from urllib.parse import urlsplit, urlunsplit

spec = importlib.util.spec_from_file_location(
    'egress_install', Path(__file__).with_name('project-egress-install.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
ASSETS = (*base.ASSETS, 'node', 'native-runtime-pins.env')
SERVICE = 'verity-egress-host.service'
INVENTORY_CONTRACT = 'etc/verity-egress-server/inventory-contract.json'
ASSESSMENT_CONFIG = 'etc/verity-egress/assessment.json'
ASSESSMENT_NOTICE = 'etc/verity-egress-server/assessment.json'


def ensure_control_group(gid, run):
    """Never project the control credential into an unrelated host group."""
    if any(user.pw_gid == gid and user.pw_uid != 0 for user in pwd.getpwall()):
        raise ValueError('Egress control gid has primary host members')
    try:
        existing = grp.getgrgid(gid)
    except KeyError:
        existing = None
    try:
        named = grp.getgrnam('verity-egress-control')
    except KeyError:
        named = None
    if existing is not None:
        if existing.gr_name != 'verity-egress-control' or existing.gr_mem:
            raise ValueError('Egress control gid belongs to an unrelated group or has host members')
        if named is None or named.gr_gid != gid:
            raise ValueError('Egress control group identity is inconsistent')
        return
    if named is not None:
        raise ValueError('Egress control group already uses a different gid')
    run('/usr/sbin/groupadd', '--system', '--gid', str(gid), 'verity-egress-control')
    created = grp.getgrnam('verity-egress-control')
    if created.gr_gid != gid or created.gr_mem:
        raise ValueError('Egress control group creation did not establish the expected identity')


def directory(path, root, mode, gid=0):
    base.trusted_parent(path / 'entry', root)
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise ValueError('Untrusted managed directory: ' + str(path))
    else:
        base.durable_mkdir(path, mode)
    os.chmod(path, mode)
    os.chown(path, os.geteuid(), gid)


def private_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError('Untrusted private managed file: ' + str(path))
    return path.read_bytes()


def shared_file(path, data, gid):
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o027:
            raise ValueError('Untrusted shared managed file: ' + str(path))
        if path.read_bytes() == data and info.st_gid == gid and stat.S_IMODE(info.st_mode) == 0o640:
            return
    base.atomic_file(path, data, 0o640)
    os.chown(path, os.geteuid(), gid)


def release_files(source):
    manifest = json.loads((source / 'manifest.json').read_text())
    if not isinstance(manifest, dict) or set(manifest) != set(ASSETS):
        raise ValueError('Managed release manifest has unexpected assets')
    files = {}
    for name in ASSETS:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Managed release asset must be a regular file')
        data = path.read_bytes()
        if manifest[name] != base.digest(data):
            raise ValueError('Managed release checksum mismatch: ' + name)
        files[name] = data
    return files


def prepare_release(release, files):
    if release.exists() or release.is_symlink():
        info = release.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o222:
            raise ValueError('Untrusted managed release directory')
        if {p.name for p in release.iterdir()} != set(ASSETS):
            raise ValueError('Managed release contains unexpected files')
        for name, data in files.items():
            info = (release / name).lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o222
                    or (release / name).read_bytes() != data):
                raise ValueError('Installed managed release was modified')
        return
    base.durable_mkdir(release.parent)
    temporary = Path(tempfile.mkdtemp(prefix='.prepare-', dir=release.parent))
    try:
        for name, data in files.items():
            base.atomic_file(temporary / name, data, 0o555 if name == 'node' else 0o444)
        temporary.chmod(0o555)
        base.sync_directory(temporary)
        os.rename(temporary, release)
        base.sync_directory(release.parent)
    finally:
        if temporary.exists():
            temporary.chmod(0o700)
            shutil.rmtree(temporary)


def reject_bridge_collisions(root, run):
    """A reserved name alone never authorizes fencing someone else's network."""
    bridges = {p.name for p in (root / 'sys/class/net').glob('vep*')}
    if not bridges:
        return
    registry = root / 'var/lib/verity-egress/registry.json'
    state = json.loads(private_file(registry)) if registry.exists() else {'records': []}
    owned = set()
    for record in state['records']:
        binding = record['binding']
        if not re.fullmatch(r'vep[a-f0-9]{12}', binding['bridge']):
            raise ValueError('Invalid managed bridge registry')
        if binding['bridge'] not in bridges:
            continue
        inspected = json.loads(run('/usr/bin/docker', 'network', 'inspect', binding['networkId']))
        if (len(inspected) != 1 or inspected[0]['Id'] != binding['networkId']
                or inspected[0]['Driver'] != 'bridge'
                or inspected[0]['Options'].get('com.docker.network.bridge.name') != binding['bridge']):
            raise ValueError('Managed bridge identity changed')
        owned.add(binding['bridge'])
    if bridges != owned:
        raise ValueError('Reserved egress bridge prefix collides with an unmanaged interface')


def write_status(root, gid, reason, available=False):
    value = {'version': 1, 'state': 'ready' if available else 'unavailable', 'reason': reason}
    data = (json.dumps(value, sort_keys=True) + '\n').encode()
    shared_file(root / 'run/verity-egress/status.json', data, gid)
    # Reboot starts unavailable; only a live authenticated health check proves readiness.
    boot = dict(value, state='unavailable', reason='controller_failed' if available else reason)
    shared_file(root / 'etc/verity-egress-server/status.json',
                (json.dumps(boot, sort_keys=True) + '\n').encode(), gid)
    return {'available': available, 'reason': reason, 'controlGid': gid}


def unit_files(files, gid):
    units = {}
    for name, relative in base.UNITS.items():
        content = files[name].decode().replace('/usr/bin/node ', '/opt/verity-egress/node ')
        content = content.replace('# Experimental fixture unit; not installed by verity-install.',
                                  '# Managed profile-gated unit.')
        content = content.replace('# Experimental Docker drop-in; not installed by verity-install.',
                                  '# Managed profile-gated Docker prerequisite.')
        content = content.replace('Group=verity-egress-control', 'Group=' + str(gid))
        # Restart=on-failure handles controller crashes; Upholds would race an
        # intentional controller-only upgrade while Docker remains running.
        content = content.replace('Upholds=verity-egress-host.service\n', '')
        if name == 'verity-egress-host.service':
            # Atomic endpoint refresh needs the parent writable under the
            # controller's ProtectSystem=strict filesystem namespace.
            content = content.replace('ReadWritePaths=',
                                      'ReadWritePaths=/etc/verity-egress ', 1)
            content = content.replace('ExecStartPre=',
                                      'ExecStartPre=/usr/bin/python3 /usr/local/libexec/verity/'
                                      'project-egress-managed.py verify-runtime\n'
                                      'ExecStartPre=/usr/bin/python3 /usr/local/libexec/verity/'
                                      'project-egress-managed.py refresh-authority\nExecStartPre=', 1)
        units[relative] = content.encode()
    return units


def refresh_authority(root=Path('/'), run=base.command):
    """Resolve only the sealed deployment's database; never accept a request URL."""
    locator_path = root / 'etc/verity-egress/database.json'
    if not locator_path.exists():
        return
    locator = json.loads(private_file(locator_path))
    if (set(locator) != {'version', 'network', 'service', 'database'}
            or locator['version'] != 1 or locator['service'] != 'postgres'
            or locator['database'] != 'verity'
            or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', locator['network'])):
        raise ValueError('Invalid sealed database locator')
    ids = run('/usr/bin/docker', 'ps', '--no-trunc', '--filter',
              'label=com.docker.compose.service=postgres', '--filter',
              'network=' + locator['network'], '--format', '{{.ID}}').split()
    if len(ids) != 1 or not re.fullmatch('[a-f0-9]{64}', ids[0]):
        raise ValueError('Database service identity is unavailable or ambiguous')
    inspected = json.loads(run('/usr/bin/docker', 'container', 'inspect', ids[0]))
    if (len(inspected) != 1 or inspected[0]['Id'] != ids[0]
            or inspected[0]['State']['Running'] is not True
            or inspected[0]['Config']['Labels'].get('com.docker.compose.service') != 'postgres'):
        raise ValueError('Database service identity changed')
    address = inspected[0]['NetworkSettings']['Networks'][locator['network']]['IPAddress']
    if not ipaddress.IPv4Address(address).is_private:
        raise ValueError('Database endpoint is not private')
    authority_path = root / 'etc/verity-egress/authority.json'
    authority = json.loads(private_file(authority_path))
    url = urlsplit(authority['databaseUrl'])
    if url.scheme not in ('postgres', 'postgresql') or url.path != '/verity' or '@' not in url.netloc:
        raise ValueError('Invalid managed database authority URL')
    credentials = url.netloc.rsplit('@', 1)[0]
    authority['databaseUrl'] = urlunsplit((url.scheme, credentials + '@' + address + ':5432',
                                         url.path, url.query, url.fragment))
    base.atomic_file(authority_path, (json.dumps(authority) + '\n').encode(), 0o600)


TRANSACTION_FILES = frozenset((*base.UNITS.values(),
    'usr/local/libexec/verity/project-egress-managed.py',
    'usr/local/libexec/verity/project-egress-install.py',
    'etc/verity-egress/relay.json', 'etc/verity-egress/authority.json',
    'etc/verity-egress/database.json', ASSESSMENT_CONFIG))
JOURNAL = 'var/lib/verity-egress/install-transaction.json'


def verified_release(root, target):
    release = Path(target)
    if release.parent != root / 'opt/verity-egress-releases' or not re.fullmatch('[a-f0-9]{64}', release.name):
        raise ValueError('Managed release link is untrusted')
    files = {}
    for name in ASSETS:
        path = release / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o222:
            raise ValueError('Managed release asset is untrusted')
        files[name] = path.read_bytes()
    prepare_release(release, files)
    if base.digest(b''.join(name.encode() + files[name] for name in ASSETS)) != release.name:
        raise ValueError('Managed release identity no longer matches its content')
    return release


def clear_transaction(root):
    (root / JOURNAL).unlink()
    base.sync_directory((root / JOURNAL).parent)


def recover_transaction(root, run):
    """Under install.lock, retain denial before restoring an interrupted replacement."""
    journal = root / JOURNAL
    if not journal.exists() and not journal.is_symlink():
        return False
    raw = private_file(journal)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError('Managed transaction journal is too large')
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {'version', 'previous', 'target', 'snapshots'}
            or value['version'] != 1 or not isinstance(value['snapshots'], dict)
            or not set(value['snapshots']) <= TRANSACTION_FILES
            or not (TRANSACTION_FILES - {'etc/verity-egress/database.json', ASSESSMENT_CONFIG}) <= set(value['snapshots'])):
        raise ValueError('Invalid managed transaction journal')
    release = verified_release(root, value['target'])
    previous = value['previous']
    if previous is not None:
        verified_release(root, previous)
    snapshots = {}
    for relative, data in value['snapshots'].items():
        if data is not None and (not isinstance(data, str) or not re.fullmatch('[a-f0-9]*', data)
                                 or len(data) % 2):
            raise ValueError('Invalid managed transaction snapshot')
        path = root / relative
        base.trusted_parent(path, root)
        if path.exists() or path.is_symlink():
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise ValueError('Untrusted managed recovery destination')
        snapshots[relative] = None if data is None else bytes.fromhex(data)
    current = root / 'opt/verity-egress'
    base.trusted_parent(current, root)
    if ((current.exists() or current.is_symlink()) and
            (not current.is_symlink() or os.readlink(current) not in (previous, str(release)))):
        raise ValueError('Managed recovery release identity changed')
    try:
        base.stop_controller(run)
    finally:
        # Even failed teardown must attempt denial. Either failure retains the
        # journal and prohibits restoration while a controller may still run.
        run('/usr/bin/flock', '--exclusive', '--timeout', '15',
            '/var/lib/verity-egress/service.lock', str(release / 'node'),
            str(release / 'project-egress-host-main.mjs'), 'deny')
    for relative, data in snapshots.items():
        path = root / relative
        if data is None:
            path.unlink(missing_ok=True)
            if path.parent.exists():
                base.sync_directory(path.parent)
        else:
            base.atomic_file(path, data, 0o600 if relative.startswith('etc/verity-egress/') else 0o644)
    if previous is None:
        current.unlink(missing_ok=True)
        base.sync_directory(current.parent)
    else:
        base.switch_link(current, previous)
    run('/usr/bin/systemctl', 'daemon-reload')
    # Leave the compatible controller stopped until fresh admission on a retry.
    clear_transaction(root)
    return True


RECOVERY_UNIT = 'etc/systemd/system/verity-egress-recovery.service'
RECOVERY_DROPIN = 'etc/systemd/system/verity-egress-bootstrap.service.d/recovery.conf'
RECOVERY_DOCKER_DROPIN = 'etc/systemd/system/docker.service.d/egress-recovery.conf'


def install_boot_recovery(root, run):
    """Install immutable recovery code before any journaled activation mutation."""
    files = {'project-egress-managed.py': Path(__file__).read_bytes(),
             'project-egress-install.py': Path(base.__file__).read_bytes()}
    identity = base.digest(b''.join(name.encode() + files[name] for name in sorted(files)))
    parent = root / 'opt/verity-egress-recovery'
    destination = parent / identity
    base.trusted_parent(destination / 'entry', root)
    if destination.exists() or destination.is_symlink():
        info = destination.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o222 or {p.name for p in destination.iterdir()} != set(files)):
            raise ValueError('Untrusted boot recovery release')
        for name, data in files.items():
            info = (destination / name).lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or info.st_mode & 0o222 or (destination / name).read_bytes() != data):
                raise ValueError('Modified boot recovery release')
    else:
        base.durable_mkdir(parent)
        temporary = Path(tempfile.mkdtemp(prefix='.prepare-', dir=parent))
        try:
            for name, data in files.items():
                base.atomic_file(temporary / name, data, 0o444)
            temporary.chmod(0o555)
            base.sync_directory(temporary)
            os.rename(temporary, destination)
            base.sync_directory(parent)
        finally:
            if temporary.exists():
                temporary.chmod(0o700)
                shutil.rmtree(temporary)
    # Systemd resolves every ReadWritePaths entry before executing recovery.
    # A fresh host must have the mutable helper destination before unit startup.
    directory(root / 'usr/local/libexec/verity', root, 0o755)
    # These persist outside rollback snapshots: a failed first installation
    # must retain its recovery dependency for the next boot.
    unit = f'''[Unit]
Description=Recover interrupted Verity project network installation
Before=verity-egress-bootstrap.service docker.service
After=local-fs.target systemd-tmpfiles-setup.service

[Service]
Type=oneshot
User=root
ExecStart=/usr/bin/python3 -B {destination}/project-egress-managed.py recover
RemainAfterExit=yes
TimeoutStartSec=120
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/verity-egress /etc/verity-egress /etc/verity-egress-server /run/verity-egress /etc/systemd/system /usr/local/libexec/verity /opt
RestrictAddressFamilies=AF_UNIX AF_NETLINK AF_INET AF_INET6
'''
    dropin = b'[Unit]\nRequires=verity-egress-recovery.service\nAfter=verity-egress-recovery.service\n'
    for relative, data in ((RECOVERY_UNIT, unit.encode()), (RECOVERY_DROPIN, dropin),
                           (RECOVERY_DOCKER_DROPIN, dropin)):
        path = root / relative
        base.trusted_parent(path, root)
        if path.exists() or path.is_symlink():
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise ValueError('Untrusted boot recovery unit')
        base.atomic_file(path, data, 0o644)
    run('/usr/bin/systemctl', 'daemon-reload')
    # Run clean before the journal exists; otherwise bootstrap would wait for
    # recovery to acquire the install lock held by this activation process.
    run('/usr/bin/systemctl', 'start', 'verity-egress-recovery.service')
    return destination


def recover_boot(root=Path('/'), run=base.command):
    """Recovery only: never stage assets or admit a runtime profile."""
    journal = root / JOURNAL
    if not journal.exists() and not journal.is_symlink():
        return False
    state = root / 'var/lib/verity-egress'
    base.trusted_parent(state / 'install.lock', root)
    lock_fd = os.open(state / 'install.lock', os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'a') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError('Untrusted managed installation lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        def boot_command(*args):
            if args == ('/usr/bin/systemctl', 'stop', SERVICE):
                active = run('/usr/bin/systemctl', 'show', '--property=ActiveState',
                             '--value', SERVICE).strip()
                if active in ('inactive', 'failed'):
                    # The controller may have a pending start behind this unit.
                    # Stopping an inactive unit would cancel that fresh admission.
                    return ''
                if active not in ('active', 'activating', 'deactivating', 'reloading'):
                    raise ValueError('Cannot establish boot controller state')
            return run(*args)
        result = recover_transaction(root, boot_command)
        # Boot recovery deliberately leaves the controller stopped. It does not
        # convert a previously persisted in-progress diagnostic into readiness.
        projection = root / 'etc/verity-egress-server/control.key'
        info = projection.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o027:
            raise ValueError('Untrusted server key projection')
        directory(root / 'run/verity-egress', root, 0o750, info.st_gid)
        write_status(root, info.st_gid, 'controller_failed')
        return result


def reconcile_stopped_relay_policy(root, run, target):
    """The stopped controller can no longer append an old-image relay after this read."""
    registry = root / 'var/lib/verity-egress/registry.json'
    state = json.loads(private_file(registry)) if registry.exists() else {'version': 1, 'records': []}
    if (not isinstance(state, dict) or state.get('version') != 1
            or not isinstance(state.get('records'), list) or len(state['records']) > 10000):
        raise ValueError('Invalid stopped relay registry')
    active = set()
    for record in state['records']:
        if not isinstance(record, dict):
            raise ValueError('Invalid stopped relay record')
        if record.get('retired') is True:
            continue
        containers = record.get('containers')
        if not isinstance(containers, dict):
            raise ValueError('Invalid stopped relay containers')
        relay = containers.get('relay')
        if relay is None:
            continue
        if not isinstance(relay, str) or not re.fullmatch('[a-f0-9]{64}', relay):
            raise ValueError('Invalid stopped relay identity')
        inspected = json.loads(run('/usr/bin/docker', '--host=unix:///var/run/docker.sock',
                                   'container', 'inspect', relay))
        if (not isinstance(inspected, list) or len(inspected) != 1
                or inspected[0].get('Id') != relay):
            raise ValueError('Stopped relay inspection mismatch')
        image = inspected[0].get('Config', {}).get('Image')
        if not isinstance(image, str):
            raise ValueError('Stopped relay image missing')
        active.add(image)
    new = json.loads(target)
    old_path = root / 'etc/verity-egress/relay.json'
    old = json.loads(private_file(old_path)) if old_path.exists() else None
    # Empty generations may safely prune stale retention only while starts are stopped.
    new.pop('previousImage', None)
    if active:
        if not isinstance(old, dict):
            raise ValueError('Protected relay has no installed release authority')
        allowed = {old.get('image'), old.get('previousImage'), new.get('image')}
        if any(image not in allowed for image in active):
            raise ValueError('Protected relay is outside installed release authority')
        old_contract = {k: v for k, v in old.items() if k not in ('image', 'previousImage')}
        new_contract = {k: v for k, v in new.items() if k not in ('image', 'previousImage')}
        if old_contract != new_contract:
            raise ValueError('Protected relay execution contract cannot change during cutover')
        retained = active - {new.get('image')}
        if len(retained) > 1:
            raise ValueError('Update requires more than one retained protected relay image')
        if retained:
            new['previousImage'] = retained.pop()
    return (json.dumps(new, sort_keys=True) + '\n').encode()


def activate(root, run, release, files, configs, gid):
    current = root / 'opt/verity-egress'
    if current.exists() and not current.is_symlink():
        raise ValueError('Unmanaged egress installation requires migration')
    old_target = os.readlink(current) if current.is_symlink() else None
    if old_target is not None:
        verified_release(root, old_target)
    helpers = {'usr/local/libexec/verity/project-egress-managed.py': Path(__file__).read_bytes(),
               'usr/local/libexec/verity/project-egress-install.py': Path(base.__file__).read_bytes()}
    changes = {**unit_files(files, gid), **helpers, **configs}
    snapshots = {}
    for relative in changes:
        path = root / relative
        base.trusted_parent(path, root)
        if path.exists() or path.is_symlink():
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise ValueError('Untrusted managed destination')
        snapshots[relative] = path.read_bytes() if path.exists() else None
    docker_dropin = root / base.UNITS['docker-egress.conf']
    if docker_dropin.exists() and b'Upholds=' in docker_dropin.read_bytes():
        raise ValueError('Experimental Upholds installation requires separate migration')
    deny = ('/usr/bin/flock', '--exclusive', '--timeout', '15',
            '/var/lib/verity-egress/service.lock', str(release / 'node'),
            str(release / 'project-egress-host-main.mjs'), 'deny')
    journal = root / JOURNAL
    if journal.exists() or journal.is_symlink():
        raise ValueError('Managed transaction requires recovery')
    install_boot_recovery(root, run)
    transaction = {'version': 1, 'previous': old_target, 'target': str(release),
                   'snapshots': {name: None if data is None else data.hex()
                                 for name, data in snapshots.items()}}
    data = (json.dumps(transaction, sort_keys=True) + '\n').encode()
    if len(data) > 4 * 1024 * 1024:
        raise ValueError('Managed transaction journal is too large')
    # The old authority is durable before any service, link, unit or config mutation.
    base.atomic_file(journal, data, 0o600)
    try:
        base.stop_controller(run)
        run(*deny)
        relay_path = 'etc/verity-egress/relay.json'
        if relay_path in configs:
            changes[relay_path] = reconcile_stopped_relay_policy(root, run, configs[relay_path])
        base.switch_link(current, str(release))
        for relative, data in changes.items():
            base.atomic_file(root / relative, data, 0o600 if relative in configs else 0o644)
        run('/usr/bin/systemctl', 'daemon-reload')
        # Starting the bootstrap does not restart an already-running Docker daemon.
        run('/usr/bin/systemctl', 'start', 'verity-egress-bootstrap.service')
        run('/usr/bin/systemctl', 'start', SERVICE)
        run('/usr/bin/systemctl', 'is-active', '--quiet', SERVICE)
    except Exception:
        recover_transaction(root, run)
        raise
    clear_transaction(root)


def provision(source, relay=None, authority=None, gid=65531, root=Path('/'), run=base.command,
              check=base.runtime_preflight, database=None, prepare_only=False,
              group_setup=None, assessment_authorization=None):
    if (root == Path('/') and os.geteuid() != 0) or not 1 <= gid <= 2147483647:
        raise ValueError('Managed provisioning requires root and a positive control gid')
    files = release_files(source)
    configs = {}
    if relay is not None and authority is not None:
        relay_value = json.loads(relay.read_bytes())
        authority_value = json.loads(authority.read_bytes())
        if (not isinstance(relay_value, dict) or relay_value.get('packetEnforcement') is not True
                or not isinstance(authority_value, dict)):
            raise ValueError('Managed configuration requires packet enforcement and direct authority')
        configs = {'etc/verity-egress/relay.json': (json.dumps(relay_value) + '\n').encode(),
                   'etc/verity-egress/authority.json': (json.dumps(authority_value) + '\n').encode()}
    elif not prepare_only:
        raise ValueError('Managed activation requires both relay and authority configuration')
    if database is not None:
        configs['etc/verity-egress/database.json'] = (json.dumps(json.loads(database.read_bytes())) + '\n').encode()
    (group_setup or ensure_control_group)(gid, run)
    for relative, mode, group in [('var/lib/verity-egress', 0o700, 0),
                                  ('etc/verity-egress', 0o700, 0),
                                  ('etc/verity-egress-server', 0o750, gid),
                                  ('run/verity-egress', 0o750, gid)]:
        directory(root / relative, root, mode, group)
    state = root / 'var/lib/verity-egress'
    lock_fd = os.open(state / 'install.lock', os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'a') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError('Untrusted managed installation lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        key_path = root / 'etc/verity-egress/control.key'
        if not key_path.exists() and not key_path.is_symlink():
            base.atomic_file(key_path, (secrets.token_hex(32) + '\n').encode(), 0o600)
        key = private_file(key_path)
        if not re.fullmatch(rb'[a-f0-9]{64}\n', key):
            raise ValueError('Invalid persistent egress control key')
        shared_file(root / 'etc/verity-egress-server/control.key', key, gid)
        identity = base.digest(b''.join(name.encode() + files[name] for name in ASSETS))
        release = root / 'opt/verity-egress-releases' / identity
        base.trusted_parent(release / 'entry', root)
        prepare_release(release, files)
        # Recovery precedes preflight, including retries on a now-unsupported host.
        write_status(root, gid, 'provisioning_in_progress')
        try:
            recover_transaction(root, run)
        except Exception as error:
            write_status(root, gid, 'controller_failed')
            error.egress_failure = base.failure_diagnostic(error, 'recovery_failed', 'recovery')
            raise
        # tmpfiles recreates the bind-mounted runtime path at boot, even while the
        # native profile remains unsupported and the controller stays disabled.
        tmpfiles = root / 'etc/tmpfiles.d/verity-egress.conf'
        base.trusted_parent(tmpfiles, root)
        base.atomic_file(tmpfiles, (f'd /run/verity-egress 0750 0 {gid} -\n'
                                  f'C /run/verity-egress/status.json 0640 0 {gid} - /etc/verity-egress-server/status.json\n').encode())
        if prepare_only:
            if not (root / 'opt/verity-egress').is_symlink():
                for relative, data in configs.items():
                    base.atomic_file(root / relative, data, 0o600)
            return write_status(root, gid, 'runtime_unsupported')
        assessment = None
        step = 'prerequisites'
        try:
            if assessment_authorization is not None:
                authorization = json.loads(private_file(assessment_authorization))
                assessment = base.prepare_staging_assessment(root, run, str(release / 'node'), authorization)
                step = 'runtime_preflight'
                base.runtime_preflight(root, run, str(release / 'node'), assessment=assessment)
                configs[ASSESSMENT_CONFIG] = (json.dumps(assessment, sort_keys=True) + '\n').encode()
            elif check is base.runtime_preflight:
                base.prepare_managed_prerequisites(root, run, str(release / 'node'))
            if assessment is None:
                step = 'runtime_preflight'
                check(root, run, str(release / 'node'))
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            # Preserve running release/config/units on incompatible upgrades.
            if not (root / 'opt/verity-egress').is_symlink():
                for relative, data in configs.items():
                    base.atomic_file(root / relative, data, 0o600)
            fallback = ('native_prerequisites_failed' if step == 'prerequisites' else 'runtime_preflight_failed')
            diagnostic = base.failure_diagnostic(error, fallback, step)
            # Keep the health/status vocabulary compatible; detailed codes belong
            # to this invocation's outcome, not the public readiness contract.
            reason = (diagnostic['reason'] if diagnostic['reason'] in {
                'assessment_authorization_invalid', 'docker_host_unsupported',
                'native_package_unavailable', 'relay_runtime_missing'} else
                'provisioning_failed' if assessment_authorization is not None else 'runtime_unsupported')
            result = write_status(root, gid, reason)
            # An unsupported production profile remains a normal unavailable result.
            if reason != 'runtime_unsupported' or isinstance(error, base.PreflightError):
                result.update(diagnostic)
            return result
        try:
            reject_bridge_collisions(root, run)
            # Persist before the first controller can synchronize/open admission.
            # Never roll this contract back: protected generations may survive.
            shared_file(root / INVENTORY_CONTRACT, b'{"version":1,"required":true}\n', gid)
            if assessment is not None:
                shared_file(root / ASSESSMENT_NOTICE,
                            b'{"scope":"staging-assessment","productionAccepted":false}\n', gid)
            activate(root, run, release, files, configs, gid)
        except Exception as error:
            write_status(root, gid, 'controller_failed')
            error.egress_failure = base.failure_diagnostic(error, 'activation_failed', 'activation')
            raise
        if assessment is None:
            for relative in (ASSESSMENT_CONFIG, ASSESSMENT_NOTICE):
                path = root / relative
                if path.exists() or path.is_symlink():
                    private_file(path) if relative == ASSESSMENT_CONFIG else None
                    path.unlink()
                    base.sync_directory(path.parent)
        return write_status(root, gid, 'ready', True)


def verify_runtime(root=Path('/'), run=base.command):
    # Production evidence always wins; a candidate never upgrades that evidence.
    try:
        base.runtime_preflight(root, run, str(root / 'opt/verity-egress/node'))
        return
    except ValueError:
        path = root / ASSESSMENT_CONFIG
        if not path.exists() and not path.is_symlink():
            raise
    descriptor = json.loads(private_file(path))
    base.runtime_preflight(root, run, str(root / 'opt/verity-egress/node'), assessment=descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    managed = actions.add_parser('provision')
    managed.add_argument('release', type=Path)
    managed.add_argument('--relay-config', type=Path)
    managed.add_argument('--authority-config', type=Path)
    managed.add_argument('--control-gid', type=int, default=65531)
    managed.add_argument('--database-config', type=Path)
    managed.add_argument('--prepare-only', action='store_true')
    managed.add_argument('--assessment-authorization', type=Path)
    actions.add_parser('refresh-authority')
    actions.add_parser('recover')
    actions.add_parser('verify-runtime')
    args = parser.parse_args()
    try:
        if args.action == 'verify-runtime':
            verify_runtime()
            return
        if args.action == 'recover':
            recover_boot()
            return
        if args.action == 'refresh-authority':
            refresh_authority()
            return
        result = provision(args.release.resolve(), args.relay_config, args.authority_config,
                           args.control_gid, database=args.database_config,
                           prepare_only=args.prepare_only,
                           assessment_authorization=args.assessment_authorization)
    except Exception as error:
        # Command output is consumed by diagnostics; do not print config paths,
        # database URLs, raw subprocess errors or secret material.
        reason, step = {'verify-runtime': ('runtime_preflight_failed', 'runtime_preflight'),
                        'recover': ('recovery_failed', 'recovery')}.get(
                            args.action, ('provisioning_failed', 'validation'))
        print(json.dumps({'available': False, **base.failure_diagnostic(error, reason, step),
                          'controlGid': getattr(args, 'control_gid', 1000)}))
        raise SystemExit(1)
    print(json.dumps(result))
    if args.assessment_authorization is not None and not result['available']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
