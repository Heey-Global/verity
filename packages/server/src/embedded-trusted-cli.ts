import type { Database, SecretCipher } from '@verity/store';
import type { Kysely } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { createEmbeddedBrokeredHttp } from './embedded-brokered-http.js';
import { createTrustedCliOutputStore } from './trusted-cli-output.js';
import { createTrustedCliTool } from './trusted-cli-tool.js';

export function createEmbeddedTrustedCli(
  db: Kysely<Database>,
  secretCipher: SecretCipher,
  {
    getBrokeredProjectBinding,
    resolveBrokerDopplerSecret,
    brokeredHttpConsumptions,
  }: Pick<
    ReturnType<typeof createEmbeddedBrokeredHttp>,
    'getBrokeredProjectBinding' | 'resolveBrokerDopplerSecret' | 'brokeredHttpConsumptions'
  >,
) {
  const trustedCliOutput = createTrustedCliOutputStore(db, secretCipher);
  const trustedCliTool = createTrustedCliTool({
    requireApprovalBinding: true,
    outputStore: trustedCliOutput,
    getProjectBinding: getBrokeredProjectBinding,
    resolveSecret: resolveBrokerDopplerSecret,
    consumeApproval: (input) => brokeredHttpConsumptions.consume(input),
  });

  return { trustedCliOutput, trustedCliTool };
}

export async function installEmbeddedTrustedCli(
  app: FastifyInstance,
  { trustedCliOutput }: Pick<ReturnType<typeof createEmbeddedTrustedCli>, 'trustedCliOutput'>,
): Promise<void> {
  await trustedCliOutput.cleanup();
  let outputSweepRunning = false;
  const outputSweep = setInterval(() => {
    if (outputSweepRunning) return;
    outputSweepRunning = true;
    void trustedCliOutput
      .cleanup()
      .catch(() => {
        console.warn('verity: trusted CLI output cleanup failed');
      })
      .finally(() => {
        outputSweepRunning = false;
      });
  }, 60_000);
  outputSweep.unref();
  app.addHook('onClose', () => clearInterval(outputSweep));
}
