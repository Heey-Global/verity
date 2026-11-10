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
import time
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
# Each entry binds the platform, release artifacts, distro packages and reviewed
# runtime binary/arguments. Add only entries backed by retained native managed
# install/update/reboot/rollback and independent packet evidence.
ACCEPTED_NATIVE_PROFILES = ()
# Assessment candidates are not production acceptance. The descriptor binds the
# exact observed version and rejects subsequent drift before controller startup.
STAGING_DOCKER_VERSIONS = frozenset(('29.8.0', '29.9.2', '29.9.3'))
# Docker releases the production preflight admits. A matching accepted native
# profile is still required; this set alone accepts no host.
PRODUCTION_DOCKER_VERSIONS = frozenset(('29.9.2', '29.9.3'))


class PreflightError(ValueError):
    def __init__(self, reason, step=None):
        super().__init__(reason)
        self.reason = reason
        self.step = step


# These values may cross the host journal and updater boundary; never use raw errors.
PROVISION_FAILURE_REASONS = frozenset((
    'assessment_authorization_invalid', 'docker_host_unsupported',
    'native_package_unavailable', 'relay_runtime_missing',
    'relay_reload_failed', 'relay_inspection_failed', 'relay_runtime_mismatch',
    'relay_rollback_failed', 'native_identity_changed', 'native_packages_changed',
    'native_prerequisites_failed', 'runtime_preflight_failed', 'activation_failed',
    'recovery_failed', 'provisioning_failed',
))
PROVISION_STEPS = frozenset(('validation', 'recovery', 'prerequisites', 'runtime_preflight', 'activation'))


def failure_diagnostic(error, reason='provisioning_failed', step='validation'):
    diagnostic = getattr(error, 'egress_failure', {})
    if isinstance(diagnostic, dict):
        if isinstance(diagnostic.get('reason'), str) and diagnostic['reason'] in PROVISION_FAILURE_REASONS:
            reason = diagnostic['reason']
        if isinstance(diagnostic.get('step'), str) and diagnostic['step'] in PROVISION_STEPS:
            step = diagnostic['step']
    if isinstance(error, PreflightError):
        reason = error.reason if isinstance(error.reason, str) and error.reason in PROVISION_FAILURE_REASONS else reason
        step = error.step if isinstance(error.step, str) and error.step in PROVISION_STEPS else step
    return {'reason': reason, 'step': step}


RELAY_RUNTIME_ARGS = ['--platform=systrap', '--network=sandbox', '--host-uds=open']
RELAY_RUNTIME_AUTHORITY = 'etc/verity-egress/relay-runtime.json'
PROJECT_RUNTIME_ARGS = ['--platform=systrap', '--network=sandbox', '--host-uds=create']
NATIVE_PACKAGES = frozenset(('python3', 'iproute2', 'nftables', 'bpftool', 'libnftables1',
                             'util-linux', 'libatomic1', 'libstdc++6'))
# Retained only to identify and remove the obsolete Verity-owned mount unit.
LEGACY_BPFFS_UNIT = b"""[Unit]
Description=Persistent BPF filesystem for managed network protection
Before=verity-egress-bootstrap.service docker.service
[Mount]
What=bpf
Where=/sys/fs/bpf
Type=bpf
Options=nosuid,nodev,noexec,mode=0700
[Install]
WantedBy=multi-user.target
"""


def os_identity(root):
    values = {}
    for line in (root / 'etc/os-release').read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            values[key] = value.strip('"')
    return {'id': values.get('ID'), 'version': values.get('VERSION_ID')}


def runtime_tree_digest(directory):
    entries = []
    for path in sorted(directory.rglob('*')):
        metadata = path.lstat()
        if path.is_symlink() or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
            raise ValueError('Untrusted native runtime tree')
        if stat.S_ISREG(metadata.st_mode):
            entries.append(str(path.relative_to(directory)) + '\0' + digest(path.read_bytes()))
        elif not stat.S_ISDIR(metadata.st_mode):
            raise ValueError('Unexpected native runtime tree entry')
    return digest('\n'.join(entries).encode())


def accepted_native_profile(root, run, node_path):
    """Select release-owned evidence, never a host/project supplied acceptance flag."""
    if not ACCEPTED_NATIVE_PROFILES:
        raise ValueError('Host has no accepted native installation profile')
    info = json.loads(run('/usr/bin/docker', '--host=unix:///var/run/docker.sock',
                          'info', '--format', '{{json .}}'))
    if (info.get('OSType') != 'linux' or info.get('LiveRestoreEnabled') is not False
            or any('rootless' in option for option in info.get('SecurityOptions', []))):
        raise ValueError('Native profile requires rootful Linux Docker with live restore off')
    platform_identity = {'kernel': platform.release(), 'architecture': platform.machine(),
                         'os': os_identity(root), 'docker': info.get('ServerVersion')}
    artifacts = {}
    # The managed current-release link is intentional; attest the immutable
    # resolved release and every canonical ancestor before hashing its assets.
    node = Path(node_path).resolve(strict=True)
    for name, path in [('node', node), *[(name, node.parent / name) for name in
            ('project-egress-host-main.mjs', 'project-egress-deadline.bpf.o', 'project-egress-renew.bpf.o')]]:
        trusted_parent(path, root)
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o222:
            raise ValueError('Untrusted managed native artifact')
        artifacts[name] = digest(path.read_bytes())
    matches = [profile for profile in ACCEPTED_NATIVE_PROFILES
               if profile.get('platform') == platform_identity and profile.get('artifacts') == artifacts]
    if len(matches) != 1:
        raise ValueError('Host has no unique accepted native installation profile')
    profile = matches[0]
    packages = profile.get('packages')
    runtime = profile.get('runtime')
    if (set(profile) != {'platform', 'artifacts', 'packages', 'runtime', 'evidence'}
            or not isinstance(profile['evidence'], str) or not re.fullmatch('[a-f0-9]{64}', profile['evidence'])
            or platform_identity['os']['id'] != 'ubuntu'
            or not isinstance(packages, dict) or set(packages) != NATIVE_PACKAGES
            or any(not isinstance(v, str) or not re.fullmatch(r'[A-Za-z0-9.+:~_-]{1,128}', v)
                   for v in packages.values())
            or not isinstance(runtime, dict) or set(runtime) != {'path', 'sha512', 'treeSha256'}
            or not re.fullmatch(r'/opt/verity/runsc/release-[0-9]{8}\.[0-9]+/runsc', runtime['path'])
            or not re.fullmatch('[a-f0-9]{128}', runtime['sha512'])
            or not re.fullmatch('[a-f0-9]{64}', runtime['treeSha256'])):
        raise ValueError('Invalid release-owned native profile')
    runtime_path = root / runtime['path'].lstrip('/')
    trusted_parent(runtime_path, root)
    metadata = runtime_path.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022
            or hashlib.sha512(runtime_path.read_bytes()).hexdigest() != runtime['sha512']
            or runtime_tree_digest(runtime_path.parent) != runtime['treeSha256']):
        raise ValueError('Native runtime does not match accepted profile')
    actual = info.get('Runtimes', {}).get('runsc-project', {})
    project = {'path': actual.get('path'), 'runtimeArgs': actual.get('runtimeArgs', [])}
    if project != {'path': runtime['path'], 'runtimeArgs': PROJECT_RUNTIME_ARGS}:
        raise ValueError('Project runtime does not match accepted native profile')
    return profile



def staging_authorization(root, authorization):
    """A fixed updater contract, not a project preference or process environment."""
    fields = {'scope', 'productionAccepted', 'deploymentId', 'targetDigest',
              'installedDigest', 'operationId', 'channelPath', 'channelOwnerUid'}
    official = r'ghcr\.io/heey-global/verity/verity-server@sha256:[a-f0-9]{64}'
    if (not isinstance(authorization, dict) or set(authorization) != fields
            or authorization['scope'] != 'staging-assessment'
            or authorization['productionAccepted'] is not False
            or not isinstance(authorization['deploymentId'], str)
            or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', authorization['deploymentId'])
            or any(not isinstance(authorization[name], str) or not re.fullmatch(official, authorization[name])
                   for name in ('installedDigest', 'targetDigest'))
            or not isinstance(authorization['operationId'], str)
            or not re.fullmatch('[a-f0-9]{24,64}', authorization['operationId'])
            or type(authorization['channelOwnerUid']) is not int
            or not 0 <= authorization['channelOwnerUid'] <= 2147483647):
        raise PreflightError('assessment_authorization_invalid')
    value = authorization['channelPath']
    if (not isinstance(value, str) or not value.startswith('/')
            or '..' in value.split('/') or str(Path(value)) != value
            or Path(value).name != 'update-channel.json'):
        raise ValueError('Invalid staging assessment channel path')
    channel = root / value.lstrip('/')
    allowed = {os.geteuid(), authorization['channelOwnerUid']}
    for path in (channel, *channel.parents):
        metadata = path.lstat()
        if (path.is_symlink() or metadata.st_uid not in allowed or metadata.st_mode & 0o022
                or (path != channel and not stat.S_ISDIR(metadata.st_mode))):
            raise ValueError('Untrusted staging assessment channel')
        if path == root:
            break
    descriptor = os.open(channel, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor) as source:
        metadata = os.fstat(source.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1024
                or metadata.st_uid not in allowed or metadata.st_mode & 0o022
                or json.load(source) != 'staging'):
            raise ValueError('Staging assessment requires the durable staging channel')
    return dict(authorization)


def staging_identity(root, run, node_path):
    """Bind a first assessment to real host identities, without claiming evidence."""
    if (platform.machine() != 'x86_64' or sys.byteorder != 'little'
            or (root / 'proc/1/comm').read_text().strip() != 'systemd'
            or os_identity(root) not in ({'id': 'ubuntu', 'version': '24.04'},
                                        {'id': 'ubuntu', 'version': '26.04'})):
        raise ValueError('Staging assessment requires supported native Ubuntu x86_64')
    info = json.loads(run('/usr/bin/docker', '--host=unix:///var/run/docker.sock',
                          'info', '--format', '{{json .}}'))
    if (info.get('OSType') != 'linux' or info.get('ServerVersion') not in STAGING_DOCKER_VERSIONS
            or info.get('LiveRestoreEnabled') is not False
            or any('rootless' in item for item in info.get('SecurityOptions', []))):
        raise PreflightError('docker_host_unsupported')
    node = Path(node_path).resolve(strict=True)
    artifacts = {}
    for name in ('node', 'project-egress-host-main.mjs', 'project-egress-deadline.bpf.o',
                 'project-egress-renew.bpf.o', 'native-runtime-pins.env'):
        path = node.parent / name
        trusted_parent(path, root)
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o222:
            raise ValueError('Untrusted staging assessment artifact')
        artifacts[name] = digest(path.read_bytes())
    pins = {}
    for line in (node.parent / 'native-runtime-pins.env').read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            if key in pins:
                raise ValueError('Duplicate native runtime pin')
            pins[key] = value.strip("'\"")
    release, checksum, archive_checksum = [pins.get(name, '') for name in
        ('RUNSC_RELEASE', 'RUNSC_SHA512_X86_64', 'RUNSC_ARCHIVE_SHA512_X86_64')]
    if (not re.fullmatch(r'release-[0-9]{8}\.[0-9]+', release)
            or not all(re.fullmatch('[a-f0-9]{128}', value) for value in (checksum, archive_checksum))):
        raise ValueError('Invalid release-owned assessment runtime pins')
    runtime_path = '/opt/verity/runsc/' + release + '/runsc'
    runtime = root / runtime_path.lstrip('/')
    trusted_parent(runtime, root)
    tree_digest = runtime_tree_digest(runtime.parent)
    if (not os.access(runtime, os.X_OK)
            or hashlib.sha512(runtime.read_bytes()).hexdigest() != checksum
            or (runtime.parent / '.verity-archive-sha512').read_text().strip() != archive_checksum):
        raise ValueError('Staging runtime differs from release-owned pins')
    recorded = set()
    for line in (runtime.parent / '.verity-files.sha512').read_text().splitlines():
        match = re.fullmatch(r'([a-f0-9]{128})  (runsc|gvisor-bin/[A-Za-z0-9_][A-Za-z0-9_.-]*)', line)
        if not match or match[2] in recorded:
            raise ValueError('Invalid native runtime file manifest')
        recorded.add(match[2])
        if hashlib.sha512((runtime.parent / match[2]).read_bytes()).hexdigest() != match[1]:
            raise ValueError('Staging native runtime file changed')
    actual_files = {str(path.relative_to(runtime.parent)) for path in runtime.parent.rglob('*')
                    if path.is_file() and path.name not in ('.verity-files.sha512', '.verity-archive-sha512')}
    if recorded != actual_files or not {'runsc', 'gvisor-bin/gvisor_sentry'} <= recorded:
        raise ValueError('Incomplete native runtime file manifest')
    project = info.get('Runtimes', {}).get('runsc-project', {})
    if {'path': project.get('path'), 'runtimeArgs': project.get('runtimeArgs', [])} != {
            'path': runtime_path, 'runtimeArgs': PROJECT_RUNTIME_ARGS}:
        raise ValueError('Staging project runtime registration changed')
    return {'platform': {'kernel': platform.release(), 'architecture': platform.machine(),
                         'os': os_identity(root), 'docker': info['ServerVersion']},
            'artifacts': artifacts, 'runtime': {'path': runtime_path, 'sha512': checksum,
                                              'treeSha256': tree_digest}}


def installed_assessment_packages(run):
    try:
        output = run('/usr/bin/dpkg-query', '--show', '--showformat=${Package}=${Version}\n',
                     *sorted(NATIVE_PACKAGES))
    except subprocess.CalledProcessError as error:
        # dpkg-query reports installed packages even when one requested package is absent.
        output = error.stdout or ''
    values = {}
    for line in output.splitlines():
        name, separator, value = line.partition('=')
        if (not separator or name not in NATIVE_PACKAGES or name in values
                or not re.fullmatch(r'[A-Za-z0-9.+:~_-]{1,128}', value)):
            raise ValueError('Invalid installed native package identity')
        values[name] = value
    return values


def prepare_staging_assessment(root, run, node_path, authorization):
    authorization = staging_authorization(root, authorization)
    profile = staging_identity(root, run, node_path)
    native_relay_configuration(root, profile)
    versions = installed_assessment_packages(run)
    missing = NATIVE_PACKAGES - versions.keys()
    if missing:
        # apt authenticates its configured signed distro metadata. Snapshot versions
        # before installation, then install only explicit allowlisted name=version.
        run('/usr/bin/apt-get', 'update')
        for name in sorted(missing):
            policy = run('/usr/bin/apt-cache', 'policy', name)
            candidates = re.findall(r'^\s*Candidate:\s*([A-Za-z0-9.+:~_-]{1,128})\s*$', policy, re.MULTILINE)
            if len(candidates) != 1 or candidates[0] == '(none)':
                raise PreflightError('native_package_unavailable')
            versions[name] = candidates[0]
    profile['packages'] = versions
    prepare_native_profile(root, run, profile)
    descriptor = {'scope': 'staging-assessment', 'productionAccepted': False,
                  'authorization': authorization, 'profile': profile}
    validate_staging_assessment(root, run, node_path, descriptor)
    return descriptor


def validate_staging_assessment(root, run, node_path, descriptor):
    if (not isinstance(descriptor, dict) or set(descriptor) != {
            'scope', 'productionAccepted', 'authorization', 'profile'}
            or descriptor['scope'] != 'staging-assessment' or descriptor['productionAccepted'] is not False):
        raise ValueError('Invalid staging assessment descriptor')
    staging_authorization(root, descriptor['authorization'])
    actual = staging_identity(root, run, node_path)
    profile = descriptor['profile']
    if (not isinstance(profile, dict) or set(profile) != {*actual, 'packages'}
            or any(actual[key] != profile[key] for key in actual)):
        raise PreflightError('native_identity_changed', 'runtime_preflight')
    if (not isinstance(profile['packages'], dict) or set(profile['packages']) != NATIVE_PACKAGES
            or installed_assessment_packages(run) != profile['packages']):
        raise PreflightError('native_packages_changed', 'runtime_preflight')
    return profile


def trusted_native_file(path, root):
    trusted_parent(path, root)
    if path.exists() or path.is_symlink():
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
            raise ValueError('Untrusted managed prerequisite destination')


def prepare_managed_prerequisites(root, run, node_path='/opt/verity-egress/node'):
    """Prepare only the exact accepted platform; never restart Docker or select latest packages."""
    if (root / 'proc/1/comm').read_text().strip() != 'systemd':
        raise ValueError('Managed prerequisites require native systemd')
    profile = accepted_native_profile(root, run, node_path)
    return prepare_native_profile(root, run, profile)


def managed_relay_registration(root, registration):
    """Only an earlier admitted preparation can authorize replacing a runtime."""
    authority = root / RELAY_RUNTIME_AUTHORITY
    trusted_native_file(authority, root)
    if not authority.exists():
        return False
    metadata = authority.lstat()
    if metadata.st_mode & 0o077 or metadata.st_size > 4096:
        raise ValueError('Untrusted managed relay runtime authority')
    value = json.loads(authority.read_bytes())
    identity = value.get('runtime') if isinstance(value, dict) else None
    if (not isinstance(value, dict) or set(value) != {'version', 'runtime'}
            or type(value['version']) is not int or value['version'] != 1 or not isinstance(identity, dict)
            or set(identity) != {'path', 'sha512', 'treeSha256'}
            or not isinstance(identity['path'], str)
            or not re.fullmatch(r'/opt/verity/runsc/release-[0-9]{8}\.[0-9]+/runsc', identity['path'])
            or not isinstance(identity['sha512'], str) or not re.fullmatch('[a-f0-9]{128}', identity['sha512'])
            or not isinstance(identity['treeSha256'], str) or not re.fullmatch('[a-f0-9]{64}', identity['treeSha256'])):
        raise ValueError('Invalid managed relay runtime authority')
    if registration != {'path': identity['path'], 'runtimeArgs': RELAY_RUNTIME_ARGS}:
        return False
    previous = root / identity['path'].lstrip('/')
    trusted_parent(previous, root)
    metadata = previous.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid()
            or metadata.st_mode & 0o022
            or hashlib.sha512(previous.read_bytes()).hexdigest() != identity['sha512']
            or runtime_tree_digest(previous.parent) != identity['treeSha256']):
        raise ValueError('Managed relay runtime identity changed')
    return True


def native_relay_configuration(root, profile):
    """Validate runtime ownership before any prerequisite or daemon writes."""
    daemon = root / 'etc/docker/daemon.json'
    trusted_native_file(daemon, root)
    original = daemon.read_bytes()
    config = json.loads(original)
    runtime = {'path': profile['runtime']['path'], 'runtimeArgs': RELAY_RUNTIME_ARGS}
    runtimes = config.setdefault('runtimes', {})
    if ('runsc-relay' in runtimes and runtimes['runsc-relay'] != runtime
            and not managed_relay_registration(root, runtimes['runsc-relay'])):
        raise ValueError('Unmanaged relay runtime registration collision')
    trusted_native_file(root / RELAY_RUNTIME_AUTHORITY, root)
    return daemon, original, config, runtime, runtimes


def relay_identity(info):
    runtime = info.get('Runtimes', {}).get('runsc-relay')
    if runtime is None:
        return None
    return {'path': runtime.get('path'), 'runtimeArgs': runtime.get('runtimeArgs', [])}


def await_relay_runtime(run, expected):
    # Docker's ExecReload only sends SIGHUP; a successful command is not convergence.
    deadline = time.monotonic() + 30
    reason = 'relay_runtime_mismatch'
    while True:
        try:
            info = json.loads(run('/usr/bin/docker', 'info', '--format', '{{json .}}'))
            if relay_identity(info) == expected:
                return
            reason = 'relay_runtime_mismatch'
        except (ValueError, OSError, subprocess.SubprocessError, AttributeError, TypeError):
            reason = 'relay_inspection_failed'
        if time.monotonic() >= deadline:
            raise PreflightError(reason, 'prerequisites')
        time.sleep(0.25)


def prepare_native_profile(root, run, profile):
    """Shared exact preparation; admission is performed by the caller first."""
    daemon, original, config, runtime, runtimes = native_relay_configuration(root, profile)
    packages = profile['packages']
    try:
        versions = run('/usr/bin/dpkg-query', '--show', '--showformat=${Package}=${Version}\n',
                       *sorted(packages)).splitlines()
    except subprocess.SubprocessError:
        versions = []
    expected = [name + '=' + packages[name] for name in sorted(packages)]
    if sorted(versions) != expected:
        package_env = ('/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', 'NEEDRESTART_MODE=l',
                       'SYSTEMD_OFFLINE=1')
        run(*package_env, '/usr/bin/apt-get', 'update')
        run(*package_env, '/usr/bin/apt-get', 'install', '-y', '--no-install-recommends', '--no-remove',
            '-o', 'Dpkg::Options::=--force-confold', *expected)
        if sorted(run('/usr/bin/dpkg-query', '--show', '--showformat=${Package}=${Version}\n',
                      *sorted(packages)).splitlines()) != expected:
                raise PreflightError('native_packages_changed', 'prerequisites')
    if runtimes.get('runsc-relay') != runtime:
        runtimes['runsc-relay'] = runtime
        candidate = daemon.with_name('.verity-egress-daemon.json')
        trusted_native_file(candidate, root)
        atomic_file(candidate, (json.dumps(config) + '\n').encode())
        try:
            run('/usr/bin/dockerd', '--validate', '--config-file', str(candidate))
            atomic_file(daemon, candidate.read_bytes())
            try:
                try:
                    run('/usr/bin/systemctl', 'reload', 'docker.service')
                except Exception as error:
                    raise PreflightError('relay_reload_failed', 'prerequisites') from error
                await_relay_runtime(run, runtime)
            except Exception:
                try:
                    atomic_file(daemon, original)
                    run('/usr/bin/systemctl', 'reload', 'docker.service')
                    await_relay_runtime(run, relay_identity({'Runtimes': json.loads(original).get('runtimes', {})}))
                except Exception as error:
                    raise PreflightError('relay_rollback_failed', 'prerequisites') from error
                raise
        finally:
            candidate.unlink(missing_ok=True)
    # Record ownership only after successful admission and Docker convergence.
    # An unrelated registration never becomes managed merely by using this name.
    authority = root / RELAY_RUNTIME_AUTHORITY
    trusted_native_file(authority, root)
    atomic_file(authority, (json.dumps({'version': 1, 'runtime': profile['runtime']},
                                     sort_keys=True) + '\n').encode(), 0o600)
    unit = root / 'etc/systemd/system/sys-fs-bpf.mount'
    trusted_native_file(unit, root)
    if unit.exists() and unit.read_bytes() != LEGACY_BPFFS_UNIT:
        raise ValueError('Unmanaged persistent bpffs unit collision')
    mounts = (root / 'proc/mounts').read_text().splitlines()
    mounted = [line.split()[2] for line in mounts if len(line.split()) >= 3
               and line.split()[1] == '/sys/fs/bpf']
    if mounted != ['bpf']:
        raise ValueError('Requires systemd-managed bpffs at /sys/fs/bpf')
    # systemd mounts bpffs during API filesystem setup and rejects .mount units
    # for that path. Retire only our exact old unit, without stopping the mount.
    if unit.exists():
        enabled = unit.parent / 'multi-user.target.wants/sys-fs-bpf.mount'
        trusted_parent(enabled, root)
        if enabled.exists() or enabled.is_symlink():
            metadata = enabled.lstat()
            if (not stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != os.geteuid()
                    or os.readlink(enabled) not in ('../sys-fs-bpf.mount', '/etc/systemd/system/sys-fs-bpf.mount')):
                raise ValueError('Unmanaged persistent bpffs enablement collision')
            enabled.unlink()
            sync_directory(enabled.parent)
        unit.unlink()
        sync_directory(unit.parent)
    run('/usr/bin/systemctl', 'daemon-reload')
    pin = root / 'sys/fs/bpf/verity_egress_deadline'
    trusted_parent(pin / 'entry', root)
    # bpffs is volatile kernel state and rejects directory fsync with EINVAL.
    # The persistent mount/tmpfiles configuration recreates this path at boot.
    pin.mkdir(mode=0o700, exist_ok=True)
    metadata = pin.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077:
        raise ValueError('Untrusted persistent BPF pin directory')
    tmpfiles = root / 'etc/tmpfiles.d/verity-egress-bpf.conf'
    trusted_native_file(tmpfiles, root)
    atomic_file(tmpfiles, b'd /sys/fs/bpf/verity_egress_deadline 0700 root root -\n')



def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=600 if '/usr/bin/apt-get' in args else 45,
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


def runtime_preflight(root, run=command, node_path='/usr/bin/node', *, assessment=None):
    """Read-only native runtime checks shared by both installation paths."""
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
    node = run(node_path, '--version').strip()
    if not re.fullmatch(r'v26\.(\d+)\.(\d+)', node) or tuple(map(int, node[4:].split('.'))) < (12, 1):
        raise ValueError('Requires Node 26.12.1 or newer in the 26.x release line')
    info = json.loads(run('/usr/bin/docker', '--host=unix:///var/run/docker.sock',
                          'info', '--format', '{{json .}}'))
    if (info.get('OSType') != 'linux' or info.get('ServerVersion') not in (STAGING_DOCKER_VERSIONS if assessment is not None else PRODUCTION_DOCKER_VERSIONS)
            or info.get('LiveRestoreEnabled') is not False
            or any('rootless' in item for item in info.get('SecurityOptions', []))):
        raise PreflightError('docker_host_unsupported')
    if not {'runsc-project', 'runsc-relay'} <= set(info.get('Runtimes', {})):
        raise PreflightError('relay_runtime_missing')
    profile = (accepted_native_profile(root, run, node_path) if assessment is None else
               validate_staging_assessment(root, run, node_path, assessment))
    relay = {'path': profile['runtime']['path'], 'runtimeArgs': RELAY_RUNTIME_ARGS}
    actual = info.get('Runtimes', {}).get('runsc-relay', {})
    if {'path': actual.get('path'), 'runtimeArgs': actual.get('runtimeArgs', [])} != relay:
        raise ValueError('Relay runtime does not match accepted native profile')
    packages = profile['packages']
    if sorted(run('/usr/bin/dpkg-query', '--show', '--showformat=${Package}=${Version}\n',
                  *sorted(packages)).splitlines()) != [name + '=' + packages[name] for name in sorted(packages)]:
        raise PreflightError('native_packages_changed', 'runtime_preflight')
    for path in ('usr/sbin/nft', 'usr/sbin/bpftool', 'sbin/tc', 'sbin/ip',
                 'usr/bin/flock', 'usr/bin/nsenter', 'usr/bin/python3'):
        if not os.access(root / path, os.X_OK):
            raise ValueError('Missing executable: /' + path)
    if not hasattr(os, 'setns') or not hasattr(ctypes.CDLL('libnftables.so.1'), 'nft_ctx_buffer_output'):
        raise ValueError('Requires Python setns and libnftables buffer API')
    mounts = (root / 'proc/mounts').read_text().splitlines()
    if not any(len(line.split()) >= 3 and line.split()[1:3] == ['/sys/fs/bpf', 'bpf'] for line in mounts):
        raise ValueError('Requires persistent bpffs mount at /sys/fs/bpf')
    pin = root / 'sys/fs/bpf/verity_egress_deadline'
    if not pin.is_dir() or pin.is_symlink() or pin.stat().st_uid != 0 or pin.stat().st_mode & 0o077:
        raise ValueError('Requires root-owned private persistent BPF pin directory')


def preflight(root, run=command):
    runtime_preflight(root, run)
    grp.getgrnam('verity-egress-control')
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
                    if path.parent.is_dir():
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
