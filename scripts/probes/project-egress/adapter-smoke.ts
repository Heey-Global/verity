/** Runs only inside the disposable nested Docker host, never on a production daemon. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ProjectEgressFence,
  applyProjectFenceRules,
  projectFenceRules,
  type ProjectFenceBinding,
} from '../../../packages/server/src/project-egress-fence.js';
import { inspectProjectFenceAttachment } from '../../../packages/server/src/project-egress-attachment.js';
import {
  hostProjectDeadlineEnforcer,
  type ProjectDeadlineLease,
} from '../../../packages/server/src/project-egress-deadline.js';
const exec = promisify(execFile);
assert.equal(process.env.PROJECT_EGRESS_DISPOSABLE, 'yes');
const docker = async (...args: string[]) =>
  (await exec('/usr/bin/docker', args, { timeout: 10000, maxBuffer: 2 * 1024 * 1024 })).stdout;
const evidence: Array<{ case: string; expected: boolean; observed: boolean }> = [];
const attemptTimings: Array<Record<string, unknown>> = [];
const addresses = ['11.77.3.2', '2001:4860:feed:3::2'];
const nets = [
  ['ve-fa', '172.30.101.0/24', 'fd42:feed:1::/64'],
  ['ve-fb', '172.30.102.0/24', 'fd42:feed:2::/64'],
  ['ve-fr', '11.77.3.0/24', '2001:4860:feed:3::/64'],
];
const bindings: ProjectFenceBinding[] = [];
let renewProjects: number[] = [];
let revision = 0;
const nativeDeadline = hostProjectDeadlineEnforcer();
let pauseKind: 'controller' | 'executor' | null = null;
let stagedLease: ProjectDeadlineLease | undefined;
const fence = new ProjectEgressFence({
  deadline: {
    ...nativeDeadline,
    async revoke(binding, next) {
      stagedLease = next;
      await nativeDeadline.revoke(binding, next);
    },
    async arm(binding, lease) {
      if (pauseKind !== 'executor') return nativeDeadline.arm(binding, lease);
      const pending = exec('/usr/bin/python3', ['/probe/deadline-paused-executor.py'], {
        timeout: 10000,
        killSignal: 'SIGKILL',
      });
      assert.ok(pending.child.stdin);
      pending.child.stdin.end(JSON.stringify({ operation: 'arm', binding, lease }));
      const response = JSON.parse((await pending).stdout) as {
        state: string;
        bootDeadlineNs: string;
      };
      assert.equal(response.state, 'armed');
      assert.equal(response.bootDeadlineNs, lease.bootDeadlineNs);
      pauseKind = null;
    },
  },
  inspect: inspectProjectFenceAttachment,
  directTargetAllowed: (host) => Promise.resolve(addresses.includes(host)),
  destinationAllowed: (address) => Promise.resolve(addresses.includes(address)),
  resolve: () => Promise.reject(new Error('This smoke uses exact public addresses')),
  policyCurrent: (snapshot) => Promise.resolve(snapshot.revision === revision),
  async apply(script) {
    if (pauseKind === 'controller' && script.includes('elements =')) {
      assert.ok(stagedLease);
      await writeFile(
        '/evidence/deadline-pause-controller-request.pending',
        JSON.stringify({ pid: process.pid, lease: stagedLease }),
      );
      await rename(
        '/evidence/deadline-pause-controller-request.pending',
        '/evidence/deadline-pause-controller-request.json',
      );
      process.kill(process.pid, 'SIGSTOP');
      pauseKind = null;
    }
    await applyProjectFenceRules(script);
  },
});
function pauseDriver(kind: 'controller' | 'executor'): Promise<void> {
  const child = spawn('/usr/bin/python3', ['/probe/deadline-pause-driver.py', kind], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('Actual pause driver failed')),
    );
  });
}
interface KernelObservation {
  identity: string;
  deadline_ns: string;
  accepted: number;
  denied: number;
  last_accepted_boot_ns: string;
  last_denied_boot_ns: string;
  clocks: { bootBeforeNs: string; bootAfterNs: string };
}
async function kernelObservation(): Promise<KernelObservation> {
  return JSON.parse(
    (await exec('/usr/bin/python3', ['/probe/deadline-observe.py', JSON.stringify(bindings[0]!)]))
      .stdout,
  ) as KernelObservation;
}
async function flow(request: Record<string, unknown>) {
  const reply = JSON.parse(
    await docker('exec', 've-a', 'python3', '/probe/agent.py', 'command', JSON.stringify(request)),
  ) as { opened?: boolean; sent?: boolean; stopped?: boolean; error?: string };
  assert.equal(reply.error, undefined, 'Persistent stream operation failed');
  assert.ok(reply.opened || reply.sent || reply.stopped);
}
async function observe(
  project: string,
  host: string,
  kind: string,
  expected: boolean,
  name: string,
  receiver = 've-receiver',
  record = true,
  retained?: { id: string; marker: string },
) {
  const marker = name.replace(/[^a-z0-9]/giu, '-');
  let observed = false;
  // Probe an acknowledged lease instead of racing the deliberate deny-first gap.
  // Expiry/revocation phases leave renewProjects empty.
  for (let attempt = 0; attempt < (expected ? 5 : 1); attempt++) {
    const started = process.hrtime.bigint();
    // Refresh only this sender: renewing an unrelated project consumes its lease
    // budget before any positive packet is attempted.
    for (const index of renewProjects)
      if (bindings[index]!.projectId === project)
        await fence.refresh({ binding: bindings[index]!, revision, grants: grants() });
    const ready = process.hrtime.bigint();
    await docker(
      'exec',
      project,
      'python3',
      '/probe/agent.py',
      retained ? 'command' : 'send',
      JSON.stringify({
        host,
        kind,
        marker,
        port: 8080,
        action: retained ? 'flow-and-send' : 'send',
        retained,
      }),
    );
    const sent = process.hrtime.bigint();
    attemptTimings.push({
      name,
      attempt,
      project,
      refreshMs: Number(ready - started) / 1e6,
      sendMs: Number(sent - ready) / 1e6,
      lease: stagedLease,
    });
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
  if (record) evidence.push({ case: name, expected, observed });
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
  const baseline = await kernelObservation();
  await fence.refresh({ binding: bindings[0]!, revision, grants: grants() });
  await flow({
    action: 'flow-start',
    kind: 'tcp',
    host: addresses[0],
    id: 'deadline-retained',
    repeatMarker: 'deadline-stream',
    marker: 'deadline-retained-live',
  });
  const positive = await kernelObservation();
  assert.ok(positive.accepted > baseline.accepted, 'No positive through the actual TC guard');
  assert.ok(BigInt(positive.last_accepted_boot_ns) < BigInt(positive.deadline_ns));
  assert.ok((await docker('logs', 've-receiver')).includes('deadline-retained-live'));
  await delay(1200);
  const expiredBefore = await kernelObservation();
  await flow({ action: 'flow-send', id: 'deadline-retained', marker: 'deadline-retained-expired' });
  await matrix('ve-a', false, 'lease-expiry');
  const expiredAfter = await kernelObservation();
  assert.equal(expiredAfter.accepted, expiredBefore.accepted);
  assert.ok(expiredAfter.denied > expiredBefore.denied);
  assert.ok(BigInt(expiredAfter.last_accepted_boot_ns) < BigInt(positive.deadline_ns));
  assert.ok(BigInt(expiredAfter.last_denied_boot_ns) >= BigInt(positive.deadline_ns));
  await flow({ action: 'flow-repeat-stop', id: 'deadline-retained' });
  const retained = { id: 'deadline-retained', marker: 'deadline-retained-renewed' };
  await renewed([0], async () => {
    await observe(
      've-a',
      addresses[0]!,
      'tcp',
      true,
      'deadline-fresh-after-renewal',
      've-receiver',
      true,
      retained,
    );
  });
  const renewalStart = (await kernelObservation()).clocks.bootBeforeNs;
  let renewalEnd = renewalStart;
  const renewalControls: string[] = [];
  for (
    let attempt = 0;
    attempt < 12 && (attempt < 2 || BigInt(renewalEnd) - BigInt(renewalStart) < 2_200_000_000n);
    attempt++
  ) {
    const marker = `deadline-renewal-control-${attempt}`;
    await renewed([0], async () => {
      await observe('ve-a', addresses[0]!, 'tcp', true, marker, 've-receiver', false, retained);
    });
    renewalControls.push(marker);
    await delay(150);
    renewalEnd = (await hostProjectDeadlineEnforcer().clock()).bootBeforeNs;
  }
  assert.ok(BigInt(renewalEnd) - BigInt(renewalStart) >= 2_000_000_000n);
  const pauseCases = [];
  for (const kind of ['controller', 'executor'] as const) {
    await fence.refresh({ binding: bindings[0]!, revision, grants: grants() });
    await observe(
      've-a',
      addresses[0]!,
      'udp',
      true,
      `deadline-pause-positive-${kind}`,
      've-receiver',
      false,
    );
    pauseKind = kind;
    const driver = pauseDriver(kind);
    await fence.refresh({ binding: bindings[0]!, revision, grants: grants() });
    await driver;
    assert.equal(pauseKind, null);
    const before = await kernelObservation();
    await observe(
      've-a',
      addresses[0]!,
      'udp',
      false,
      `deadline-paused-${kind}`,
      've-receiver',
      false,
    );
    const after = await kernelObservation();
    assert.equal(after.accepted, before.accepted);
    assert.ok(after.denied > before.denied);
    assert.ok(BigInt(after.last_accepted_boot_ns) < BigInt(after.deadline_ns));
    const stopped = JSON.parse(
      await readFile(`/evidence/deadline-pause-${kind}-result.json`, 'utf8'),
    ) as unknown;
    pauseCases.push({ kind, before, after, stopped });
    await fence.refresh({ binding: bindings[0]!, revision, grants: grants() });
    await observe(
      've-a',
      addresses[0]!,
      'udp',
      true,
      `deadline-pause-recovered-${kind}`,
      've-receiver',
      false,
    );
  }
  const retainedLogs = await docker('logs', 've-receiver');
  assert.ok(!retainedLogs.includes('deadline-retained-expired'));
  assert.ok(!retainedLogs.includes('deadline-retained-renewed'));
  await writeFile('/evidence/adapter-deadline-receiver.jsonl', retainedLogs);
  await writeFile(
    '/evidence/adapter-deadline-proof.json',
    JSON.stringify(
      {
        complete: true,
        baseline,
        positive,
        expiredBefore,
        expiredAfter,
        renewalStart,
        renewalEnd,
        renewalControls,
        pauseCases,
      },
      null,
      2,
    ),
  );
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
  // Removing nft alone must not bypass the new required TC guard. This positive
  // deliberately removes both layers, only on the disposable inspected endpoint.
  await exec('/usr/bin/python3', [
    '-c',
    `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('deadline', '/opt/verity-egress/project-egress-deadline.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
binding = json.loads(sys.argv[1])
state = json.loads((host.STATE / (host.binding_key(binding) + '.json')).read_text())
assert host.endpoint(binding) == state['peer']
host.run('/sbin/tc', 'qdisc', 'del', 'dev', state['peer']['device'], 'clsact')
`,
    JSON.stringify(bindings[0]!),
  ]);
  await matrix('ve-a', true, 'removed-fence');
  await writeFile('/evidence/adapter-receiver.jsonl', await docker('logs', 've-receiver'));
  await writeFile('/evidence/adapter-peer.jsonl', await docker('logs', 've-peer'));
  await writeFile(
    '/evidence/adapter-result.json',
    JSON.stringify({ complete: true, cases: evidence }, null, 2),
  );
} catch (error) {
  await writeFile(
    '/evidence/adapter-attempt-timings.json',
    JSON.stringify(attemptTimings, null, 2),
  );
  if (bindings.length)
    await writeFile(
      '/evidence/adapter-failure-kernel.json',
      JSON.stringify(
        await kernelObservation().catch((failure: unknown) => String(failure)),
        null,
        2,
      ),
    );
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
