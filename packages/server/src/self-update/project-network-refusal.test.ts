// ADR 0008 D2, "Superseded — dynamic project networking".
//
// D2 originally gave the Updater one narrow RPC for attaching and detaching the
// Gateway on project networks. It was never built, and by the time anyone looked
// the project relay had removed the reason for it: a Sandbox reaches Verity over
// Unix sockets its own relay exposes, on its own single project network, so no
// name inside that network resolves to the Gateway and an attachment would open
// nothing that is currently closed. What it WOULD do is make the container that
// fronts both listeners a member of every project network — the cross-project
// pivot `docs/TEMPORARY_PUBLIC_PREVIEWS_IMPLEMENTATION_SPIKE.md` rejects by name.
//
// So the managed deployment's position on project networks is a refusal, and the
// refusal is carried by three unrelated pieces of code that each fail closed on
// their own. Each of them reads, locally, like an unfinished feature or a
// simplification waiting to happen: a hard-coded string, a short route list, a
// client that only creates networks. This file is the one place that says they
// are a single decision, so relaxing any one of them fails a test that explains
// what it was holding rather than looking like a gap someone forgot to fill.

import { request } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDockerClient } from '../docker.js';
import { projectNetworkName } from '../provisioner.js';
import {
  parseServerDeploymentSpec,
  sealDeploymentSpec,
  type ServerDeploymentSpecBody,
} from './deployment-spec.js';
import {
  startUpdaterStatusServer,
  UPDATER_CONTROL_ROUTES,
  type UpdaterStatusServer,
} from './updater-status.js';

const specBody = (network: string): ServerDeploymentSpecBody => ({
  schemaVersion: 2,
  deploymentId: 'managed-1',
  image: `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`,
  environment: [{ name: 'DATABASE_URL', source: { kind: 'env', name: 'DATABASE_URL' } }],
  // The allowlist requires all three; a spec missing any of them is unparseable
  // for a reason that has nothing to do with the network.
  mounts: [
    { source: { kind: 'volume', name: 'verity-data' }, target: '/srv/verity', readOnly: false },
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
  network,
  platform: { os: 'linux', architecture: 'amd64' },
  security: { noNewPrivileges: true, readOnlyRootFilesystem: false, capAdd: ['CHOWN'] },
});

const servers: UpdaterStatusServer[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

async function controlSocket(): Promise<{ socketPath: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), 'verity-project-network-refusal-'));
  const managedRoot = join(root, 'managed-deployment');
  await mkdir(managedRoot, { mode: 0o700 });
  const socketPath = join(root, 'control', 'updater.sock');
  const token = 'a'.repeat(32);
  servers.push(
    await startUpdaterStatusServer({
      socketPath,
      token,
      managedRoot,
      onOperationAccepted: () => undefined,
    }),
  );
  return { socketPath, token };
}

/** One raw request against the control socket. The exported helpers in
 *  `updater-status.ts` are typed per route and therefore cannot ask for a route
 *  that does not exist, which is the only question here. */
function call(
  socketPath: string,
  token: string,
  method: string,
  path: string,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, method, path, headers: { authorization: `Bearer ${token}` } },
      (res) => {
        res.resume();
        res.once('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.once('error', reject);
    req.end();
  });
}

describe('a managed deployment refuses project networks', () => {
  it('rejects a correctly sealed spec that names a project network', () => {
    // Sealed, so the checksum is valid and the rejection can only come from the
    // network itself. Without this the test would pass for the wrong reason the
    // moment the pin were removed.
    const projectNetwork = projectNetworkName('11111111-1111-4111-8111-111111111111');
    expect(projectNetwork).not.toBe('verity-net');
    expect(parseServerDeploymentSpec(sealDeploymentSpec(specBody(projectNetwork)))).toBeNull();
    // The control: the same spec on the pinned network parses, so what is being
    // measured is the value and not the shape.
    expect(parseServerDeploymentSpec(sealDeploymentSpec(specBody('verity-net')))).not.toBeNull();
  });

  it('admits no route that could attach or detach a network', async () => {
    // The whole boundary rather than a list of names a network route might
    // plausibly have: a later `POST /v1/project-network/connect` changes this
    // set and fails here, where guessing at names would have stayed green.
    expect([...UPDATER_CONTROL_ROUTES]).toEqual([
      'GET /v1/deployment',
      // Reports what the startup reconcile concluded about the running Server:
      // `ok`, or `drift` with the sealed names that disagree. Reads a value the
      // Updater already computed and answers it; it joins nothing to anything.
      'GET /v1/reconcile',
      'GET /v1/update',
      'POST /v1/update',
      'GET /v1/handoff',
      'POST /v1/handoff',
      'POST /v1/handoff/envelope',
      'GET /v1/standby',
      'POST /v1/standby',
      // Reports what the host's agent seed says it was published from. Reads a
      // read-only mount and answers a stamp; it joins nothing to anything.
      'GET /v1/agent-seed',
      // Reports the control-plane database's image against the pin this release
      // was built with (ADR 0008 D14). Two image references, read and answered;
      // it attaches nothing to anything either.
      'GET /v1/postgres',
    ]);

    // And that list is what the listener enforces, which is what makes pinning
    // it worth anything. A valid token throughout: an unknown path is answered
    // before the bearer is checked, so the 404 is the boundary saying the verb
    // does not exist rather than the caller failing to authenticate.
    const { socketPath, token } = await controlSocket();
    expect((await call(socketPath, token, 'GET', '/v1/deployment')).status).not.toBe(404);
    expect(await call(socketPath, token, 'POST', '/v1/project-network')).toEqual({ status: 404 });
  });

  it('gives the Docker client no verb for joining a container to a network', () => {
    const client = createDockerClient({
      baseUrl: 'http://docker.invalid',
      // Reading the shape of the client issues no request; a transport that
      // throws keeps it that way.
      fetch: () => Promise.reject(new Error('this test never issues a Docker request')),
    });
    // `ensureNetwork` is the Server-side creation D2 always left with the
    // provisioner; it creates a network and puts nothing on one. Asserting it is
    // the only network verb catches the additions worth catching — a
    // `connectNetwork`, an `addContainerToNetwork` — where a list of forbidden
    // names would only catch the ones someone thought of. A membership call
    // named without `network` at all, or hidden inside an existing method, would
    // still get past this; the spec pin above is what stops it landing.
    expect(Object.keys(client).filter((verb) => /network/i.test(verb))).toEqual(['ensureNetwork']);
  });
});
