import { describe, expect, it } from 'vitest';
import {
  deploymentSpecChecksum,
  MANAGED_SERVER_DEFAULT_RESOURCES,
  parseServerDeploymentSpec,
  sealDeploymentSpec,
  type ServerDeploymentSpecBody,
} from './deployment-spec.js';

/** The checksum an earlier Server generation sealed {@link body} with. Pinned
 *  rather than recomputed: a spec on disk is immutable and its seal was taken by
 *  code that no longer runs, so a change to the schema or the canonical form that
 *  would make an adopted deployment fail its own checksum has to fail here
 *  instead. On a host it means an unreadable authority and an Updater with no
 *  path out. */
const LEGACY_CHECKSUM = 'sha256:a13ae0269bf407ec16d611f90ca3c77f2f1cef30d2822e6bbcf152ee75e63aed';

const body = (): ServerDeploymentSpecBody => ({
  schemaVersion: 2,
  deploymentId: 'managed-1',
  image: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
  environment: [{ name: 'DATABASE_URL', source: { kind: 'env', name: 'DATABASE_URL' } }],
  mounts: [
    {
      source: { kind: 'volume', name: 'verity-data' },
      target: '/srv/verity',
      readOnly: false,
    },
    {
      source: { kind: 'volume', name: 'verity-agent-gateway-control' },
      target: '/run/verity-agent-gateway',
      readOnly: false,
    },
    {
      source: { kind: 'bind', path: '/var/run/docker.sock' },
      target: '/var/run/docker.sock',
      readOnly: false,
    },
  ],
  user: { uid: 1000, gid: 1000, supplementaryGids: [1101] },
  restart: 'unless-stopped',
  network: 'verity-net',
  platform: { os: 'linux', architecture: 'amd64' },
  security: { noNewPrivileges: true, readOnlyRootFilesystem: false, capAdd: ['CHOWN'] },
});

describe('ServerDeploymentSpec', () => {
  it('round-trips a sealed allowlisted spec', () => {
    const spec = sealDeploymentSpec(body());
    expect(parseServerDeploymentSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
  });

  it('has a deterministic checksum independent of object key order', () => {
    const a = body();
    const reordered: ServerDeploymentSpecBody = {
      security: a.security,
      platform: a.platform,
      network: a.network,
      restart: a.restart,
      user: a.user,
      mounts: a.mounts,
      environment: a.environment,
      image: a.image,
      deploymentId: a.deploymentId,
      schemaVersion: a.schemaVersion,
    };
    expect(deploymentSpecChecksum(reordered)).toBe(deploymentSpecChecksum(a));
  });

  it('rejects mutation after sealing', () => {
    const spec = sealDeploymentSpec(body());
    expect(parseServerDeploymentSpec({ ...spec, restart: 'no' })).toBeNull();
  });

  it('rejects unknown fields and mutable image tags', () => {
    const spec = sealDeploymentSpec(body());
    expect(parseServerDeploymentSpec({ ...spec, privileged: true })).toBeNull();
    expect(
      parseServerDeploymentSpec(
        sealDeploymentSpec({ ...body(), image: 'ghcr.io/heey-global/verity/verity-server:latest' }),
      ),
    ).toBeNull();
  });

  it('accepts only external environment references, never literal secret values', () => {
    const spec = sealDeploymentSpec(body());
    expect(
      parseServerDeploymentSpec({ ...spec, environment: [{ name: 'TOKEN', value: 'secret' }] }),
    ).toBeNull();
  });

  it('rejects unsafe capabilities and relative mount paths', () => {
    const unsafe = body();
    expect(
      parseServerDeploymentSpec(
        sealDeploymentSpec({
          ...unsafe,
          security: { ...unsafe.security, capAdd: ['SYS_ADMIN' as 'CHOWN'] },
        }),
      ),
    ).toBeNull();
    expect(
      parseServerDeploymentSpec(
        sealDeploymentSpec({
          ...unsafe,
          mounts: [
            { source: { kind: 'volume', name: 'data' }, target: '../escape', readOnly: false },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('rejects path ambiguity and resources outside the managed Compose allowlist', () => {
    const base = body();
    expect(
      parseServerDeploymentSpec(
        sealDeploymentSpec({
          ...base,
          environment: [
            { name: 'TOKEN', source: { kind: 'file', path: '/run/secrets/../shadow' } },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseServerDeploymentSpec(
        sealDeploymentSpec({
          ...base,
          mounts: [
            {
              source: { kind: 'volume', name: 'other-data' },
              target: '/srv/verity',
              readOnly: false,
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseServerDeploymentSpec(sealDeploymentSpec({ ...base, network: 'other-net' })),
    ).toBeNull();
  });

  // The Server does not get the update journal, and this is where that is
  // enforced. A Server-side companion bootstrap once polled the journal at 1 Hz
  // and threw ENOENT every time, because this volume cannot appear in a sealed
  // spec — and `initialize` is create-only, so no deployment could re-seal
  // itself to add it. Reach for the mount when that loop tempts someone back
  // and this test is the answer: the Updater owns companion reconciliation.
  it('rejects the Updater-private managed-deployment volume', () => {
    const base = body();
    expect(
      parseServerDeploymentSpec(
        sealDeploymentSpec({
          ...base,
          mounts: [
            ...base.mounts,
            {
              source: { kind: 'volume', name: 'verity-managed-deployment' },
              target: '/var/lib/verity/updater/managed-deployment',
              readOnly: false,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('accepts the optional Updater control mount without requiring it', () => {
    const base = body();
    const withControl = sealDeploymentSpec({
      ...base,
      mounts: [
        ...base.mounts,
        {
          source: { kind: 'volume', name: 'verity-updater-control' },
          target: '/run/verity-updater/control',
          readOnly: false,
        },
      ],
    });
    expect(parseServerDeploymentSpec(JSON.parse(JSON.stringify(withControl)))).toEqual(withControl);
    // A deployment sealed before the mount existed still parses; it simply never
    // gets an update controller.
    expect(parseServerDeploymentSpec(sealDeploymentSpec(base))).not.toBeNull();
  });

  it('accepts only the fixed ACP control-plane Runner volume targets', () => {
    const base = body();
    const supervised = sealDeploymentSpec({
      ...base,
      mounts: [
        ...base.mounts,
        {
          source: { kind: 'volume', name: 'verity-control-runner-runtime' },
          target: '/srv/verity/runners/verity-control',
          readOnly: false,
        },
        {
          source: { kind: 'volume', name: 'verity-control-runner-identity' },
          target: '/run/verity-control-identity',
          readOnly: false,
        },
      ],
    });
    expect(parseServerDeploymentSpec(JSON.parse(JSON.stringify(supervised)))).toEqual(supervised);
    expect(
      parseServerDeploymentSpec(
        sealDeploymentSpec({
          ...base,
          mounts: [
            ...base.mounts,
            {
              source: { kind: 'volume', name: 'verity-control-runner-identity' },
              target: '/run/foreign-identity',
              readOnly: false,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('rejects a control mount at a foreign target and a shadowed docker socket', () => {
    const base = body();
    expect(
      parseServerDeploymentSpec(
        sealDeploymentSpec({
          ...base,
          mounts: [
            ...base.mounts,
            {
              source: { kind: 'volume', name: 'verity-updater-control' },
              target: '/run/verity-agent-gateway',
              readOnly: false,
            },
          ],
        }),
      ),
    ).toBeNull();
    // Distinct source paths, same target: distinct keys, but the second bind
    // would shadow the socket the allowlist vetted.
    expect(
      parseServerDeploymentSpec(
        sealDeploymentSpec({
          ...base,
          mounts: [
            ...base.mounts,
            {
              source: { kind: 'bind', path: '/tmp/evil/docker.sock' },
              target: '/var/run/docker.sock',
              readOnly: false,
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('rejects inherited required fields and non-JSON checksum input', () => {
    const spec = sealDeploymentSpec(body());
    const inherited = Object.create({ checksum: spec.checksum }) as Record<string, unknown>;
    Object.assign(inherited, spec);
    delete inherited.checksum;
    expect(parseServerDeploymentSpec(inherited)).toBeNull();
    expect(() => deploymentSpecChecksum({ ...body(), image: undefined } as never)).toThrow(
      /JSON values/,
    );
  });

  it('rejects sparse arrays before hashing or parsing', () => {
    const sparse = Array(1) as number[];
    expect(() =>
      deploymentSpecChecksum({
        ...body(),
        user: { ...body().user, supplementaryGids: sparse },
      }),
    ).toThrow(/sparse arrays/);
    const spec = sealDeploymentSpec(body());
    expect(
      parseServerDeploymentSpec({
        ...spec,
        user: { ...spec.user, supplementaryGids: sparse },
      }),
    ).toBeNull();
    const disguised = Array(1) as number[] & { extra?: number };
    disguised.extra = 1;
    expect(() =>
      deploymentSpecChecksum({
        ...body(),
        user: { ...body().user, supplementaryGids: disguised },
      }),
    ).toThrow(/sparse arrays/);
  });

  it('rejects user and group IDs outside the Linux runtime range', () => {
    const base = body();
    expect(
      parseServerDeploymentSpec(
        sealDeploymentSpec({
          ...base,
          user: { ...base.user, supplementaryGids: [0xffffffff] },
        }),
      ),
    ).toBeNull();
  });

  it('still verifies the seal of a spec written before resource limits existed', () => {
    expect(deploymentSpecChecksum(body())).toBe(LEGACY_CHECKSUM);
    const legacy = { ...body(), checksum: LEGACY_CHECKSUM };
    const parsed = parseServerDeploymentSpec(JSON.parse(JSON.stringify(legacy)));
    expect(parsed).not.toBeNull();
    // Absent stays absent. Substituting the default into the parsed body would
    // change the hash input and reject every deployment sealed before the field.
    expect(parsed !== null && Object.hasOwn(parsed, 'resources')).toBe(false);
  });

  it('seals resource limits when they are stated, and hashes them', () => {
    const limited = sealDeploymentSpec({ ...body(), resources: MANAGED_SERVER_DEFAULT_RESOURCES });
    expect(parseServerDeploymentSpec(JSON.parse(JSON.stringify(limited)))).toEqual(limited);
    expect(limited.checksum).not.toBe(LEGACY_CHECKSUM);
    // Tampering with a sealed limit is refused like any other body field.
    expect(
      parseServerDeploymentSpec({
        ...limited,
        resources: { ...MANAGED_SERVER_DEFAULT_RESOURCES, memoryBytes: 64 * 1024 ** 3 },
      }),
    ).toBeNull();
  });

  it('rejects resource limits that are partial, unbounded, or not a real ceiling', () => {
    const sealed = (resources: unknown): unknown =>
      sealDeploymentSpec({ ...body(), resources } as ServerDeploymentSpecBody);
    // Each key is required once the object is present — a spec stating three of
    // four would leave the fourth silently at Docker's default.
    expect(
      parseServerDeploymentSpec(
        sealed({ memoryBytes: 1024, memorySwapBytes: 1024, nanoCpus: 1_000_000_000 }),
      ),
    ).toBeNull();
    expect(
      parseServerDeploymentSpec(sealed({ ...MANAGED_SERVER_DEFAULT_RESOURCES, extra: 1 })),
    ).toBeNull();
    // Zero is Docker's "unlimited", which is the state this field exists to end.
    expect(
      parseServerDeploymentSpec(sealed({ ...MANAGED_SERVER_DEFAULT_RESOURCES, pidsLimit: 0 })),
    ).toBeNull();
    expect(
      parseServerDeploymentSpec(sealed({ ...MANAGED_SERVER_DEFAULT_RESOURCES, nanoCpus: -1 })),
    ).toBeNull();
    expect(
      parseServerDeploymentSpec(sealed({ ...MANAGED_SERVER_DEFAULT_RESOURCES, memoryBytes: 1.5 })),
    ).toBeNull();
    expect(
      parseServerDeploymentSpec(
        sealed({ ...MANAGED_SERVER_DEFAULT_RESOURCES, memoryBytes: 1024 ** 4 + 1 }),
      ),
    ).toBeNull();
    // A combined memory+swap ceiling below the memory ceiling is invalid to Docker
    // and makes the memory limit unreachable.
    expect(
      parseServerDeploymentSpec(
        sealed({ ...MANAGED_SERVER_DEFAULT_RESOURCES, memorySwapBytes: 1024 }),
      ),
    ).toBeNull();
    expect(parseServerDeploymentSpec(sealed(null))).toBeNull();
  });
});
