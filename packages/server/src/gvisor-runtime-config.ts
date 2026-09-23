/** Deployment pin shared by server readiness and deploy/gvisor/versions.env. */
export const PINNED_RUNSC_RELEASE = 'release-20260714.0';
export const PINNED_RUNSC_PATH = `/opt/verity/runsc/${PINNED_RUNSC_RELEASE}/runsc`;
/** `runsc`: brokered Secret jobs. Short-lived, networkless, no host sockets. */
export const PINNED_RUNSC_ARGS = ['--platform=systrap', '--network=none'] as const;

/**
 * `runsc-project`: long-running project sandboxes that serve public previews (#655). The same
 * pinned binary, registered a second time because a project Runner cannot work under the Secret
 * job arguments above:
 *
 * - `--network=sandbox` — gVisor's own netstack. The sandbox reaches its relay (Claude/Codex
 *   egress, the MCP gateway, the signing broker) and the preview connector reaches its dev server
 *   over TCP on the project network; under `--network=none` every one of those is ENETUNREACH.
 * - `--host-uds=create` — a Unix socket the sandbox binds in a mounted directory becomes a real
 *   host socket. The Server reaches the supervisor through exactly that (`supervisor.sock` in the
 *   `runners/<project>` volume subpath); without it the socket exists only inside the sentry and
 *   the Server sees ENOENT. `create` does not grant `open`: the sandbox still cannot connect to a
 *   socket the host created, so no host service becomes reachable through a mount.
 *
 * Docker's embedded resolver (127.0.0.11) is not reachable from gVisor's netstack, so the
 * provisioner pins the relay in `/etc/hosts` and supplies upstream resolvers itself
 * (`provisioner.ts`, `gvisorNameResolution`).
 */
export const PROJECT_RUNSC_RUNTIME = 'runsc-project';
export const PINNED_PROJECT_RUNSC_ARGS = [
  '--platform=systrap',
  '--network=sandbox',
  '--host-uds=create',
] as const;
