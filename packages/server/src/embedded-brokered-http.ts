import { dopplerBindingGrantId, type Database, type EventStore } from '@verity/store';
import type { Kysely } from 'kysely';
import type { createStoreDopplerCredentials, DopplerPerson } from './doppler-credential.js';
import { resolveDopplerProjectSecret } from './doppler-secret-resolver.js';
import { createBrokeredHttpConsumptionStore } from './brokered-http-consumption.js';
import { createBrokeredHttpGrantStore } from './brokered-http-grants.js';
import { brokeredDopplerBindingId, defaultDopplerGrantMember } from './brokered-doppler-binding.js';
import {
  createBrokeredHttpTool,
  referencedSnapshot,
  type BrokeredHttpProjectBinding,
} from './brokered-http-tool.js';
import { createNodeRestrictedHttpJsonTransport } from './restricted-http-json-connector.js';

export function createEmbeddedBrokeredHttp(
  db: Kysely<Database>,
  eventStore: Pick<EventStore, 'projectDopplerBindings'>,
  dopplerCredentialFor: ReturnType<typeof createStoreDopplerCredentials>,
  dopplerPersonId: (person: DopplerPerson) => Promise<string | null>,
) {
  const brokeredHttpConsumptions = createBrokeredHttpConsumptionStore(db);
  const brokeredHttpGrants = createBrokeredHttpGrantStore(db);
  const restrictedHttpTransport = createNodeRestrictedHttpJsonTransport();
  /** The project's Doppler bindings (ADR 0031); empty when it has none. */
  const getBrokeredProjectBindings = async (
    projectId: string,
  ): Promise<readonly BrokeredHttpProjectBinding[]> =>
    (await eventStore.projectDopplerBindings.list(projectId)).map((binding) => ({
      id: binding.id,
      connectionId: binding.connectionId,
      ...(binding.tokenRevision === undefined ? {} : { tokenRevision: binding.tokenRevision }),
      dopplerProject: binding.dopplerProject,
      dopplerConfig: binding.dopplerConfig,
      isDefault: binding.isDefault,
    }));
  // Grants are kept per Doppler binding (ADR 0031): the ids of the project's
  // current bindings, against which a grant's binding id is checked.
  const brokeredGrantBindingIds = async (projectId: string): Promise<ReadonlySet<string>> =>
    new Set(
      (await getBrokeredProjectBindings(projectId)).flatMap((binding) => {
        const id = dopplerBindingGrantId(binding);
        return binding.isDefault ? [id, defaultDopplerGrantMember(id)] : [id];
      }),
    );
  /** The grant binding id of a call reading these references; undefined when one
   *  of them names no current binding, so nothing is auto-approved for it. */
  const brokeredGrantBindingIdFor = async (
    projectId: string,
    references: readonly string[],
  ): Promise<string | undefined> => {
    try {
      return brokeredDopplerBindingId(
        referencedSnapshot(await getBrokeredProjectBindings(projectId), references),
      );
    } catch {
      return undefined;
    }
  };
  const resolveBrokerDopplerSecret = async ({
    person,
    connectionId,
    ...input
  }: Omit<Parameters<typeof resolveDopplerProjectSecret>[0], 'token'> & {
    connectionId: string;
    person: DopplerPerson;
  }): Promise<Uint8Array> => {
    const token = await dopplerCredentialFor(
      await dopplerPersonId(person),
      input.projectId,
      connectionId,
    );
    try {
      return await resolveDopplerProjectSecret({ ...input, token });
    } finally {
      token.fill(0);
    }
  };
  const brokeredHttpTool = createBrokeredHttpTool({
    requireApprovalBinding: true,
    getProjectBindings: getBrokeredProjectBindings,
    resolveSecret: resolveBrokerDopplerSecret,
    consumeApproval: (input) => brokeredHttpConsumptions.consume(input),
    transport: restrictedHttpTransport,
  });

  return {
    brokeredHttpConsumptions,
    brokeredHttpGrants,
    getBrokeredProjectBindings,
    brokeredGrantBindingIds,
    brokeredGrantBindingIdFor,
    resolveBrokerDopplerSecret,
    brokeredHttpTool,
  };
}
