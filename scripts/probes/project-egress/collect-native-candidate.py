#!/usr/bin/env python3
"""Collect read-only native candidate metadata; never attest or enable acceptance.

This inventory does not exercise installer/updater transactions, package scripts,
packet enforcement or applications. It is preparation for those tests, not their
substitute. No evidence digest or accepted-profile entry is generated.
"""
import argparse
import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ARTIFACT_NAMES = ('node', 'project-egress-host-main.mjs',
                  'project-egress-deadline.bpf.o', 'project-egress-renew.bpf.o')
EVIDENCE_MISSING = (
    'managed_signed_updater_install_update_retry',
    'native_install_reboot_crash_daemon_restart_rollback',
    'dual_stack_dns_udp_packet_observations',
    'protected_application_positive_controls',
    'unrelated_workload_continuity',
    'database_endpoint_reconciliation',
    'profile_package_script_safety',
    'retained_acceptance_evidence_digest',
)
RUNTIME_PATH = r'/opt/verity/runsc/release-[0-9]{8}\.[0-9]+/runsc'


def bounded(value, pattern, limit):
    if not isinstance(value, str) or len(value) > limit or not re.fullmatch(pattern, value):
        raise ValueError('Invalid candidate metadata')
    return value


def digest_file(path, algorithm='sha256'):
    digest = hashlib.new(algorithm)
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def regular(installer, path, root, immutable=False, limit=256 * 1024 * 1024):
    installer.trusted_parent(path, root)
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or info.st_mode & (0o222 if immutable else 0o022)
            or info.st_size > limit):
        raise ValueError('Untrusted candidate file')


def collect(installer, root=Path('/'), release=Path('/opt/verity-egress'), run=None):
    """Return sanitized observations only. The supplied installer is never mutated.

    root/run are fixture seams; the CLI always inspects the native root. The
    default current-release symlink is permitted, while its canonical target and
    every artifact must satisfy the installer's trusted ownership checks.
    """
    root, release = Path(root), Path(release)
    run = run or installer.command
    result = {'version': 1, 'scope': 'native-profile-candidate', 'accepted': False,
              'platform': {}, 'runtimes': {}, 'runtime': None,
              'artifacts': {name: None for name in ARTIFACT_NAMES}, 'packages': {},
              'blockers': ['native_acceptance_not_performed'],
              'evidenceMissing': list(EVIDENCE_MISSING)}

    def blocked(code):
        if code not in result['blockers']:
            result['blockers'].append(code)

    try:
        result['platform']['kernel'] = bounded(installer.platform.release(), r'[A-Za-z0-9._+~:-]+', 128)
        architecture = bounded(installer.platform.machine(), r'[a-z0-9_]+', 32)
        result['platform']['architecture'] = architecture
        if architecture != 'x86_64':
            blocked('native_architecture_unsupported')
        os_file = root / 'etc/os-release'
        if os_file.stat().st_size > 65536:
            raise ValueError('Oversized OS metadata')
        identity = installer.os_identity(root)
        result['platform']['os'] = {
            'id': bounded(identity['id'], r'[a-z0-9_-]+', 32),
            'version': bounded(identity['version'], r'[A-Za-z0-9._+-]+', 64),
        }
        if identity['id'] != 'ubuntu':
            blocked('native_os_unsupported')
        with (root / 'proc/1/comm').open() as init:
            init_name = init.read(64)
        if init_name != 'systemd\n':
            blocked('native_systemd_required')
    except (OSError, ValueError, KeyError, TypeError):
        blocked('native_platform_metadata_invalid')

    try:
        # Validate the link's parent before following the intentional current link.
        installer.trusted_parent(release, root)
        if release.lstat().st_uid != os.geteuid():
            raise ValueError('Untrusted current-release owner')
        resolved = release.resolve(strict=True)
        resolved.relative_to(root)
        installer.trusted_parent(resolved / 'entry', root)
        artifacts = {}
        for name in ARTIFACT_NAMES:
            path = resolved / name
            regular(installer, path, root, immutable=True)
            artifacts[name] = digest_file(path)
        result['artifacts'] = artifacts
    except (OSError, ValueError, RuntimeError):
        blocked('native_release_artifacts_untrusted')

    try:
        reply = run('/usr/bin/docker', '--host=unix:///var/run/docker.sock',
                    'info', '--format', '{{json .}}')
        if not isinstance(reply, str) or len(reply) > 65536:
            raise ValueError('Oversized Docker metadata')
        info = json.loads(reply)
        result['platform']['docker'] = bounded(info.get('ServerVersion'), r'[0-9][A-Za-z0-9.+:~_-]*', 64)
        security = info.get('SecurityOptions')
        if (info.get('OSType') != 'linux' or info.get('LiveRestoreEnabled') is not False
                or not isinstance(security, list) or len(security) > 32
                or any(not isinstance(option, str) or len(option) > 256 for option in security)
                or any('rootless' in option for option in security)):
            blocked('native_docker_profile_unsupported')
        runtimes = info.get('Runtimes', {})
        for name, expected in [('runsc-project', installer.PROJECT_RUNTIME_ARGS),
                               ('runsc-relay', installer.RELAY_RUNTIME_ARGS)]:
            actual = runtimes.get(name, {})
            path = bounded(actual.get('path'), RUNTIME_PATH, 128)
            if actual.get('runtimeArgs') != expected:
                raise ValueError('Unreviewed runtime arguments')
            result['runtimes'][name] = {'path': path, 'runtimeArgs': list(expected)}
        if result['runtimes']['runsc-project']['path'] != result['runtimes']['runsc-relay']['path']:
            blocked('native_runtime_registrations_mismatch')
        else:
            path = result['runtimes']['runsc-project']['path']
            runtime = root / path.lstrip('/')
            regular(installer, runtime, root, limit=128 * 1024 * 1024)
            entries = list(itertools.islice(runtime.parent.rglob('*'), 513))
            if len(entries) > 512:
                raise ValueError('Oversized runtime tree')
            total = 0
            for entry in entries:
                metadata = entry.lstat()
                if metadata.st_size > 128 * 1024 * 1024:
                    raise ValueError('Oversized runtime tree entry')
                total += metadata.st_size
            if total > 512 * 1024 * 1024:
                raise ValueError('Oversized runtime tree')
            result['runtime'] = {'path': path, 'sha512': digest_file(runtime, 'sha512'),
                                 'treeSha256': installer.runtime_tree_digest(runtime.parent)}
    except (OSError, ValueError, TypeError, AttributeError, subprocess.SubprocessError):
        blocked('native_runtime_metadata_invalid')

    try:
        try:
            reply = run('/usr/bin/dpkg-query', '--show', '--showformat=${Package}=${Version}\n',
                        *sorted(installer.NATIVE_PACKAGES))
        except subprocess.CalledProcessError as error:
            # dpkg-query reports installed members on stdout even when another
            # requested package is absent. Keep only bounded validated versions.
            reply = error.stdout
            blocked('native_package_query_incomplete')
        if not isinstance(reply, str) or len(reply) > 8192:
            raise ValueError('Oversized package metadata')
        packages = {}
        for line in reply.splitlines():
            name, separator, version = line.partition('=')
            if not separator or name not in installer.NATIVE_PACKAGES or name in packages:
                raise ValueError('Unexpected package metadata')
            packages[name] = bounded(version, r'[A-Za-z0-9.+:~_-]+', 128)
        result['packages'] = packages
        if set(packages) != installer.NATIVE_PACKAGES:
            blocked('native_packages_incomplete')
    except (OSError, ValueError, subprocess.SubprocessError):
        blocked('native_package_metadata_invalid')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0 or sys.platform != 'linux':
        parser.error('requires root on the native Linux host')
    if args.release is not None:
        try:
            disposable = Path('/var/lib/cloud/data/instance-id').read_text().strip() == 'verity-boot-probe'
        except OSError:
            disposable = False
        if not disposable:
            parser.error('--release is restricted to the isolated native acceptance guest')
    source = Path(__file__).resolve().parents[2] / 'project-egress-install.py'
    spec = importlib.util.spec_from_file_location('native_candidate_installer', source)
    installer = importlib.util.module_from_spec(spec)
    sys.dont_write_bytecode = True
    spec.loader.exec_module(installer)
    print(json.dumps(collect(installer, release=args.release or Path('/opt/verity-egress')), sort_keys=True))


if __name__ == '__main__':
    main()
