"""Actual KVM guest preflight; never substitute a container or skipped reboot."""
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time


def check_reboot(before, after):
    for facts in (before, after):
        if not re.fullmatch(r'[a-f0-9-]{36}', facts['boot_id']):
            raise ValueError('Missing guest boot identity')
        if facts['init'] != 'systemd' or facts['systemd'] < 249:
            raise ValueError('Unsupported guest service manager')
    if before['boot_id'] == after['boot_id']:
        raise ValueError('The guest kernel did not reboot')


def memory_mib():
    available = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines()
                         if line.startswith('MemAvailable:'))) * 1024
    ceiling = Path('/sys/fs/cgroup/memory.max')
    if ceiling.exists() and ceiling.read_text().strip() != 'max':
        available = min(available, int(ceiling.read_text()) - int(Path('/sys/fs/cgroup/memory.current').read_text()))
    else:
        constrained = int(subprocess.check_output(['node', '-p', 'process.constrainedMemory()'], text=True).strip() or 0)
        if 0 < constrained < 2 ** 60:
            available = min(available, constrained)
    chosen = min(4096, available // (2 * 1024 ** 2))
    if chosen < 3072:
        raise RuntimeError('Boot VM requires at least 6 GiB available memory')
    quota = Path('/sys/fs/cgroup/cpu.max')
    if quota.exists():
        value, period = quota.read_text().split()
        if value != 'max' and int(value) < int(period):
            raise RuntimeError('Boot VM requires at least one available CPU')
    return chosen


class BootVM:
    def __init__(self, base, evidence, observation_link=None):
        self.observation_link = observation_link
        self.base = Path(base).resolve()
        self.evidence = Path(evidence).resolve()
        self.work = Path(tempfile.mkdtemp(prefix='verity-boot-vm-'))
        self.process = None
        self.log = None
        self.port = None

    def start(self):
        # Permission and device presence alone do not establish virtualization.
        with open('/dev/kvm', 'r+b', buffering=0):
            pass
        if shutil.disk_usage(self.work).free < 8 * 1024 ** 3:
            raise RuntimeError('Boot VM requires at least 8 GiB free disk')
        memory = memory_mib()
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(self.work / 'key')], check=True)
        public = (self.work / 'key.pub').read_text().strip()
        (self.work / 'user-data').write_text(
            '#cloud-config\nusers:\n  - name: verity-probe\n    groups: [sudo]\n'
            '    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n'
            f'    ssh_authorized_keys:\n      - {public}\n'
            'ssh_pwauth: false\ndisable_root: true\n')
        (self.work / 'meta-data').write_text('instance-id: verity-boot-probe\nlocal-hostname: verity-boot-probe\n')
        subprocess.run(['cloud-localds', str(self.work / 'seed.img'), str(self.work / 'user-data'), str(self.work / 'meta-data')], check=True)
        subprocess.run(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', str(self.base), str(self.work / 'disk.qcow2'), '12G'], check=True)
        with socket.socket() as channel:
            channel.bind(('127.0.0.1', 0))
            self.port = channel.getsockname()[1]
        self.log = open(self.evidence / 'qemu.txt', 'w')
        command = ['qemu-system-x86_64', '-accel', 'kvm', '-cpu', 'host', '-smp', '1', '-m', str(memory),
                   '-display', 'none', '-serial', f'file:{self.evidence / "serial.txt"}',
                   '-drive', f'file={self.work / "disk.qcow2"},format=qcow2,if=virtio',
                   '-drive', f'file={self.work / "seed.img"},format=raw,if=virtio,readonly=on',
                   '-netdev', f'user,id=net0,hostfwd=tcp:127.0.0.1:{self.port}-:22', '-device', 'virtio-net-pci,netdev=net0']
        if self.observation_link:
            command.extend(['-netdev', f'tap,id=observe,ifname={self.observation_link},script=no,downscript=no',
                            '-device', 'virtio-net-pci,netdev=observe,mac=52:54:00:be:ef:02'])
        self.process = subprocess.Popen(command, stdout=self.log, stderr=subprocess.STDOUT)
        (self.evidence / 'vm-launch.json').write_text(json.dumps({'accelerator': 'kvm', 'memoryMiB': memory, 'vcpus': 1}))
        self.wait_ready()

    def ssh_command(self, command):
        return ['ssh', '-i', str(self.work / 'key'), '-p', str(self.port),
                                        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'ConnectionAttempts=1',
                                        '-o', 'StrictHostKeyChecking=accept-new', '-o', f'UserKnownHostsFile={self.work / "known_hosts"}',
                                        'verity-probe@127.0.0.1', command]

    def ssh(self, command, timeout=30):
        return subprocess.check_output(self.ssh_command(command), text=True, timeout=timeout, stderr=subprocess.STDOUT)

    def upload(self, archive, destination='/opt/verity-fixture'):
        if destination != '/opt/verity-fixture':
            raise ValueError('Only the disposable asset directory is writable')
        self.ssh(f'sudo mkdir -p {destination}')
        with open(archive, 'rb') as source:
            subprocess.run(self.ssh_command(f'sudo tar -xf - -C {destination}'), stdin=source, check=True, timeout=300)


    def wait_ready(self, previous=None):
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError('KVM guest failed; inspect qemu.txt and serial.txt')
            try:
                facts = self.facts()
                if previous is None or facts['boot_id'] != previous:
                    return facts
            except (subprocess.SubprocessError, ValueError, KeyError):
                pass
            time.sleep(1)
        raise RuntimeError('Guest did not become ready within 180 seconds')

    def facts(self):
        text = self.ssh('cat /proc/sys/kernel/random/boot_id; cat /proc/1/comm; systemctl --version | head -1; uname -r')
        boot_id, init, version, kernel = text.strip().splitlines()
        match = re.match(r'systemd (\d+)', version)
        return {'boot_id': boot_id, 'init': init, 'systemd': int(match[1]) if match else 0, 'kernel': kernel}

    def close(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.log:
            self.log.close()
        shutil.rmtree(self.work)


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('This launcher requires a disposable GitHub Actions runner')
    evidence = Path(sys.argv[2]).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    vm = BootVM(sys.argv[1], evidence)
    def terminate(signum, _frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, terminate)
    try:
        vm.start()
        before = vm.facts()
        try:
            vm.ssh('sudo systemctl reboot')
        except subprocess.CalledProcessError as error:
            if error.returncode != 255:
                raise
        after = vm.wait_ready(before['boot_id'])
        check_reboot(before, after)
        (evidence / 'boot-preflight.json').write_text(json.dumps({'complete': True, 'before': before, 'after': after}, indent=2))
    finally:
        vm.close()


if __name__ == '__main__':
    main()
