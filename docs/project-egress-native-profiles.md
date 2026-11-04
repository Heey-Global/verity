# Managed native Network protection profiles


## Exact native profiles and bounded prerequisite preparation

Managed installation selects a release-owned native profile before preparing host
prerequisites. A profile binds the exact kernel, architecture, OS release, Docker
version, bundled controller/Node and both BPF object hashes, reviewed gVisor binary path/hash and complete runtime-tree hash,
project runtime arguments, exact distro package versions and the digest of its
retained native acceptance evidence. Kernel identity alone cannot admit a profile.
The accepted profile list remains empty until that evidence exists.

The host must already supply the Python interpreter used to verify the native
profile. The fixed wrapper refuses a missing interpreter instead of installing
an unpinned bootstrap package; supporting such hosts requires separately tested
release-owned bootstrap delivery before they can enter the accepted set.

For an accepted profile, the fixed preparer installs only its pinned Python,
network/BPF utilities and runtime library packages, preserves existing conffiles and uses `SYSTEMD_OFFLINE=1` to prevent package systemctl calls from contacting the live manager,
registers the exact reviewed `runsc-relay` runtime beside `runsc-project`, validates
Docker configuration and reloads Docker without restarting containers. A failed
reload restores the previous configuration. Unrelated relay registrations and
bpffs unit/filesystem collisions are refused. Persistent bpffs uses a fixed mount
unit and a private root-owned pin directory recreated through tmpfiles. Controller
startup rechecks the exact profile and package versions; a changed kernel/runtime
or artifact cannot silently inherit a prior acceptance.

The host provisioning oneshot has a bounded 720-second lifetime to accommodate
package preparation. A new updater allows a longer outer wait. Older installed
updaters may still impose their previous 110-second caller deadline; that timeout
does not cancel the owned host oneshot. A failed caller is not success, and native
compatibility acceptance must measure that route and its subsequent retry before
claiming a one-update repair.

The boot harness also invokes the real managed preparer twice with preparation
only. Its `managed-staging.json` records preserved key, Docker process, active
units and firewall tables, and stable repeated preparation. This is staging
coverage alongside experimental lifecycle evidence. It does not certify signed
managed updater admission/cutover, successful direct-authority activation,
profile-specific package installation, or protected application positive controls.
Those require the complete managed server/database/runtime fixture and independent
packet observations before a profile is published.

The systemd environment behavior is documented in
[systemd environment variables](https://github.com/systemd/systemd/blob/main/docs/ENVIRONMENT.md).
This is process-scoped and does not replace the host's global `policy-rc.d` file.
An accepted package set must additionally demonstrate that its maintainer scripts
do not execute firewall operations directly and that host connectivity remains
unchanged; environment flags and mocked commands do not establish that property.
