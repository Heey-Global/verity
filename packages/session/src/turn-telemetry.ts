import type { AttachmentUpload, ResultTelemetry } from '@verity/events';

export interface TurnTelemetryOptions {
  backend: string;
  mode: string;
  prompt?: string | undefined;
  appendSystemPrompt?: string | undefined;
  submittedPrompt?: string | undefined;
  attachments?: readonly AttachmentUpload[] | undefined;
  resumed?: boolean | undefined;
}

export function buildResultTelemetry(opts: TurnTelemetryOptions): ResultTelemetry {
  return {
    backend: opts.backend,
    mode: opts.mode,
    userPromptChars: opts.prompt?.length ?? 0,
    runtimePromptChars: opts.appendSystemPrompt?.length ?? 0,
    submittedPromptChars: opts.submittedPrompt?.length ?? opts.prompt?.length ?? 0,
    attachments: opts.attachments?.length ?? 0,
    ...(opts.resumed !== undefined ? { resumed: opts.resumed } : {}),
  };
}
