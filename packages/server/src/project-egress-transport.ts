import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readlink } from 'node:fs/promises';
import type { ProjectEgressNetworkBinding } from './project-egress-host.js';
import { projectEgressHostDocker, verifyEgressHostNetwork } from './project-egress-host-runtime.js';

const exec = promisify(execFile);
const transportIO = {
  docker: projectEgressHostDocker,
  readFile: (path: string) => readFile(path, 'utf8'),
  readlink: (path: string) => readlink(path),
  run: async (file: string, args: string[]) =>
    (await exec(file, args, { timeout: 5000, maxBuffer: 131072 })).stdout,
};
const endpoint = z.strictObject({
  address: z.ipv4(),
  mac: z.string().regex(/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u),
  device: z.string().regex(/^[a-zA-Z0-9_-]{1,15}$/u),
  index: z.number().int().positive(),
});
const egressTransportSchema = z.strictObject({
  sandbox: endpoint,
  relay: endpoint,
  codex: z.boolean(),
});
export type EgressTransport = z.infer<typeof egressTransportSchema>;
const inspected = z
  .array(
    z.object({
      Id: z.string(),
      State: z.object({ Running: z.boolean() }),
      NetworkSettings: z.object({
        SandboxKey: z.string().regex(/^\/var\/run\/docker\/netns\/[a-zA-Z0-9_-]+$/u),
        Networks: z.record(
          z.string(),
          z.object({ NetworkID: z.string(), IPAddress: z.ipv4(), MacAddress: endpoint.shape.mac }),
        ),
      }),
    }),
  )
  .length(1);

/** Called only after role/image/mount validation, using registered daemon object IDs. */
export async function inspectEgressTransport(
  binding: ProjectEgressNetworkBinding,
  ids: { sandbox: string; relay: string },
  codex: boolean,
  io = transportIO,
): Promise<EgressTransport | undefined> {
  const networkReply: unknown = JSON.parse(
    await io.docker('network', 'inspect', binding.networkId),
  );
  verifyEgressHostNetwork(binding, networkReply, [ids.sandbox, ids.relay]);
  const topology = z
    .array(
      z.object({
        Containers: z.record(
          z.string(),
          z.object({ IPv4Address: z.string(), MacAddress: endpoint.shape.mac }),
        ),
      }),
    )
    .length(1)
    .parse(networkReply)[0]!;
  const result: Partial<Record<'sandbox' | 'relay', z.infer<typeof endpoint>>> = {};
  for (const role of ['sandbox', 'relay'] as const) {
    const raw: unknown = JSON.parse(await io.docker('inspect', ids[role]));
    const state = z
      .array(z.object({ Id: z.string(), State: z.object({ Running: z.boolean() }) }))
      .length(1)
      .parse(raw)[0]!;
    if (state.Id !== ids[role]) throw new Error('Transport container identity mismatch');
    if (!state.State.Running) return undefined;
    const value = inspected.parse(raw)[0]!;
    if (value.Id !== ids[role]) throw new Error('Transport container identity mismatch');
    if (!value.State.Running) return undefined;
    const entries = Object.entries(value.NetworkSettings.Networks);
    const net = entries[0]?.[1];
    if (
      entries.length !== 1 ||
      entries[0]?.[0] !== binding.networkName ||
      net?.NetworkID !== binding.networkId
    )
      throw new Error('Transport network mismatch');
    const args = ['--net=' + value.NetworkSettings.SandboxKey, '/sbin/ip', '-j', 'address', 'show'];
    const links = z
      .array(
        z.object({
          ifindex: z.number().int().positive(),
          ifname: z.string(),
          link_index: z.number().int().positive().optional(),
          address: z.string(),
          addr_info: z.array(z.object({ family: z.string(), local: z.string() })),
        }),
      )
      .parse(JSON.parse(await io.run('/usr/bin/nsenter', args)));
    const assignment = topology.Containers[ids[role]];
    if (
      !assignment ||
      assignment.IPv4Address.split('/')[0] !== net.IPAddress ||
      assignment.MacAddress !== net.MacAddress
    )
      throw new Error('Transport daemon endpoint disagreement');
    // runsc transfers IP addresses from the Linux NIC to netstack at startup.
    // The daemon owns the address assignment; the kernel proves the veth peer.
    const candidates = links.filter((link) => link.ifname !== 'lo');
    if (
      candidates.some(
        (link) =>
          link.address !== net.MacAddress ||
          link.addr_info.some((a) => a.family === 'inet' && a.local !== net.IPAddress),
      )
    )
      throw new Error('Unexpected transport namespace interface');
    if (candidates.length !== 1 || candidates[0]!.link_index === undefined)
      throw new Error('Transport namespace endpoint mismatch');
    const link = candidates[0]!;
    const hosts = z
      .array(z.object({ ifindex: z.number(), ifname: z.string() }))
      .parse(JSON.parse(await io.run('/sbin/ip', ['-j', 'link', 'show'])))
      .filter((item) => item.ifindex === link.link_index);
    if (hosts.length !== 1) throw new Error('Transport host peer missing');
    const peer = endpoint.parse({
      address: net.IPAddress,
      mac: net.MacAddress,
      device: hosts[0]!.ifname,
      index: hosts[0]!.ifindex,
    });
    const root = `/sys/class/net/${peer.device}`;
    if (
      Number(await io.readFile(`${root}/iflink`)) !== link.ifindex ||
      Number(await io.readFile(`${root}/ifindex`)) !== peer.index ||
      !(await io.readlink(`${root}/master`)).endsWith('/' + binding.bridge)
    )
      throw new Error('Transport host bridge peer mismatch');
    result[role] = peer;
  }
  const transport = egressTransportSchema.parse({ ...result, codex });
  if (
    transport.sandbox.address === transport.relay.address ||
    transport.sandbox.mac === transport.relay.mac ||
    transport.sandbox.index === transport.relay.index ||
    transport.sandbox.device === transport.relay.device
  )
    throw new Error('Transport roles share an endpoint');
  return transport;
}

/** Exact pair only; never turn conntrack state into a general bridge exemption. */
export function transportRules(
  binding: ProjectEgressNetworkBinding,
  input: EgressTransport,
  family: 'inet' | 'bridge',
): string {
  const t = egressTransportSchema.parse(input);
  const ports = t.codex ? '{ 8080, 8443, 8444 }' : '{ 8080, 8443 }';
  const pair = (reverse: boolean) => {
    const [a, b] = reverse ? [t.relay, t.sandbox] : [t.sandbox, t.relay];
    return family === 'bridge'
      ? `meta ibrname "${binding.bridge}" meta obrname "${binding.bridge}" meta iif ${a.index} meta oif ${b.index} iifname "${a.device}" oifname "${b.device}" ether saddr ${a.mac} ether daddr ${b.mac}`
      : `iifname "${binding.bridge}" oifname "${binding.bridge}"`;
  };
  let rules = `${pair(false)} ip saddr ${t.sandbox.address} ip daddr ${t.relay.address} tcp dport ${ports} ct state { new, established } counter return;\n`;
  rules += `${pair(true)} ip saddr ${t.relay.address} ip daddr ${t.sandbox.address} tcp sport ${ports} ct state established counter return;\n`;
  if (family === 'bridge') {
    for (const [a, b] of [
      [t.sandbox, t.relay],
      [t.relay, t.sandbox],
    ] as const) {
      rules += `meta ibrname "${binding.bridge}" meta obrname "${binding.bridge}" meta iif ${a.index} meta oif ${b.index} iifname "${a.device}" oifname "${b.device}" ether saddr ${a.mac} ether daddr { ${b.mac}, ff:ff:ff:ff:ff:ff } arp operation { request, reply } arp saddr ether ${a.mac} arp saddr ip ${a.address} arp daddr ip ${b.address} counter return;\n`;
    }
  }
  return rules;
}
