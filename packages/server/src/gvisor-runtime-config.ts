/** Deployment pin shared by server readiness and deploy/gvisor/versions.env. */
export const PINNED_RUNSC_RELEASE = 'release-20260714.0';
export const PINNED_RUNSC_PATH = `/opt/verity/runsc/${PINNED_RUNSC_RELEASE}/runsc`;
export const PINNED_RUNSC_ARGS = ['--platform=systrap', '--network=none'] as const;
