import { createHash } from 'node:crypto';

import {
  canonicalJson,
  trustedCliRequestSchema,
  type TrustedCliEntryScript,
} from '@verity/secret-contracts';
import type { BrokeredHttpProjectBinding, BrokeredToolCall } from './brokered-http-tool.js';

export type TrustedCliToolResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: true;
  truncated?: true;
};

const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function createTrustedCliTool(options: {
  getProjectBinding: (projectId: string) => Promise<BrokeredHttpProjectBinding | undefined>;
  resolveSecret: (input: {
    projectId: string;
    dopplerProject: string;
    dopplerConfig: string;
    secretName: string;
  }) => Promise<Uint8Array>;
  consumeApproval: (input: {
    projectId: string;
    sessionId: string;
    turnId: string;
    callId: string;
    requestHash: string;
  }) => Promise<boolean>;
}) {
  return async (
    projectId: string,
    sessionId: string,
    turnId: string,
    call: BrokeredToolCall,
    execute: (input: {
      turnId: string;
      secrets: readonly {
        secretAlias: string;
        env: string;
        injection?: 'env' | 'file';
        secret: string;
        encoding?: 'base64';
      }[];
      command: readonly string[];
      entryScript?: TrustedCliEntryScript;
    }) => Promise<TrustedCliToolResult>,
  ): Promise<TrustedCliToolResult> => {
    if (call.name !== 'verity_secret_run') {
      throw new Error('invalid trusted CLI tool call');
    }
    const request = trustedCliRequestSchema.parse(call.input);
    const requestHash = createHash('sha256')
      .update(canonicalJson({ tool: call.name, request }))
      .digest('hex');
    if (
      !(await options.consumeApproval({
        projectId,
        sessionId,
        turnId,
        callId: call.id,
        requestHash,
      }))
    ) {
      throw new Error('trusted CLI approval was already consumed');
    }
    const binding = await options.getProjectBinding(projectId);
    if (binding === undefined) throw new Error('project Doppler binding is unavailable');
    const resolved: Uint8Array[] = [];
    try {
      const secrets: {
        secretAlias: string;
        env: string;
        injection?: 'env' | 'file';
        secret: string;
      }[] = [];
      // Resolve every alias before spawning anything. A run that would die on its
      // third secret must not have already started the command with the first two
      // in its environment.
      for (const entry of request.secrets) {
        const raw = await options.resolveSecret({
          projectId,
          dopplerProject: binding.dopplerProject,
          dopplerConfig: binding.dopplerConfig,
          secretName: entry.secretAlias,
        });
        resolved.push(raw);
        let secret: string;
        let encoding: 'base64' | undefined;
        if (entry.injection === 'file') {
          secret = Buffer.from(raw).toString('base64');
          encoding = 'base64';
        } else {
          try {
            secret = fatalUtf8Decoder.decode(raw);
          } catch {
            throw new Error(`trusted CLI secret ${entry.secretAlias} is not valid UTF-8`);
          }
        }
        if (secret.length === 0 || (encoding === undefined && secret.includes('\0'))) {
          throw new Error(
            `trusted CLI secret ${entry.secretAlias} is not valid for environment injection`,
          );
        }
        secrets.push({
          secretAlias: entry.secretAlias,
          env: entry.env,
          ...(entry.injection === undefined ? {} : { injection: entry.injection }),
          secret,
          ...(encoding === undefined ? {} : { encoding }),
        });
      }
      return await execute({
        turnId,
        secrets,
        command: request.command,
        ...(request.entryScript === undefined ? {} : { entryScript: request.entryScript }),
      });
    } finally {
      for (const secret of resolved) secret.fill(0);
    }
  };
}
