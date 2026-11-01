import { inspectEgressHostDirectTransport } from '../../../packages/server/src/project-egress-host-inspection.js';
import { createProjectEgressHostEnforcement } from '../../../packages/server/src/project-egress-host-enforcement.js';
import { hostProjectDeadlineEnforcer } from '../../../packages/server/src/project-egress-deadline.js';
import { inspectProjectFenceAttachment } from '../../../packages/server/src/project-egress-attachment.js';
import { projectFenceTable } from '../../../packages/server/src/project-egress-fence.js';
import { inspectEgressHostDirect } from '../../../packages/server/src/project-egress-host-runtime.js';
import { inspectEgressTransport } from '../../../packages/server/src/project-egress-transport.js';
import {
  createDockerProjectRelayStarter,
  projectRelayContainerName,
} from '../../../packages/server/src/project-relay-docker.js';
import {
  relaySocketMounts,
  type EgressRelayPolicy,
} from '../../../packages/server/src/project-egress-relay-policy.js';
import { createDockerClient, type ContainerSpec } from '../../../packages/server/src/docker.js';
import { createProjectEgressHostClient } from '../../../packages/server/src/project-egress-host-client.js';
import { ProjectEgressLifecycle } from '../../../packages/server/src/project-egress-lifecycle.js';
/** Deny-before-first-instruction fixture; no production daemon or credentials. */
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import {
  mkdtemp,
  readFile,
  writeFile,
  appendFile,
  rm,
  mkdir,
  chmod,
  chown,
} from 'node:fs/promises';
import {
  createServer as createNetServer,
  createConnection,
  type Server as NetServer,
} from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { inspect, promisify } from 'node:util';
import { appendFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import {
  ProjectEgressHost,
  projectEgressStartupRules,
  type ProjectEgressHostRequest,
} from '../../../packages/server/src/project-egress-host.js';
import {
  openProjectEgressHostStore,
  inspectEgressHostContainer,
  inspectEgressHostNetwork,
} from '../../../packages/server/src/project-egress-host-runtime.js';
import { listenProjectEgressHost } from '../../../packages/server/src/project-egress-host-control.js';
import { applyProjectFenceRules } from '../../../packages/server/src/project-egress-fence.js';
assert.equal(process.env.PROJECT_EGRESS_DISPOSABLE, 'yes');
class ProbeHost extends ProjectEgressHost {
  override execute(input: unknown) {
    return super.execute(input).catch((error: unknown) => {
      process.stderr.write(`Disposable host refusal: ${inspect(error, { depth: 5 })}\n`);
      throw error;
    });
  }
}
const exec = promisify(execFile);
// Disposable fixture management retains CLI operations; enforcement uses the actual API reader.
const docker = async (...args: string[]) =>
  (
    await exec('/usr/bin/docker', args, {
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DOCKER_HOST: 'unix:///var/run/docker.sock' },
    })
  ).stdout;
let packetCapture: ReturnType<typeof spawn> | undefined;
let bridge = '';
let generationNetwork = '';
const directory = await mkdtemp('/tmp/egress-host-');
const token = randomBytes(32).toString('hex');
const store = await openProjectEgressHostStore(directory);
let relayPolicy: EgressRelayPolicy | undefined;
const starts: string[] = [];
const composedTargets = ['11.77.106.2', '2001:4860:feed:106::2'];
let directEnabled = true;
let deadlineHelper: ReturnType<typeof hostProjectDeadlineEnforcer>;
function createEnforcement() {
  deadlineHelper = hostProjectDeadlineEnforcer((timing) => {
    appendFileSync('/evidence/worker-timings.jsonl', JSON.stringify(timing) + '\n');
  });
  return createProjectEgressHostEnforcement({
    deadline: deadlineHelper,
    sponsor: () => 'fixture-sponsor',
    directAuthority: () => true,
    store: {
      readForAdmission: (projectId, sponsor) => {
        assert.equal(projectId, 'host-smoke');
        assert.equal(sponsor, 'fixture-sponsor');
        return Promise.resolve({
          revision: 1,
          requests: {},
          grants: directEnabled
            ? composedTargets.flatMap((host) =>
                [
                  { host, protocol: 'tcp' as const, port: 443 },
                  { host, protocol: 'udp' as const, port: 8080 },
                ].map((target) => ({
                  id: `${target.host}-${target.protocol}`,
                  target,
                  approvedAt: 0,
                  approvedBy: 'fixture-manager',
                  expiresAt: null,
                })),
              )
            : [],
        });
      },
    },
    inspect: inspectEgressHostDirect,
    dependencies: {
      observe: (stage, durationMs) =>
        appendFileSync(
          '/evidence/renewal-stages.jsonl',
          JSON.stringify({ stage, durationMs }) + '\n',
        ),
      inspect: inspectProjectFenceAttachment,
      apply: applyProjectFenceRules,
      directTargetAllowed: (host) => Promise.resolve(composedTargets.includes(host)),
      destinationAllowed: (address) => Promise.resolve(composedTargets.includes(address)),
      resolve: () => Promise.reject(new Error('Exact address fixture')),
      existing: async (binding) => {
        const rules = await exec('/usr/sbin/nft', ['-j', 'list', 'tables']);
        return (
          JSON.parse(rules.stdout) as { nftables: { table?: { family: string; name: string } }[] }
        ).nftables.some(
          (item) => item.table?.family === 'inet' && item.table.name === projectFenceTable(binding),
        );
      },
    },
  });
}
const dependencies = {
  enforcement: createEnforcement(),
  inspectDirectTransport: async (
    binding: Parameters<typeof inspectEgressHostDirectTransport>[0],
    ids: Parameters<typeof inspectEgressHostDirectTransport>[1],
  ) => {
    if (!relayPolicy) throw new Error('Missing relay policy');
    const started = performance.now();
    try {
      return await inspectEgressHostDirectTransport(binding, ids, relayPolicy);
    } finally {
      await appendFile(
        '/evidence/renewal-stages.jsonl',
        JSON.stringify({ stage: 'host-inspection', durationMs: performance.now() - started }) +
          '\n',
      );
    }
  },
  inspectTransport: (
    binding: Parameters<typeof inspectEgressTransport>[0],
    ids: Parameters<typeof inspectEgressTransport>[1],
  ) =>
    inspectEgressTransport(binding, ids, relayPolicy?.codexSubpath !== undefined).catch(
      async (error: unknown) => {
        process.stderr.write(`Transport inspection failed: ${String(error)}\n`);
        await writeFile('/evidence/transport-inspection-error.txt', String(error));
        throw error;
      },
    ),
  save: (state: Parameters<typeof store.save>[0]) => store.save(state),
  apply: async (script: string) => {
    try {
      await applyProjectFenceRules(script);
    } catch (error) {
      process.stderr.write(`Kernel transaction failed: ${String(error)}\n`);
      await writeFile('/evidence/transport-kernel-error.txt', String(error));
      await writeFile('/evidence/transport-kernel-error.nft', script);
      await writeFile(
        '/evidence/transport-kernel-check.txt',
        await exec('/usr/sbin/nft', ['--check', '-f', '/evidence/transport-kernel-error.nft'])
          .then((reply) => reply.stdout)
          .catch(String),
      );
      throw error;
    }
  },
  inspectNetwork: inspectEgressHostNetwork,
  inspectContainer: async (
    binding: Parameters<typeof inspectEgressHostContainer>[0],
    id: string,
    role: 'sandbox' | 'relay',
  ) => {
    try {
      await inspectEgressHostContainer(binding, id, role, relayPolicy);
    } catch (error) {
      // This fixture contains no credentials; retain daemon facts before rollback removes them.
      process.stderr.write(`Host inspection refused: ${String(error)}\n`);
      await (async () => {
        await writeFile(
          `/evidence/inspect-${id}.json`,
          JSON.stringify(
            {
              role,
              error: String(error),
              container: JSON.parse(await docker('inspect', id)) as unknown,
            },
            null,
            2,
          ),
        );
      })().catch(() => undefined);
      throw error;
    }
  },
  startContainer: async (id: string) => {
    starts.push(id);
    try {
      await docker('start', id);
    } catch (error) {
      process.stderr.write(`Host start failed: ${String(error)}\n`);
      await writeFile(`/evidence/start-${id}.txt`, String(error)).catch(() => undefined);
      throw error;
    }
  },
  stopContainer: async (id: string) => {
    await docker('stop', '--time', '1', id);
  },
};
let server: Server | undefined;
const socketServers: (Server | NetServer)[] = [];
let relayName = '';
const volumeName = 'veh-relay-data';
const extraNetworks: string[] = [];
const extraContainers: string[] = [];
const results: string[] = [];
try {
  for (const [name, subnet] of [['veh-receiver', '172.30.105.0/24']])
    await docker(
      'network',
      'create',
      '--ipv6',
      '--subnet',
      subnet!,
      '--subnet',
      name === bridge ? 'fd42:feed:4::/64' : 'fd42:feed:5::/64',
      '--opt',
      `com.docker.network.bridge.name=${name}`,
      '--opt',
      'com.docker.network.bridge.gateway_mode_ipv4=nat-unprotected',
      '--opt',
      'com.docker.network.bridge.gateway_mode_ipv6=nat-unprotected',
      '--opt',
      'com.docker.network.bridge.enable_ip_masquerade=false',
      name!,
    );
  const emitter = `import socket,time\ns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\nprint('sending',flush=True)\nwhile True:\n s.sendto(b'host-startup-marker',('172.30.105.2',8080))\n time.sleep(0.01)\n`;
  await docker(
    'run',
    '-d',
    '--name',
    'veh-receiver',
    '--network',
    'veh-receiver',
    '--ip',
    '172.30.105.2',
    '--ip6',
    'fd42:feed:5::2',
    '--mount',
    'type=bind,src=/probe,dst=/probe,readonly',
    '--memory',
    '128m',
    '--pids-limit',
    '64',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--entrypoint',
    'python3',
    'project-egress-fixture:local',
    '-u',
    '/probe/transport-receiver.py',
  );
  for (let i = 0; i < 50 && !(await docker('logs', 'veh-receiver')).includes('ready'); i++)
    await delay(100);
  assert.ok((await docker('logs', 'veh-receiver')).includes('ready'));
  const host = new ProbeHost(await store.load(), dependencies);
  await host.restore();
  server = await listenProjectEgressHost({ directory, token, controller: host });
  const send = (body: ProjectEgressHostRequest) =>
    new Promise<number>((resolve, reject) => {
      const call = request(
        {
          socketPath: `${directory}/control.sock`,
          method: 'POST',
          path: '/v1/command',
          headers: { authorization: `Bearer ${token}` },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode!));
        },
      );
      call.on('error', reject);
      call.end(JSON.stringify(body));
    });
  const command = createProjectEgressHostClient({
    socketPath: `${directory}/control.sock`,
    token,
    timeoutMs: 30000,
  });
  const lifecycle = new ProjectEgressLifecycle(
    command,
    createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' }),
    false,
  );
  const identity = { projectId: 'host-smoke', containerGeneration: 'gen1' };
  const binding = await lifecycle.create(identity);
  bridge = binding.bridge;
  generationNetwork = binding.networkName;
  assert.deepEqual(await lifecycle.prepare(identity), binding);
  await exec('iptables', [
    '-I',
    'FORWARD',
    '1',
    '-i',
    bridge,
    '-o',
    'veh-receiver',
    '-j',
    'ACCEPT',
  ]);
  const rejectedId = (
    await docker(
      'create',
      '--name',
      'veh-unsupported',
      '--runtime',
      'runc',
      '--restart',
      'no',
      '--network',
      generationNetwork,
      '--cap-drop',
      'ALL',
      '--entrypoint',
      'python3',
      'project-egress-fixture:local',
      '-u',
      '-c',
      emitter,
    )
  ).trim();
  assert.equal(
    await send({
      operation: 'start',
      projectId: binding.projectId,
      generation: binding.generation,
      role: 'sandbox',
      containerId: rejectedId,
    }),
    409,
  );
  assert.equal(
    (await docker('inspect', '--format', '{{.State.Running}}', rejectedId)).trim(),
    'false',
  );
  await docker('rm', rejectedId);
  results.push('ordinary Docker runtime refused before embedded DNS can execute');
  // Production runtime ownership, with host-only control state kept outside mounts.
  const runtime = `${directory}/runtime`;
  const worktree = `${directory}/worktree`;
  for (const [path, uid, gid, mode] of [
    [runtime, 1000, 1101, 0o170],
    [worktree, 1000, 1000, 0o750],
  ] as const) {
    await mkdir(path);
    await chown(path, uid, gid);
    await chmod(path, mode);
  }
  const supervisorRequest = (body: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = createConnection(`${runtime}/supervisor.sock`);
      let data = '';
      socket.setTimeout(5000, () => socket.destroy(new Error('supervisor timeout')));
      socket.on('error', reject);
      socket.on('connect', () =>
        socket.write(`${JSON.stringify({ protocolVersion: 1, ...body })}\n`),
      );
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          socket.destroy();
          try {
            const reply: unknown = JSON.parse(data.split('\n')[0]!);
            assert.ok(reply && typeof reply === 'object' && !Array.isArray(reply));
            resolve(reply as Record<string, unknown>);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
    });
  const containerId = (
    await docker(
      'create',
      '--name',
      'veh-source',
      '--runtime',
      'runsc-project',
      '--restart',
      'no',
      '--network',
      generationNetwork,
      '--memory',
      '768m',
      '--pids-limit',
      '256',
      '--cap-drop',
      'ALL',
      ...['CHOWN', 'SETUID', 'SETGID', 'KILL', 'SETPCAP'].flatMap((cap) => ['--cap-add', cap]),
      '--security-opt',
      'no-new-privileges=true',
      '--user',
      '0:1101',
      '--mount',
      `type=bind,src=${runtime},dst=/run/verity-runner`,
      '--mount',
      `type=bind,src=${worktree},dst=/work`,
      '--mount',
      'type=bind,src=/probe,dst=/probe,readonly',
      '-e',
      'PROJECT_EGRESS_DISPOSABLE=yes',
      '--entrypoint',
      '/bin/bash',
      'project-egress-runner:local',
      '/probe/runner-entrypoint.sh',
    )
  ).trim();
  await lifecycle.start(identity, 'sandbox', containerId);
  let status: Record<string, unknown> | undefined;
  for (let i = 0; i < 120; i++) {
    status = await supervisorRequest({ kind: 'status' }).catch(() => undefined);
    if (status?.ok === true) break;
    await delay(250);
  }
  assert.equal(status?.ok, true, await docker('logs', 'veh-source'));
  assert.equal(status?.persistentSessionHomes, true);
  assert.equal(
    (await supervisorRequest({ kind: 'prepare-session-home', sessionId: 'egress-probe' })).ok,
    true,
  );
  results.push('actual Runner supervisor and session-home broker answer through mounted socket');
  await docker('volume', 'create', volumeName);
  const dataRoot = (
    await docker('volume', 'inspect', '--format', '{{.Mountpoint}}', volumeName)
  ).trim();
  relayPolicy = {
    image: (
      await docker('image', 'inspect', '--format', '{{.Id}}', 'project-egress-relay:local')
    ).trim(),
    dataVolume: volumeName,
    socketOwnerUid: 0,
    relayGid: 65532,
    brokerSubpath: 'broker',
    claudeSubpath: 'claude',
    codexSubpath: 'codex',
  };
  let brokerRequests = 0;
  const receipts: Record<string, number[]> = {
    'broker.sock': [],
    'claude.sock': [],
    'codex.sock': [],
  };
  const sockets = relaySocketMounts(binding, relayPolicy);
  for (const item of sockets) {
    const path = `${dataRoot}/${item.subpath}`;
    await mkdir(path, { recursive: true });
    await chown(path, 0, 65532);
    await chmod(path, 0o710);
    const listener =
      item.socket === 'broker.sock'
        ? createServer((request, response) => {
            brokerRequests++;
            if (request.url === '/internal/mcp-proxy') {
              response.writeHead(200, { 'content-type': 'text/event-stream' });
              const timer = setInterval(() => response.write('transport-stream-marker\n'), 50);
              response.once('close', () => clearInterval(timer));
            } else response.end('project-bound-fixture');
          })
        : createNetServer((socket) => {
            socket.on('error', () => undefined);
            socket.on('data', (data) => {
              if (data.includes('transport-stream-marker')) receipts[item.socket]!.push(Date.now());
              else socket.write(item.socket);
            });
          });
    socketServers.push(listener);
    await new Promise<void>((resolve) => listener.listen(`${path}/${item.socket}`, resolve));
    await chown(`${path}/${item.socket}`, 0, 65532);
    await chmod(`${path}/${item.socket}`, 0o660);
  }
  const relayOptions = {
    docker: createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' }),
    image: relayPolicy.image,
    dataVolume: volumeName,
    dataVolumeRoot: dataRoot,
    brokerSocketRoot: `${dataRoot}/broker`,
    claudeSocketRoot: `${dataRoot}/claude`,
    codexSocketRoot: `${dataRoot}/codex`,
    socketOwnerUid: 0,
    relayGid: 65532,
    projectNetwork: () => generationNetwork,
  };
  let relaySpec: ContainerSpec | undefined;
  const startRelay = createDockerProjectRelayStarter({
    ...relayOptions,
    docker: {
      ...relayOptions.docker,
      createContainer: async (spec) => {
        relaySpec = structuredClone(spec);
        return relayOptions.docker.createContainer(spec);
      },
    },
  });
  const context = {
    identity,
    egress: lifecycle,
    brokerSocketPath: `${dataRoot}/${sockets[0]!.subpath}/broker.sock`,
    claudeSocketPath: `${dataRoot}/${sockets[1]!.subpath}/claude.sock`,
    codexSocketPath: `${dataRoot}/${sockets[2]!.subpath}/codex.sock`,
  };
  const badSpecs: [string, (spec: ContainerSpec) => ContainerSpec][] = [
    ['sandbox-profile', (spec) => ({ ...spec, runtime: 'runsc-project' })],
    ['root-user', (spec) => ({ ...spec, user: '0:0' })],
    ['mutable-image-reference', (spec) => ({ ...spec, image: 'project-egress-relay:local' })],
    [
      'extra-runner-mount',
      (spec) => ({
        ...spec,
        volumeMounts: [
          ...spec.volumeMounts!,
          {
            volume: volumeName,
            target: '/run/verity-runner',
            subpath: sockets[0]!.subpath,
            readOnly: true,
          },
        ],
      }),
    ],
    [
      'foreign-generation',
      (spec) => ({
        ...spec,
        volumeMounts: spec.volumeMounts!.map((mount, i) =>
          i === 0 ? { ...mount, subpath: sockets[1]!.subpath } : mount,
        ),
      }),
    ],
  ];
  for (const [name, mutate] of badSpecs) {
    let created = '';
    const badStarter = createDockerProjectRelayStarter({
      ...relayOptions,
      docker: {
        ...relayOptions.docker,
        createContainer: async (spec) => {
          const value = await relayOptions.docker.createContainer(mutate(spec));
          created = value.id;
          return value;
        },
      },
    });
    await assert.rejects(badStarter(context), undefined, name);
    assert.ok(created, `${name} must reach actual Docker creation`);
    assert.ok(!starts.includes(created), `${name} must fail before process start`);
  }
  results.push('profile, user, image and mount substitutions refused before actual process start');
  // Loopback reaches the actual relay without adding any network admission rule.
  const relayProbe = `const h=require('node:http');const r=h.request({host:'127.0.0.1',port:8080,method:'POST',path:'/internal/project/memory'},s=>{let b='';s.on('data',c=>b+=c);s.on('end',()=>{console.log(JSON.stringify({status:s.statusCode,body:b}));});});r.setTimeout(3000,()=>r.destroy());r.on('error',()=>process.exit(1));r.end();`;
  const probeRelay = async (id: string) => {
    let reply = '';
    for (let i = 0; i < 40; i++) {
      reply = await docker('exec', id, '/nodejs/bin/node', '-e', relayProbe).catch((error) =>
        String(error),
      );
      if (reply.includes('project-bound-fixture')) return;
      if ((await docker('inspect', '--format', '{{.State.Running}}', id)).trim() !== 'true') break;
      await delay(250);
    }
    throw new Error(`actual relay UDS positive control failed: ${reply}`);
  };
  relayName = projectRelayContainerName(identity);
  let relayId = '';
  try {
    await startRelay(context);
    relayId = (await docker('inspect', '--format', '{{.Id}}', relayName)).trim();
    await probeRelay(relayId);
  } catch (originalError) {
    // Diagnostic clones are never an acceptance fallback. They keep the already-denied
    // network and exact image/mounts; the normal host start failure still fails this job.
    const diagnosticSpec = relaySpec;
    await (async () => {
      if (diagnosticSpec) {
        await mkdir('/evidence/runsc-debug', { recursive: true });
        await mkdir('/evidence/runsc-panic', { recursive: true });
        for (const pidsLimit of [32, 64]) {
          const diagnostic = await relayOptions.docker.createContainer({
            ...diagnosticSpec,
            name: `veh-relay-diagnostic-${pidsLimit}`,
            runtime: 'runsc-relay-debug',
            pidsLimit,
          });
          extraContainers.push(diagnostic.id);
          let error: string | undefined;
          try {
            await docker('start', diagnostic.id);
            await probeRelay(diagnostic.id);
          } catch (failure) {
            error = String(failure);
          }
          await writeFile(
            `/evidence/diagnostic-${pidsLimit}.json`,
            JSON.stringify(
              {
                error,
                container: JSON.parse(await docker('inspect', diagnostic.id)) as unknown,
                logs: await docker('logs', diagnostic.id).catch(() => 'unavailable'),
              },
              null,
              2,
            ),
          );
          await docker('rm', '-f', diagnostic.id);
        }
      }
    })().catch((error) => {
      process.stderr.write(`Diagnostic capture failed: ${String(error)}\n`);
    });
    throw originalError;
  }
  assert.ok(brokerRequests > 0);
  for (const [port, name] of [
    [8443, 'claude.sock'],
    [8444, 'codex.sock'],
  ] as const) {
    const probe = `const s=require('node:net').connect(${port},'127.0.0.1',()=>s.write('probe'));s.setTimeout(3000,()=>s.destroy(new Error('timeout')));s.on('data',d=>{console.log(d.toString());s.destroy()});s.on('error',()=>process.exit(1));`;
    assert.ok((await docker('exec', relayId, '/nodejs/bin/node', '-e', probe)).includes(name));
  }
  const udsIdentity = { projectId: 'uds-open-negative', containerGeneration: 'gen1' };
  const udsBinding = await lifecycle.create(udsIdentity);
  extraNetworks.push(udsBinding.networkName);
  const udsProbe = `const fs=require('node:fs');const p='/probe-broker/broker.sock';if(!fs.statSync(p).isSocket())process.exit(2);const s=require('node:net').connect(p,()=>process.exit(1));s.setTimeout(3000,()=>process.exit(3));s.on('error',()=>{console.log('sandbox-uds-open-denied');process.exit(0)});`;
  const udsId = (
    await docker(
      'create',
      '--runtime',
      'runsc-project',
      '--network',
      udsBinding.networkName,
      '--restart',
      'no',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--memory',
      '128m',
      '--pids-limit',
      '64',
      '--user',
      '65532:65532',
      '--mount',
      `type=volume,src=${volumeName},dst=/probe-broker,volume-subpath=${sockets[0]!.subpath},readonly`,
      '--entrypoint',
      '/nodejs/bin/node',
      relayPolicy.image,
      '-e',
      udsProbe,
    )
  ).trim();
  extraContainers.push(udsId);
  await lifecycle.start(udsIdentity, 'sandbox', udsId);
  assert.equal((await docker('wait', udsId)).trim(), '0', await docker('logs', udsId));
  assert.ok((await docker('logs', udsId)).includes('sandbox-uds-open-denied'));
  await lifecycle.retire(udsIdentity);
  results.push('Sandbox can see an injected broker socket but cannot open it');
  const relayAddress = await lifecycle.connect(identity);
  const client = async (mode: string, address = relayAddress, port?: number) =>
    docker(
      'exec',
      '--user',
      '1000:1000',
      containerId,
      'python3',
      '/probe/transport-client.py',
      address,
      mode,
      ...(port === undefined ? [] : [String(port)]),
    );
  assert.ok((await client('positive')).includes('transport-positive'));
  const rawSocket =
    'import socket; s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.htons(0x800)); s.close()';
  await exec('python3', ['-c', rawSocket]);
  await assert.rejects(
    docker('exec', '--user', '1000:1000', containerId, 'python3', '-c', rawSocket),
  );
  results.push(
    'project process cannot forge Ethernet/IP frames; host raw-socket positive control succeeds',
  );
  const foreignIdentity = { projectId: 'foreign-project', containerGeneration: 'gen1' };
  const foreignBinding = await lifecycle.create(foreignIdentity);
  extraNetworks.push(foreignBinding.networkName);
  const foreignId = (
    await docker(
      'create',
      '--runtime',
      'runsc-project',
      '--network',
      foreignBinding.networkName,
      '--restart',
      'no',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--memory',
      '128m',
      '--pids-limit',
      '64',
      '--user',
      '65532:65532',
      '--mount',
      'type=bind,src=/probe,dst=/probe,readonly',
      '--entrypoint',
      'python3',
      'project-egress-fixture:local',
      '-u',
      '/probe/transport-receiver.py',
    )
  ).trim();
  extraContainers.push(foreignId);
  await lifecycle.start(foreignIdentity, 'sandbox', foreignId);
  for (let i = 0; i < 50 && !(await docker('logs', foreignId)).includes('ready'); i++)
    await delay(100);
  assert.ok((await docker('logs', foreignId)).includes('ready'));
  const foreignAddress = (
    await docker(
      'inspect',
      '--format',
      `{{(index .NetworkSettings.Networks "${foreignBinding.networkName}").IPAddress}}`,
      foreignId,
    )
  ).trim();
  await docker(
    'exec',
    foreignId,
    'python3',
    '-c',
    "import socket; s=socket.create_connection(('127.0.0.1',8080),timeout=2);s.sendall(b'foreign-positive');assert s.recv(100)==b'external-positive';s.close()",
  );
  assert.ok((await client('negative', foreignAddress, 8080)).includes('transport-denied'));
  assert.ok((await docker('logs', foreignId)).includes('foreign-positive'));
  await lifecycle.retire(foreignIdentity);
  results.push(
    'foreign registered generation is unreachable despite a successful receiver control',
  );

  for (const port of [53])
    assert.ok((await client('negative', relayAddress, port)).includes('transport-denied'));
  await docker(
    'exec',
    '--user',
    '1000:1000',
    containerId,
    'python3',
    '/probe/transport-client.py',
    relayAddress,
    'external',
    'negative',
  );
  assert.ok(!(await docker('logs', 'veh-receiver')).includes('external-'));
  results.push('project UID reaches only the bound broker/model TCP ports over the actual bridge');
  const refreshBrokerReceipts = async () => {
    const raw = await readFile(`${worktree}/broker-receipts`, 'utf8').catch(() => '');
    receipts['broker.sock'] = raw.trim().split('\n').filter(Boolean).map(Number);
  };
  const stream = async (phase: string) => {
    await writeFile(`${worktree}/broker-receipts`, '');
    await chown(`${worktree}/broker-receipts`, 1000, 1000);
    for (const values of Object.values(receipts)) values.length = 0;
    await docker(
      'exec',
      '-d',
      '--user',
      '1000:1000',
      containerId,
      'python3',
      '/probe/transport-client.py',
      relayAddress,
      'stream',
      phase,
    );
    for (let i = 0; i < 80 && !Object.values(receipts).every((values) => values.length >= 2); i++) {
      await delay(100);
      await refreshBrokerReceipts();
    }
    assert.ok(
      Object.values(receipts).every((values) => values.length >= 2),
      'every retained transport must be observed before revocation',
    );
  };
  const revokeAndMeasure = async (revoke: () => Promise<unknown>, phase: string) => {
    await stream(phase);
    const begin = Date.now();
    await revoke();
    await delay(2100);
    await refreshBrokerReceipts();
    const closure = Object.fromEntries(
      Object.entries(receipts).map(([name, values]) => [
        name,
        Math.max(0, values.at(-1)! - begin) / 1000,
      ]),
    );
    assert.ok(
      Object.values(closure).every((seconds) => seconds <= 2),
      JSON.stringify(closure),
    );
    await writeFile(`/evidence/transport-closure-${phase}.json`, JSON.stringify(closure));
  };
  const verifyNoRevival = async (phase: string) => {
    await refreshBrokerReceipts();
    const before = Object.fromEntries(
      Object.entries(receipts).map(([name, values]) => [name, values.length]),
    );
    await lifecycle.connect(identity);
    assert.ok((await client('positive')).includes('transport-positive'));
    await delay(2500);
    await refreshBrokerReceipts();
    const after = Object.fromEntries(
      Object.entries(receipts).map(([name, values]) => [name, values.length]),
    );
    assert.deepEqual(
      after,
      before,
      'revoked streams must not revive when fresh connections are admitted',
    );
    const heartbeat = Number(await readFile(`${worktree}/stream-alive-${phase}`, 'utf8'));
    assert.ok(
      Date.now() - heartbeat < 1000,
      'original stream client must still be attempting traffic',
    );
    await writeFile(
      `/evidence/transport-no-revival-${phase}.json`,
      JSON.stringify({ before, after, heartbeat }),
    );
  };
  await revokeAndMeasure(() => lifecycle.prepare(identity), 'prepare');
  assert.ok((await client('negative', relayAddress, 8080)).includes('transport-denied'));
  await verifyNoRevival('prepare');
  results.push(
    'actual relay forwards broker and model sockets after explicit denied-state revalidation',
  );

  await delay(2000);
  assert.ok((await docker('logs', 'veh-source')).includes('sending'));
  assert.ok((await docker('logs', 'veh-source')).includes('transferred-socket-ready'));
  assert.ok(!(await docker('logs', 'veh-receiver')).includes('transferred-startup-marker'));
  assert.ok(!(await docker('logs', 'veh-receiver')).includes('host-startup-marker'));
  results.push('no receiver observation during Runner/relay startup and denied-state revalidation');
  // Compose the actual startup, direct nft and TC paths, with an independent receiver.
  await docker(
    'network',
    'create',
    '--ipv6',
    '--subnet',
    '11.77.106.0/24',
    '--subnet',
    '2001:4860:feed:106::/64',
    '--opt',
    'com.docker.network.bridge.name=veh-direct',
    '--opt',
    'com.docker.network.bridge.gateway_mode_ipv4=nat-unprotected',
    '--opt',
    'com.docker.network.bridge.gateway_mode_ipv6=nat-unprotected',
    '--opt',
    'com.docker.network.bridge.enable_ip_masquerade=false',
    'veh-direct',
  );
  extraNetworks.push('veh-direct');
  await docker(
    'run',
    '-d',
    '--name',
    'veh-direct',
    '--network',
    'veh-direct',
    '--ip',
    composedTargets[0]!,
    '--ip6',
    composedTargets[1]!,
    '--mount',
    'type=bind,src=/probe,dst=/probe,readonly',
    '--memory',
    '128m',
    '--pids-limit',
    '64',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--entrypoint',
    'python3',
    'project-egress-fixture:local',
    '-u',
    '/probe/composed-receiver.py',
  );
  extraContainers.push('veh-direct');
  for (let i = 0; i < 50 && !(await docker('logs', 'veh-direct')).includes('ready'); i++)
    await delay(100);
  assert.ok((await docker('logs', 'veh-direct')).includes('ready'));
  for (const command of ['iptables', 'ip6tables'])
    for (const [source, target] of [
      [bridge, 'veh-direct'],
      ['veh-direct', bridge],
    ])
      await exec(command, ['-I', 'FORWARD', '1', '-i', source!, '-o', target!, '-j', 'ACCEPT']);
  const beginRenewal = async () => {
    await rm(`${directory}/renewal-ready`, { force: true });
    const child = spawn(process.execPath, ['/probe/composed-renewal.mjs'], {
      env: { ...process.env, PROBE_CONTROL_DIRECTORY: directory, PROBE_CONTROL_TOKEN: token },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    for (let i = 0; i < 100; i++) {
      if ((await readFile(`${directory}/renewal-ready`, 'utf8').catch(() => '')) === 'ready') break;
      assert.equal(child.exitCode, null, 'Renewal process exited before readiness');
      await delay(50);
    }
    assert.equal(await readFile(`${directory}/renewal-ready`, 'utf8'), 'ready');
    return async () => {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      assert.ok(child.kill('SIGKILL'));
      await exited;
    };
  };
  packetCapture = spawn(
    '/usr/bin/tcpdump',
    ['-i', bridge, '-U', '-s', '256', '-w', '/evidence/composed-packets.pcap'],
    { stdio: 'ignore' },
  );
  await new Promise<void>((resolve, reject) => {
    packetCapture!.once('spawn', resolve);
    packetCapture!.once('error', reject);
  });
  const directCases: {
    phase: string;
    family: number;
    expected: boolean;
    observed: boolean;
    resolution?: {
      phase: string;
      family: number;
      terminal: string;
      hostBeforeNs: string;
      hostAfterNs: string;
    };
  }[] = [];
  const directProbe = async (phase: string, expected: boolean) => {
    const stop = expected ? await beginRenewal() : undefined;
    try {
      for (const [family, target] of composedTargets.entries()) {
        const before = phase === 'before-admission' ? await deadlineHelper!.clock() : undefined;
        const output = await docker(
          'exec',
          '--user',
          '1000:1000',
          containerId,
          'python3',
          '/probe/composed-client.py',
          target,
          `${phase}-${family}`,
          expected ? 'positive' : 'negative',
        );
        let resolution;
        if (before) {
          const after = await deadlineHelper!.clock();
          const result = JSON.parse(output.trim()) as {
            phase: string;
            family: number;
            terminal: string;
          };
          assert.equal(result.phase, `${phase}-${family}`);
          assert.equal(result.family, family === 0 ? 4 : 6);
          assert.equal(result.terminal, 'EHOSTUNREACH');
          resolution = {
            ...result,
            hostBeforeNs: before.bootBeforeNs,
            hostAfterNs: after.bootAfterNs,
          };
        }
        const log = await docker('logs', 'veh-direct');
        const observed =
          log.includes(`${phase}-${family}-tcp`) && log.includes(`${phase}-${family}-udp`);
        assert.equal(observed, expected, `${phase}/${family}`);
        if (!expected) assert.ok(!log.includes(`${phase}-${family}-`));
        directCases.push({
          phase,
          family,
          expected,
          observed,
          ...(resolution ? { resolution } : {}),
        });
      }
    } finally {
      await stop?.();
    }
  };
  await directProbe('before-admission', false);
  await directProbe('admitted', true);
  const kernelComparison = await exec('/usr/bin/python3', ['/probe/kernel-read-proof.py']);
  await writeFile('/evidence/kernel-read-comparison.json', kernelComparison.stdout);
  // Stopping renewal must close direct access while the independent relay stays usable.
  await delay(1200);
  await directProbe('lease-expired', false);
  assert.ok((await client('positive', relayAddress)).includes('transport-positive'));
  const stopRenewalProcess = await beginRenewal();
  await docker(
    'exec',
    '-d',
    '--user',
    '1000:1000',
    containerId,
    'python3',
    '/probe/composed-client.py',
    composedTargets[0]!,
    'stream',
    'stream',
  );
  for (let i = 0; i < 20 && !(await docker('logs', 'veh-direct')).includes('stream-retained'); i++)
    await delay(20);
  assert.ok((await docker('logs', 'veh-direct')).includes('stream-retained'));
  const actualBinding = (
    await inspectEgressHostDirect(binding, { sandbox: containerId, relay: relayId })
  ).corridor.binding;
  const kernel = async (containment = false) =>
    JSON.parse(
      (
        await exec('/usr/bin/python3', [
          '/probe/deadline-observe.py',
          JSON.stringify(actualBinding),
          ...(containment ? ['--containment'] : []),
        ])
      ).stdout,
    ) as {
      deadline_ns: string;
      accepted: number;
      denied: number;
      last_accepted_boot_ns: string;
      clocks: { bootBeforeNs: string };
      containers: { Id: string; State: { Running: boolean } }[] | null;
      state: { binding: { containerId: string }; relayRegistration: { containerId: string } };
    };
  // Keep the same retained TCP flow live across multiple kernel-checked renewals.
  await delay(2200);
  await stopRenewalProcess();
  const retainedReceipts = (await docker('logs', 'veh-direct'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { marker?: string; boot_ns?: string })
    .filter((row) => row.marker === 'stream-retained');
  assert.ok(retainedReceipts.length > 5);
  assert.ok(
    BigInt(retainedReceipts.at(-1)!.boot_ns!) - BigInt(retainedReceipts[0]!.boot_ns!) >=
      2_000_000_000n,
  );
  const live = await kernel();
  await delay(1300);
  const expired = await kernel();
  await delay(300);
  const attempted = await kernel();
  assert.ok(BigInt(expired.clocks.bootBeforeNs) >= BigInt(live.deadline_ns));
  assert.equal(expired.accepted, attempted.accepted);
  assert.ok(attempted.denied > expired.denied);
  assert.ok(BigInt(attempted.last_accepted_boot_ns) < BigInt(live.deadline_ns));
  // gVisor's BOOTTIME has its own origin. Compare counters after a host-clock
  // barrier instead of comparing the guest's absolute timestamp to a host lease.
  const lateBarrier = BigInt(live.deadline_ns) + 2_000_000_000n;
  await delay(
    Math.max(
      0,
      Math.ceil(Number(lateBarrier - BigInt(attempted.clocks.bootBeforeNs)) / 1_000_000),
    ) + 20,
  );
  const heartbeatWindowStart = await kernel();
  assert.ok(BigInt(heartbeatWindowStart.clocks.bootBeforeNs) > lateBarrier);
  const readHeartbeat = async () =>
    JSON.parse(await readFile(`${worktree}/composed-stream.json`, 'utf8')) as {
      attempts: number;
      boot_ns: string;
    };
  const beforeHeartbeat = await readHeartbeat();
  await delay(300);
  const heartbeat = await readHeartbeat();
  const heartbeatWindowEnd = await kernel();
  assert.ok(heartbeat.attempts > 10 && heartbeat.attempts > beforeHeartbeat.attempts);
  assert.ok(BigInt(heartbeat.boot_ns) > BigInt(beforeHeartbeat.boot_ns));
  await directProbe('fresh-after-expiry', true);
  await lifecycle.revokeDirect(identity);
  await directProbe('direct-revoked', false);
  assert.ok((await client('positive', relayAddress)).includes('transport-positive'));
  directEnabled = false;
  await lifecycle.refreshDirect(identity);
  await directProbe('authority-empty', false);
  directEnabled = true;
  await delay(2500);
  await writeFile(
    '/evidence/composed-stream-proof.json',
    JSON.stringify({
      live,
      expired,
      attempted,
      heartbeat,
      heartbeatBefore: beforeHeartbeat,
      heartbeatWindowStart,
      heartbeatWindowEnd,
    }),
  );

  await writeFile(
    '/evidence/composed-result.json',
    JSON.stringify({ complete: true, cases: directCases }),
  );
  results.push(
    'actual startup/TC/nft composition admits only current direct grants and retains the relay after direct expiry/revoke',
  );
  // Kill the actual resident helper while a separate Server continues requesting renewals.
  const stopAfterHelperFailure = await beginRenewal();
  await docker(
    'exec',
    '-d',
    '--user',
    '1000:1000',
    containerId,
    'python3',
    '/probe/composed-client.py',
    composedTargets[0]!,
    'helper',
    'stream',
  );
  for (let i = 0; i < 20 && !(await docker('logs', 'veh-direct')).includes('helper-retained'); i++)
    await delay(20);
  assert.ok((await docker('logs', 'veh-direct')).includes('helper-retained'));

  const children = (await readFile(`/proc/self/task/${process.pid}/children`, 'utf8'))
    .trim()
    .split(/\s+/u);
  const helpers: { pid: number; command: string }[] = [];
  for (const pid of children) {
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    if (command.includes('/opt/verity-egress/project-egress-deadline.py\0--worker'))
      helpers.push({ pid: Number(pid), command });
  }
  assert.equal(helpers.length, 1, 'Exactly one actual resident deadline helper must be present');
  const helperBeforeKill = await kernel();
  process.kill(helpers[0]!.pid, 'SIGKILL');
  const helperLive = await kernel(true);
  const helperAfterKillState = await readFile(`/proc/${helpers[0]!.pid}/stat`, 'utf8')
    .then((value) => value.split(') ')[1]!.split(' ')[0]!)
    .catch(() => 'gone');
  assert.ok(['gone', 'Z'].includes(helperAfterKillState));
  await delay(1100);
  const helperExpired = await kernel(true);
  await delay(300);
  const helperAttempted = await kernel(true);
  await stopAfterHelperFailure();
  assert.ok(BigInt(helperExpired.clocks.bootBeforeNs) >= BigInt(helperLive.deadline_ns));
  assert.ok(
    BigInt(helperAttempted.clocks.bootBeforeNs) - BigInt(helperBeforeKill.clocks.bootBeforeNs) <=
      2_000_000_000n,
  );
  assert.equal(helperExpired.accepted, helperAttempted.accepted);
  assert.ok(helperAttempted.containers?.every((row) => row.State.Running === false));
  assert.ok(BigInt(helperAttempted.last_accepted_boot_ns) < BigInt(helperLive.deadline_ns));
  for (const family of [0, 1])
    directCases.push({ phase: 'helper-expired', family, expected: false, observed: false });
  await writeFile(
    '/evidence/composed-helper-proof.json',
    JSON.stringify({
      helper: helpers[0],
      beforeKill: helperBeforeKill,
      signal: 'SIGKILL',
      afterKillState: helperAfterKillState,
      live: helperLive,
      expired: helperExpired,
      attempted: helperAttempted,
    }),
  );
  // Reconstruct the host controller from its real fsynced state while traffic continues.
  await new Promise<void>((resolve, reject) =>
    server!.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
  deadlineHelper!.close?.();
  dependencies.enforcement = createEnforcement();
  const recovered = new ProbeHost(await store.load(), dependencies);
  // Helper-failure containment already stopped both senders. Restore first;
  // retained-stream revocation can only be measured after fresh starts.
  await recovered.restore();
  await recovered.revalidate();
  for (const [role, id] of [
    ['sandbox', containerId],
    ['relay', relayId],
  ] as const)
    await recovered.execute({
      operation: 'start',
      projectId: identity.projectId,
      generation: identity.containerGeneration,
      role,
      containerId: id,
    } satisfies ProjectEgressHostRequest);
  server = await listenProjectEgressHost({ directory, token, controller: recovered });
  await lifecycle.connect(identity);
  await revokeAndMeasure(() => recovered.restore(), 'controller-restore');
  await recovered.revalidate();
  await delay(500);
  assert.ok(!(await docker('logs', 'veh-receiver')).includes('host-startup-marker'));
  assert.deepEqual(await lifecycle.current(binding.projectId), binding);
  assert.ok((await client('negative', relayAddress, 8080)).includes('transport-denied'));
  await verifyNoRevival('controller-restore');
  await directProbe('fresh-after-helper', true);
  await lifecycle.revokeDirect(identity);
  await writeFile('/evidence/composed-receiver.txt', await docker('logs', 'veh-direct'));
  await writeFile(
    '/evidence/composed-result.json',
    JSON.stringify({ complete: true, cases: directCases }),
  );
  results.push('registry recovery denies old transports and requires explicit revalidation');
  const directBinding = (
    await inspectEgressHostDirect(binding, { sandbox: containerId, relay: relayId })
  ).corridor.binding;
  await revokeAndMeasure(() => lifecycle.retire(identity), 'retire');
  await assert.rejects(lifecycle.start(identity, 'sandbox', containerId));
  await assert.rejects(startRelay({ ...context, resumeExisting: true }));
  // Retire stops both endpoints. An exec failure is not a network-denial receipt.
  const retired = Object.fromEntries(
    await Promise.all(
      Object.entries({ sandbox: containerId, relay: relayId }).map(async ([role, id]) => {
        const running: unknown = JSON.parse(
          await docker('inspect', '--format', '{{json .State.Running}}', id),
        );
        assert.equal(running, false, `retired ${role} must remain stopped after refused restart`);
        return [role, { id, running }] as const;
      }),
    ),
  );
  await writeFile('/evidence/retired-containers.json', JSON.stringify(retired));
  results.push('retired generation and its relay cannot restart or regain transport');
  const nextIdentity = { ...identity, containerGeneration: 'gen2' };
  const nextBinding = await lifecycle.create(nextIdentity);
  extraNetworks.push(nextBinding.networkName);
  assert.notEqual(nextBinding.networkId, binding.networkId);
  await assert.rejects(lifecycle.start(nextIdentity, 'relay', relayId));
  await assert.rejects(lifecycle.start(identity, 'relay', relayId));
  await lifecycle.retire(nextIdentity);
  results.push('replacement gets a fresh network and rejects old-generation container identities');
  const deniedLog = await docker('logs', 'veh-receiver');
  assert.ok(
    !deniedLog.includes('host-startup-marker') && !deniedLog.includes('transferred-startup-marker'),
  );
  // Deliberately broken boundary: the same source must reach the independent receiver.
  const table = projectEgressStartupRules(binding).match(/add table inet (\w+)/)![1];
  await applyProjectFenceRules(
    `delete table inet ${projectFenceTable(directBinding)}\ndelete table bridge ${projectFenceTable(directBinding)}\ndelete table inet ${table}\ndelete table bridge ${table}\ndelete table inet verity_egress_boot\ndelete table bridge verity_egress_boot\n`,
  );
  await docker('start', containerId);
  await exec('ip6tables', [
    '-I',
    'FORWARD',
    '1',
    '-i',
    bridge,
    '-o',
    'veh-receiver',
    '-j',
    'ACCEPT',
  ]);
  await exec('ip6tables', [
    '-I',
    'FORWARD',
    '1',
    '-i',
    'veh-receiver',
    '-o',
    bridge,
    '-j',
    'ACCEPT',
  ]);
  await exec('iptables', [
    '-I',
    'FORWARD',
    '1',
    '-i',
    'veh-receiver',
    '-o',
    bridge,
    '-j',
    'ACCEPT',
  ]);
  await docker(
    'exec',
    '--user',
    '1000:1000',
    containerId,
    'python3',
    '/probe/transport-client.py',
    relayAddress,
    'external',
    'positive',
  );
  const externalLog = await docker('logs', 'veh-receiver');
  for (const family of [2, 10])
    for (const suffix of ['udp-53', 'udp-8080', 'tcp-own-credential'])
      assert.ok(
        externalLog.includes(`external-${family}-${suffix}`),
        `missing independent positive control ${family}/${suffix}`,
      );
  results.push('removed-fence controls prove direct credential and DNS/IPv6 receiver paths');
  let receiverLog = '';
  for (
    let i = 0;
    i < 50 &&
    !['host-startup-marker', 'transferred-startup-marker'].every((marker) =>
      receiverLog.includes(marker),
    );
    i++
  ) {
    await delay(100);
    receiverLog = await docker('logs', 'veh-receiver');
  }
  assert.ok(receiverLog.includes('host-startup-marker'));
  assert.ok((await docker('logs', 'veh-receiver')).includes('transferred-startup-marker'));
  results.push(
    'removed-fence positive control reaches receiver with inherited and transferred sockets',
  );
  await writeFile(
    '/evidence/host-result.json',
    JSON.stringify({ complete: true, results }, null, 2),
  );
} catch (error) {
  await writeFile(
    '/evidence/composed-receiver.txt',
    await docker('logs', 'veh-direct').catch(String),
  );
  await writeFile(
    '/evidence/composed-renewal-trace.jsonl',
    await readFile(`${directory}/renewal-trace.jsonl`, 'utf8').catch(String),
  );
  await writeFile(
    '/evidence/host-failure-project-routes.txt',
    await docker(
      'exec',
      '--user',
      '1000:1000',
      'veh-source',
      'sh',
      '-c',
      'cat /proc/net/route /proc/net/arp /proc/net/ipv6_route',
    ).catch(String),
  );
  await writeFile(
    '/evidence/host-failure-deadlines.json',
    await exec('/bin/sh', ['-c', 'cat /var/lib/verity-egress/deadline/*.json'])
      .then((r) => r.stdout)
      .catch(String),
  );
  await writeFile(
    '/evidence/host-failure-neighbors.txt',
    await exec('/sbin/ip', ['neighbor', 'show'])
      .then((r) => r.stdout)
      .catch(String),
  );
  await writeFile(
    '/evidence/host-failure-tc.txt',
    await exec('/bin/sh', [
      '-c',
      'for p in /sys/fs/bpf/verity_egress_deadline/*/maps/*; do /usr/sbin/bpftool map dump pinned "$p"; done',
    ])
      .then((r) => r.stdout)
      .catch(String),
  );
  await writeFile(
    '/evidence/host-failure-rules.txt',
    await exec('/usr/sbin/nft', ['-j', 'list', 'ruleset'])
      .then((r) => r.stdout)
      .catch(String),
  );
  await writeFile(
    '/evidence/host-failure-links.json',
    await exec('/sbin/ip', ['-j', 'link', 'show'])
      .then((r) => r.stdout)
      .catch(String),
  );
  await writeFile(
    '/evidence/host-result.json',
    JSON.stringify({ complete: false, results, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  packetCapture?.kill('SIGINT');
  deadlineHelper!.close?.();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  for (const name of [
    'veh-source',
    'veh-receiver',
    'veh-unsupported',
    relayName,
    ...extraContainers,
  ].filter(Boolean)) {
    await writeFile(
      `/evidence/${name}.jsonl`,
      await docker('logs', name).catch(() => 'unavailable'),
    );
    await writeFile(
      `/evidence/state-${name}.json`,
      await docker('inspect', name).catch(() => 'unavailable'),
    );
    await docker('rm', '-f', name).catch(() => undefined);
  }
  for (const name of [generationNetwork, 'veh-receiver', ...extraNetworks].filter(Boolean))
    await docker('network', 'rm', name).catch(() => undefined);
  for (const listener of socketServers)
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  await docker('volume', 'rm', volumeName).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
