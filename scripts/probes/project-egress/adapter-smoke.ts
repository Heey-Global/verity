/** Runs only inside the disposable nested Docker host, never on a production daemon. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ProjectEgressFence,
  applyProjectFenceRules,
  projectFenceRules,
  type ProjectFenceBinding,
} from '../../../packages/server/src/project-egress-fence.js';
import { inspectProjectFenceAttachment } from '../../../packages/server/src/project-egress-attachment.js';
import { hostProjectDeadlineEnforcer } from '../../../packages/server/src/project-egress-deadline.js';
const exec = promisify(execFile);
assert.equal(process.env.PROJECT_EGRESS_DISPOSABLE, 'yes');
const docker = async (...args: string[]) =>
  (await exec('/usr/bin/docker', args, { timeout: 10000, maxBuffer: 2 * 1024 * 1024 })).stdout;
const evidence: Array<{ case: string; expected: boolean; observed: boolean }> = [];
const addresses = ['11.77.3.2', '2001:4860:feed:3::2'];
const nets = [
  ['ve-fa', '172.30.101.0/24', 'fd42:feed:1::/64'],
  ['ve-fb', '172.30.102.0/24', 'fd42:feed:2::/64'],
  ['ve-fr', '11.77.3.0/24', '2001:4860:feed:3::/64'],
];
const bindings: ProjectFenceBinding[] = [];
let renewProjects: number[] = [];
let revision = 0;
const fence = new ProjectEgressFence({
  deadline: hostProjectDeadlineEnforcer(),
  inspect: inspectProjectFenceAttachment,
  directTargetAllowed: (host) => Promise.resolve(addresses.includes(host)),
  destinationAllowed: (address) => Promise.resolve(addresses.includes(address)),
  resolve: () => Promise.reject(new Error('This smoke uses exact public addresses')),
  policyCurrent: (snapshot) => Promise.resolve(snapshot.revision === revision),
  apply: applyProjectFenceRules,
});
async function observe(
  project: string,
  host: string,
  kind: string,
  expected: boolean,
  name: string,
  receiver = 've-receiver',
) {
  const marker = name.replace(/[^a-z0-9]/giu, '-');
  let observed = false;
  // Probe an acknowledged lease instead of racing the deliberate deny-first gap.
  // Expiry/revocation phases leave renewProjects empty.
  for (let attempt = 0; attempt < (expected ? 5 : 1); attempt++) {
    for (const index of renewProjects)
      await fence.refresh({ binding: bindings[index]!, revision, grants: grants() });
    await docker(
      'exec',
      project,
      'python3',
      '/probe/agent.py',
      'send',
      JSON.stringify({ host, kind, marker, port: 8080 }),
    );
    const logs = await docker('logs', receiver);
    observed = logs.split('\n').some((line) => {
      try {
        return (JSON.parse(line) as { marker?: unknown }).marker === marker;
      } catch {
        return false;
      }
    });
    if (observed) break;
  }
  evidence.push({ case: name, expected, observed });
  assert.equal(observed, expected, name);
}
async function matrix(project: string, expected: boolean, label: string) {
  for (const host of addresses)
    for (const kind of ['tcp', 'udp'])
      await observe(project, host, kind, expected, `${label}-${kind}-${host}`);
}
function grants() {
  return addresses.flatMap((host) =>
    (['tcp', 'udp'] as const).map((protocol) => ({
      id: host + protocol,
      target: { host, protocol, port: 8080 },
      approvedBy: 'fixture',
      approvedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    })),
  );
}
async function renewed(projects: number[], action: () => Promise<void>) {
  renewProjects = projects;
  try {
    await action();
  } finally {
    renewProjects = [];
  }
}

try {
  for (const [name, subnet, subnet6] of nets)
    await docker(
      'network',
      'create',
      '--ipv6',
      '--subnet',
      subnet!,
      '--subnet',
      subnet6!,
      '--opt',
      `com.docker.network.bridge.name=${name}`,
      '--opt',
      'com.docker.network.bridge.enable_ip_masquerade=false',
      '--opt',
      'com.docker.network.bridge.gateway_mode_ipv4=nat-unprotected',
      '--opt',
      'com.docker.network.bridge.gateway_mode_ipv6=nat-unprotected',
      name!,
    );
  for (const bridge of ['ve-fa', 've-fb'])
    for (const binary of ['iptables', 'ip6tables']) {
      await exec(binary, ['-I', 'FORWARD', '1', '-i', bridge, '-o', 've-fr', '-j', 'ACCEPT']);
      await exec(binary, ['-I', 'FORWARD', '1', '-i', 've-fr', '-o', bridge, '-j', 'ACCEPT']);
    }
  for (const [name, network, ip, ip6] of [
    ['ve-receiver', 've-fr', addresses[0]!, addresses[1]!],
    ['ve-peer', 've-fa', '172.30.101.3', 'fd42:feed:1::3'],
  ]) {
    await docker(
      'run',
      '-d',
      '--name',
      name!,
      '--network',
      network!,
      '--ip',
      ip!,
      '--ip6',
      ip6!,
      '--memory',
      '192m',
      '--memory-swap',
      '192m',
      '--pids-limit',
      '128',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--sysctl',
      'net.ipv4.ip_unprivileged_port_start=0',
      '-e',
      'DNS_ADDRESSES=' + JSON.stringify([addresses, addresses]),
      '-e',
      'REDIRECT_TARGET=' + addresses[0],
      'project-egress-fixture:local',
      'receiver',
    );
  }
  for (const [index, name] of ['ve-a', 've-b'].entries()) {
    const bridge = index === 0 ? 've-fa' : 've-fb';
    await docker(
      'run',
      '-d',
      '--runtime',
      'runsc-project',
      '--name',
      name,
      '--network',
      bridge,
      '--ip',
      `172.30.${101 + index}.2`,
      '--ip6',
      `fd42:feed:${index + 1}::2`,
      '--memory',
      '192m',
      '--memory-swap',
      '192m',
      '--pids-limit',
      '128',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      'project-egress-fixture:local',
      'project',
      name,
    );
    const inspected = (
      JSON.parse(await docker('inspect', name)) as Array<{
        Id: string;
        NetworkSettings: {
          Networks: Record<
            string,
            { NetworkID: string; EndpointID: string; IPAddress: string; GlobalIPv6Address: string }
          >;
        };
      }>
    )[0]!;
    const endpoint = inspected.NetworkSettings.Networks[bridge]!;
    bindings.push({
      projectId: name,
      generation: 'generation1',
      containerId: inspected.Id,
      networkId: endpoint.NetworkID,
      endpointId: endpoint.EndpointID,
      bridge,
      ipv4: endpoint.IPAddress,
      ipv6: endpoint.GlobalIPv6Address,
    });
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      (await docker('logs', 've-receiver')).includes('"ready": true') &&
      (await docker('logs', 've-peer')).includes('"ready": true')
    )
      break;
    await delay(100);
  }
  assert.ok(
    (await docker('logs', 've-receiver')).includes('"ready": true'),
    'External receiver not ready',
  );
  assert.ok((await docker('logs', 've-peer')).includes('"ready": true'), 'Peer receiver not ready');
  // Demonstrate the same-bridge receiver is reachable before applying its fence.
  await observe('ve-a', '172.30.101.3', 'tcp', true, 'peer-positive', 've-peer');
  for (const binding of bindings) await fence.prepare(binding);
  await renewed([0, 1], async () => {
    await matrix('ve-a', true, 'positive-a');
    await matrix('ve-b', true, 'positive-b');
  });
  revision++;
  await fence.refresh({ binding: bindings[1]!, revision, grants: [] });
  await renewed([0], async () => {
    await matrix('ve-a', true, 'allowed-a');
    await matrix('ve-b', false, 'denied-b');
    await observe('ve-a', '172.30.101.3', 'tcp', false, 'peer-denied', 've-peer');
  });
  await delay(1200);
  await matrix('ve-a', false, 'lease-expiry');
  await renewed([0], async () => {
    await matrix('ve-a', true, 'before-revoke');
  });
  revision++;
  await fence.refresh({ binding: bindings[0]!, revision, grants: [] });
  await matrix('ve-a', false, 'revoked');
  // A real removed-fence mutation must restore receipt, otherwise denials lack controls.
  const table = projectFenceRules(bindings[0]!, [], Date.now(), false).match(
    /table inet (\w+)/,
  )![1];
  await applyProjectFenceRules(`delete table inet ${table}\ndelete table bridge ${table}\n`);
  await matrix('ve-a', true, 'removed-fence');
  await writeFile('/evidence/adapter-receiver.jsonl', await docker('logs', 've-receiver'));
  await writeFile('/evidence/adapter-peer.jsonl', await docker('logs', 've-peer'));
  await writeFile(
    '/evidence/adapter-result.json',
    JSON.stringify({ complete: true, cases: evidence }, null, 2),
  );
} catch (error) {
  await writeFile(
    '/evidence/adapter-result.json',
    JSON.stringify({ complete: false, cases: evidence, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  for (const name of ['ve-receiver', 've-peer']) {
    const logs = await docker('logs', name).catch(() => 'unavailable');
    await writeFile(`/evidence/adapter-${name}-exit.jsonl`, logs);
  }
  for (const name of ['ve-a', 've-b', 've-peer', 've-receiver'])
    await docker('rm', '-f', name).catch(() => {});
  for (const [name] of nets) await docker('network', 'rm', name!).catch(() => {});
}
