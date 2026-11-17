import type { Database, EventStore } from '@verity/store';
import type { Kysely } from 'kysely';
import type { createStoreDopplerCredentials, DopplerPerson } from './doppler-credential.js';
import { resolveDopplerProjectSecret } from './doppler-secret-resolver.js';
import { createBrokeredHttpConsumptionStore } from './brokered-http-consumption.js';
import { createBrokeredHttpGrantStore } from './brokered-http-grants.js';
import { createBrokeredHttpTool } from './brokered-http-tool.js';
import { createNodeRestrictedHttpJsonTransport } from './restricted-http-json-connector.js';

export function createEmbeddedBrokeredHttp(
  db: Kysely<Database>,
  eventStore: Pick<EventStore, 'getProjectSettings'>,
  dopplerCredentialFor: ReturnType<typeof createStoreDopplerCredentials>,
  dopplerPersonId: (person: DopplerPerson) => Promise<string | null>,
) {
  const brokeredHttpConsumptions = createBrokeredHttpConsumptionStore(db);
  const brokeredHttpGrants = createBrokeredHttpGrantStore(db);
  const restrictedHttpTransport = createNodeRestrictedHttpJsonTransport();
  const getBrokeredProjectBinding = async (projectId: string) => {
    const settings = await eventStore.getProjectSettings(projectId);
    const dopplerProject = settings?.dopplerProject?.trim();
    const dopplerConfig = settings?.dopplerConfig?.trim();
    return !dopplerProject || !dopplerConfig ? undefined : { dopplerProject, dopplerConfig };
  };
  const resolveBrokerDopplerSecret = async ({
    person,
    ...input
  }: Omit<Parameters<typeof resolveDopplerProjectSecret>[0], 'token'> & {
    person: DopplerPerson;
  }): Promise<Uint8Array> => {
    const token = await dopplerCredentialFor(await dopplerPersonId(person), input.projectId);
    try {
      return await resolveDopplerProjectSecret({ ...input, token });
    } finally {
      token.fill(0);
    }
  };
  const brokeredHttpTool = createBrokeredHttpTool({
    requireApprovalBinding: true,
    getProjectBinding: getBrokeredProjectBinding,
    resolveSecret: resolveBrokerDopplerSecret,
    consumeApproval: (input) => brokeredHttpConsumptions.consume(input),
    transport: restrictedHttpTransport,
  });

  return {
    brokeredHttpConsumptions,
    brokeredHttpGrants,
    getBrokeredProjectBinding,
    resolveBrokerDopplerSecret,
    brokeredHttpTool,
  };
}
