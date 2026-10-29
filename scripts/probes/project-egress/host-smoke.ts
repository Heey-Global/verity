import { createDockerClient } from '../../../packages/server/src/docker.js';
import { createProjectEgressHostClient } from '../../../packages/server/src/project-egress-host-client.js';
import { ProjectEgressLifecycle } from '../../../packages/server/src/project-egress-lifecycle.js';
/** Deny-before-first-instruction fixture; no production daemon or credentials. */
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, writeFile, rm, mkdir, chmod, chown } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
  ProjectEgressHost,
  projectEgressStartupRules,
  type ProjectEgressHostRequest,
} from '../../../packages/server/src/project-egress-host.js';
import {
  openProjectEgressHostStore,
  inspectEgressHostContainer,
  inspectEgressHostNetwork,
  projectEgressHostDocker as docker,
} from '../../../packages/server/src/project-egress-host-runtime.js';
import { listenProjectEgressHost } from '../../../packages/server/src/project-egress-host-control.js';
import { applyProjectFenceRules } from '../../../packages/server/src/project-egress-fence.js';
assert.equal(process.env.PROJECT_EGRESS_DISPOSABLE, 'yes');
const exec = promisify(execFile);
let bridge = '';
let generationNetwork = '';
const directory = await mkdtemp('/tmp/egress-host-');
const token = randomBytes(32).toString('hex');
const store = await openProjectEgressHostStore(directory);
const dependencies = {
  save: (state: Parameters<typeof store.save>[0]) => store.save(state),
  apply: applyProjectFenceRules,
  inspectNetwork: inspectEgressHostNetwork,
  inspectContainer: inspectEgressHostContainer,
  startContainer: async (id: string) => {
    await docker('start', id);
  },
  stopContainer: async (id: string) => {
    await docker('stop', '--time', '1', id);
  },
};
let server: Server | undefined;
let broker: Server | undefined;
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
      'com.docker.network.bridge.enable_ip_masquerade=false',
      name!,
    );
  const receiver = `import socket\ns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\ns.bind(('0.0.0.0',8080))\nprint('ready',flush=True)\nwhile True:\n d,a=s.recvfrom(1024)\n print(d.decode(),flush=True)\n`;
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
    '-c',
    receiver,
  );
  for (let i = 0; i < 50 && !(await docker('logs', 'veh-receiver')).includes('ready'); i++)
    await delay(100);
  assert.ok((await docker('logs', 'veh-receiver')).includes('ready'));
  const host = new ProjectEgressHost(await store.load(), dependencies);
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
  const command = createProjectEgressHostClient({ socketPath: `${directory}/control.sock`, token });
  const lifecycle = new ProjectEgressLifecycle(
    command,
    createDockerClient({ baseUrl: 'unix:///var/run/docker.sock' }),
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
  const brokerDirectory = `${directory}/broker`;
  await mkdir(brokerDirectory, { mode: 0o755 });
  let brokerRequests = 0;
  broker = createServer((_request, response) => {
    brokerRequests++;
    response.end('project-bound-fixture');
  });
  await new Promise<void>((resolve) => broker!.listen(`${brokerDirectory}/broker.sock`, resolve));
  await chmod(`${brokerDirectory}/broker.sock`, 0o666);
  const relayId = (
    await docker(
      'create',
      '--name',
      'veh-relay',
      '--runtime',
      'runsc-project',
      '--restart',
      'no',
      '--network',
      generationNetwork,
      '--memory',
      '256m',
      '--pids-limit',
      '64',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--sysctl',
      'net.ipv4.ip_unprivileged_port_start=0',
      '--mount',
      `type=bind,src=${brokerDirectory},dst=/run/verity-relay/broker,readonly`,
      'project-egress-relay:local',
    )
  ).trim();
  await lifecycle.start(identity, 'relay', relayId);
  // Loopback reaches the actual relay without adding any network admission rule.
  const relayProbe = `const h=require('node:http');const r=h.request({host:'127.0.0.1',port:8080,method:'POST',path:'/internal/project/memory'},s=>{let b='';s.on('data',c=>b+=c);s.on('end',()=>{console.log(JSON.stringify({status:s.statusCode,body:b}));});});r.setTimeout(3000,()=>r.destroy());r.on('error',()=>process.exit(1));r.end();`;
  let relayReply = '';
  for (let i = 0; i < 40; i++) {
    relayReply = await docker('exec', relayId, '/nodejs/bin/node', '-e', relayProbe).catch(
      () => '',
    );
    if (relayReply.includes('project-bound-fixture')) break;
    await delay(250);
  }
  assert.ok(
    relayReply.includes('project-bound-fixture'),
    `actual relay UDS positive control failed: ${relayReply}`,
  );
  assert.ok(brokerRequests > 0);
  results.push('actual relay forwards loopback control to its mounted project broker socket');

  await delay(2000);
  assert.ok((await docker('logs', 'veh-source')).includes('sending'));
  assert.ok((await docker('logs', 'veh-source')).includes('transferred-socket-ready'));
  assert.ok(!(await docker('logs', 'veh-receiver')).includes('transferred-startup-marker'));
  assert.ok(!(await docker('logs', 'veh-receiver')).includes('host-startup-marker'));
  results.push('no receiver observation from first process instruction');
  // Reconstruct the host controller from its real fsynced state while traffic continues.
  await new Promise<void>((resolve, reject) =>
    server!.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
  const recovered = new ProjectEgressHost(await store.load(), dependencies);
  await recovered.restore();
  server = await listenProjectEgressHost({ directory, token, controller: recovered });
  await delay(500);
  assert.ok(!(await docker('logs', 'veh-receiver')).includes('host-startup-marker'));
  assert.deepEqual(await lifecycle.current(binding.projectId), binding);
  results.push('registry recovery retains denial');
  await lifecycle.retire(identity);
  await assert.rejects(lifecycle.start(identity, 'sandbox', containerId));
  results.push('retired generation cannot restart');
  // Deliberately broken boundary: the same source must reach the independent receiver.
  const table = projectEgressStartupRules(binding).match(/add table inet (\w+)/)![1];
  await applyProjectFenceRules(
    `delete table inet ${table}\ndelete table bridge ${table}\ndelete table inet verity_egress_boot\ndelete table bridge verity_egress_boot\n`,
  );
  await docker('start', containerId);
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
    '/evidence/host-result.json',
    JSON.stringify({ complete: false, results, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  for (const name of ['veh-source', 'veh-receiver', 'veh-unsupported', 'veh-relay']) {
    await writeFile(
      `/evidence/${name}.jsonl`,
      await docker('logs', name).catch(() => 'unavailable'),
    );
    await docker('rm', '-f', name).catch(() => undefined);
  }
  for (const name of [generationNetwork, 'veh-receiver'].filter(Boolean))
    await docker('network', 'rm', name).catch(() => undefined);
  if (broker) await new Promise<void>((resolve) => broker!.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
