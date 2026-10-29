/** Deny-before-first-instruction fixture; no production daemon or credentials. */
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
const bridge = 'vep000000000001';
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
const results: string[] = [];
try {
  for (const [name, subnet] of [
    [bridge, '172.30.104.0/24'],
    ['veh-receiver', '172.30.105.0/24'],
  ])
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
  const networkId = (await docker('network', 'inspect', '--format', '{{.Id}}', bridge)).trim();
  const binding = {
    projectId: 'host-smoke',
    generation: 'gen1',
    networkId,
    networkName: bridge,
    bridge,
  };
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
  assert.equal(await send({ operation: 'register', binding }), 200);
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
      bridge,
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
      bridge,
      '--ip',
      '172.30.104.2',
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
      emitter,
    )
  ).trim();
  assert.equal(
    await send({
      operation: 'start',
      projectId: binding.projectId,
      generation: binding.generation,
      role: 'sandbox',
      containerId,
    }),
    200,
  );
  await delay(2000);
  assert.ok((await docker('logs', 'veh-source')).includes('sending'));
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
  results.push('registry recovery retains denial');
  await recovered.execute({
    operation: 'retire',
    projectId: binding.projectId,
    generation: binding.generation,
  });
  await assert.rejects(
    recovered.execute({
      operation: 'start',
      projectId: binding.projectId,
      generation: binding.generation,
      role: 'sandbox',
      containerId,
    }),
  );
  results.push('retired generation cannot restart');
  // Deliberately broken boundary: the same source must reach the independent receiver.
  const table = projectEgressStartupRules(binding).match(/add table inet (\w+)/)![1];
  await applyProjectFenceRules(
    `delete table inet ${table}\ndelete table bridge ${table}\ndelete table inet verity_egress_boot\ndelete table bridge verity_egress_boot\n`,
  );
  await docker('start', containerId);
  for (
    let i = 0;
    i < 50 && !(await docker('logs', 'veh-receiver')).includes('host-startup-marker');
    i++
  )
    await delay(100);
  assert.ok((await docker('logs', 'veh-receiver')).includes('host-startup-marker'));
  results.push('removed-fence positive control reaches receiver');
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
  for (const name of ['veh-source', 'veh-receiver', 'veh-unsupported']) {
    await writeFile(
      `/evidence/${name}.jsonl`,
      await docker('logs', name).catch(() => 'unavailable'),
    );
    await docker('rm', '-f', name).catch(() => undefined);
  }
  for (const name of [bridge, 'veh-receiver'])
    await docker('network', 'rm', name).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
