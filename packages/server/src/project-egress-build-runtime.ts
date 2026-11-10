import { createHash } from 'node:crypto';
import { ProtectedBuildFailure, ProtectedBuildStageError } from './project-egress-build-error.js';
import {
  protectedBuildRequest,
  type ProtectedBuildRequest,
  type ProtectedBuildRuntime,
} from './project-egress-build.js';
import type {
  ProtectedBuildAnchor,
  ProtectedBuildNetworks,
} from './project-egress-build-network.js';

export interface ProtectedBuildLaunch {
  unit: string;
  descriptorId: string;
  directory: string;
  projectCache: string;
  executable: '/usr/bin/systemd-run';
  args: readonly string[];
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Only a fixed release-installed helper accepts the opaque descriptor id. The
 * request cannot add a systemd option, shell command, executable or host path.
 */
export function protectedBuildLaunch(
  input: ProtectedBuildRequest,
  anchor: ProtectedBuildAnchor,
): ProtectedBuildLaunch {
  const request = protectedBuildRequest.parse(input);
  if (
    anchor.binding.projectId !== request.projectId ||
    anchor.attemptId !== request.attemptId ||
    anchor.binding.generation !== request.attemptId ||
    !/^\/var\/run\/docker\/netns\/[a-zA-Z0-9_-]+$/u.test(anchor.namespacePath)
  )
    throw new Error('Protected build launch identity mismatch');
  const descriptorId = digest(`${request.projectId}\0${request.attemptId}`);
  const unit = `verity-protected-build-${descriptorId.slice(0, 32)}.service`;
  const directory = `/var/lib/verity/protected-build/attempts/${descriptorId}`;
  const projectCache = `/var/lib/verity/protected-build/projects/${digest(request.projectId)}`;
  return {
    unit,
    descriptorId,
    directory,
    projectCache,
    executable: '/usr/bin/systemd-run',
    args: [
      '--quiet',
      `--unit=${unit}`,
      '--service-type=exec',
      '--slice=verity-buildkit.slice',
      '--property=KillMode=control-group',
      '--property=TimeoutStopSec=30',
      '--property=RuntimeMaxSec=2700',
      '--property=Restart=no',
      '--property=RemainAfterExit=yes',
      '--property=NoNewPrivileges=yes',
      '--property=PrivateTmp=yes',
      '--property=PrivateMounts=yes',
      '--property=TemporaryFileSystem=/run:rw,size=64M /var/lib/cni:rw,size=16M',
      '--property=ProtectHome=yes',
      '--property=ProtectSystem=strict',
      `--property=NetworkNamespacePath=${anchor.namespacePath}`,
      `--property=ReadWritePaths=${directory} ${projectCache}`,
      '--property=InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/run/containerd -/data',
      '--property=UMask=0077',
      '--',
      '/usr/local/libexec/verity-buildkit/protected-build-attempt',
      'run',
      descriptorId,
    ],
  };
}
export interface ProtectedBuildRuntimeState {
  request: ProtectedBuildRequest;
  anchor: ProtectedBuildAnchor;
  launched: boolean;
}
export interface ProtectedBuildRuntimeIO {
  /** Verifies the installed fixed helper/toolchain, shared-budget slice, private
   * daemon endpoint contract and build-specific kernel inspection capability.
   * A generic builder or egress health response is not sufficient readiness.
   */
  ready(): Promise<boolean>;
  stopPartial?(request: ProtectedBuildRequest): Promise<void>;
  endedPartial?(request: ProtectedBuildRequest): Promise<boolean>;
  removePartial?(request: ProtectedBuildRequest): Promise<void>;
  networks: Pick<ProtectedBuildNetworks, 'create' | 'inspect' | 'remove'>;
  load(request: ProtectedBuildRequest): Promise<ProtectedBuildRuntimeState | undefined>;
  save(state: ProtectedBuildRuntimeState): Promise<void>;
  /** Revalidates/copies the bounded snapshot to root-owned staging, writes the
   * private descriptor and pinned daemon/CNI configs, and returns without running
   * any project data. Registry credentials never enter the request or logs.
   */
  prepareFiles(request: ProtectedBuildRequest, launch: ProtectedBuildLaunch): Promise<void>;
  launch(plan: ProtectedBuildLaunch): Promise<void>;
  status(unit: string): Promise<'running' | 'succeeded' | 'failed'>;
  stop(unit: string): Promise<void>;
  /** Must prove the complete systemd cgroup is empty, not merely CLI exit. */
  ended(unit: string): Promise<boolean>;
  cleanup(request: ProtectedBuildRequest, launch: ProtectedBuildLaunch): Promise<void>;
  authority: {
    prepare(anchor: ProtectedBuildAnchor): Promise<void>;
    renew(anchor: ProtectedBuildAnchor): Promise<void>;
    deny(anchor: ProtectedBuildAnchor): Promise<void>;
    release(anchor: ProtectedBuildAnchor): Promise<void>;
  };
}
function sameRequest(a: ProtectedBuildRequest, b: ProtectedBuildRequest): boolean {
  return (
    JSON.stringify(protectedBuildRequest.parse(a)) ===
    JSON.stringify(protectedBuildRequest.parse(b))
  );
}
/** Composes the real anchor, durable host journal, fixed process supervisor and
 * project-derived packet authority. It never falls back to the shared builder.
 */
export function createProtectedBuildRuntime(io: ProtectedBuildRuntimeIO): ProtectedBuildRuntime {
  const state = async (request: ProtectedBuildRequest) => {
    const value = await io.load(request);
    if (!value || !sameRequest(value.request, request))
      throw new Error('Unknown or changed protected build runtime');
    protectedBuildLaunch(request, value.anchor);
    return value;
  };
  return {
    ready: () => io.ready().catch(() => false),
    async prepare(input) {
      const request = protectedBuildRequest.parse(input);
      if (!(await io.ready())) throw new Error('Protected build toolchain is not ready');
      if (await io.load(request)) throw new Error('Protected build runtime already exists');
      const anchor = await io.networks
        .create(request.projectId, request.attemptId)
        .catch((cause: unknown) => {
          throw new ProtectedBuildFailure('network_prepare_failed', { cause });
        });
      const saved: ProtectedBuildRuntimeState = { request, anchor, launched: false };
      await io.save(saved);
      await io.authority.prepare(anchor).catch((cause: unknown) => {
        throw new ProtectedBuildFailure('authority_prepare_failed', { cause });
      });
      await io
        .prepareFiles(request, protectedBuildLaunch(request, anchor))
        .catch((cause: unknown) => {
          throw new ProtectedBuildFailure('files_prepare_failed', { cause });
        });
    },
    async renew(request) {
      const saved = await state(request);
      await io.networks.inspect(saved.anchor);
      await io.authority.renew(saved.anchor);
    },
    async start(request) {
      const saved = await state(request);
      if (saved.launched) throw new Error('Protected build already launched');
      if (!(await io.ready())) throw new Error('Protected build toolchain is not ready');
      await io.networks.inspect(saved.anchor);
      // Write intent before systemd can start children. A crash or lost reply is
      // reconciled by unit identity, never interpreted as "nothing started".
      saved.launched = true;
      await io.save(saved);
      await io.launch(protectedBuildLaunch(request, saved.anchor));
    },
    async status(request) {
      const saved = await state(request);
      return saved.launched
        ? io.status(protectedBuildLaunch(request, saved.anchor).unit)
        : 'failed';
    },
    async deny(request) {
      const saved = await io.load(request);
      if (!saved) return; // Partial preparation remains denied by bootstrap.
      if (!sameRequest(saved.request, request)) throw new Error('Changed protected build runtime');
      await io.authority.deny(saved.anchor);
    },
    async stop(request) {
      const saved = await io.load(request);
      if (!saved) {
        await io.stopPartial?.(request);
        return;
      }
      if (!sameRequest(saved.request, request)) throw new Error('Changed protected build runtime');
      await io.authority.deny(saved.anchor);
      await io.stop(protectedBuildLaunch(request, saved.anchor).unit);
    },
    async ended(request) {
      const saved = await io.load(request);
      // No anchor record is not proof that a partially created attempt ended.
      if (!saved) return io.endedPartial ? io.endedPartial(request) : false;
      if (!sameRequest(saved.request, request)) return false;
      return io.ended(protectedBuildLaunch(request, saved.anchor).unit);
    },
    async remove(request) {
      // Each step is idempotent and retried as a whole; the stage only names
      // where a retry stopped, for correlation in the host journal.
      const stage = async <T>(name: string, step: () => Promise<T>): Promise<T> => {
        try {
          return await step();
        } catch (cause) {
          throw new ProtectedBuildStageError(name, { cause });
        }
      };
      const partial = await stage('state.load', () => io.load(request));
      if (!partial) {
        if (
          !io.endedPartial ||
          !io.removePartial ||
          !(await stage('partial.ended', () => io.endedPartial!(request)))
        )
          throw new Error('Protected build partial termination is unconfirmed');
        await stage('partial.remove', () => io.removePartial!(request));
        return;
      }
      const saved = await stage('state.verify', () => state(request));
      const launch = protectedBuildLaunch(request, saved.anchor);
      await stage('authority.deny', () => io.authority.deny(saved.anchor));
      if (!(await stage('unit.ended', () => io.ended(launch.unit))))
        throw new Error('Protected build termination is unconfirmed');
      await stage('authority.release', () => io.authority.release(saved.anchor));
      await stage('network.remove', () =>
        io.networks.remove(saved.anchor, () => io.ended(launch.unit)),
      );
      await stage('files.cleanup', () => io.cleanup(request, launch));
    },
  };
}
