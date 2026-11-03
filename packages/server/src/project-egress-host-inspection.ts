import { z } from 'zod';
import {
  inspectEgressHostContainer,
  inspectEgressHostNetwork,
  projectEgressHostDocker,
} from './project-egress-host-runtime.js';
import { inspectEgressTransport } from './project-egress-transport.js';
import type { ProjectEgressNetworkBinding } from './project-egress-host.js';
import type { EgressRelayPolicy } from './project-egress-relay-policy.js';

/** Fresh facts for one validation phase, never shared across requests or admission writes. */
export async function withEgressHostInspection<T>(
  ids: { sandbox: string; relay: string },
  inspect: (docker: typeof projectEgressHostDocker) => Promise<T>,
  docker = projectEgressHostDocker,
): Promise<T> {
  const objectId = z.string().regex(/^[a-f0-9]{64}$/u);
  objectId.parse(ids.sandbox);
  objectId.parse(ids.relay);
  if (ids.sandbox === ids.relay) throw new Error('Inspection requires two distinct containers');
  const values = z
    .array(z.object({ Id: objectId }).passthrough())
    .length(2)
    .parse(JSON.parse(await docker('container', 'inspect', ids.sandbox, ids.relay)));
  const replies = new Map(values.map((value) => [value.Id, JSON.stringify([value])]));
  if (replies.size !== 2 || !replies.has(ids.sandbox) || !replies.has(ids.relay))
    throw new Error('Inspection container identities changed');
  const phase = new Map<string, Promise<string>>();
  const read: typeof docker = (...args) => {
    if (
      (args[0] === 'inspect' && args.length === 2) ||
      (args[0] === 'container' && args[1] === 'inspect' && args.length === 3)
    ) {
      const id = args.at(-1)!;
      const reply = replies.get(id);
      if (!reply) return Promise.reject(new Error('Container outside inspection phase'));
      return Promise.resolve(reply);
    }
    // Only immutable-in-this-phase inspection replies may be reused. Mutations
    // and unrecognized commands are rejected, rather than silently memoized.
    if (!(
      (args[0] === 'info' && args[1] === '--format' && args.length === 3) ||
      (['network', 'image', 'volume'].includes(args[0]!) &&
        args[1] === 'inspect' &&
        args.length === 3)
    ))
      return Promise.reject(new Error('Unsupported inspection command'));
    const key = JSON.stringify(args);
    let result = phase.get(key);
    if (!result) {
      result = docker(...args);
      phase.set(key, result);
    }
    return result;
  };
  return inspect(read);
}

export async function inspectEgressHostDirectTransport(
  binding: ProjectEgressNetworkBinding,
  ids: { sandbox: string; relay: string },
  policy: EgressRelayPolicy,
) {
  return withEgressHostInspection(ids, async (docker) => {
    for (const role of ['sandbox', 'relay'] as const)
      await inspectEgressHostContainer(binding, ids[role], role, policy, false, docker);
    await inspectEgressHostNetwork(binding, [ids.sandbox, ids.relay], docker);
    return inspectEgressTransport(
      binding,
      ids,
      policy.codexSubpath !== undefined,
      undefined,
      docker,
    );
  });
}
