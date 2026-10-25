export function packageInstallSummary(input: unknown): {
  title: string;
  command: string;
  explanation: string;
  allowLabel: string;
  denyLabel: string;
  supported: boolean;
} | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const request = input as Record<string, unknown>;
  if (
    typeof request.command !== 'string' ||
    typeof request.manager !== 'string' ||
    typeof request.supported !== 'boolean'
  )
    return null;
  return {
    title: 'The agent wants to install dependencies',
    command: request.command,
    explanation: request.supported
      ? 'We recommend a 3-day delay: newly selected versions must be at least 3 days old. This reduces the risk of compromised releases. Set it up?'
      : `Verity can't delay new versions for ${request.manager} here. Install anyway?`,
    allowLabel: request.supported ? 'Set up delay' : 'Install anyway',
    denyLabel: request.supported ? 'Skip' : 'Cancel',
    supported: request.supported,
  };
}

export function packageInstallDecision(
  supported: boolean,
  choice: 'primary' | 'secondary',
): PermissionDecision {
  if (!supported && choice === 'secondary') return { behavior: 'deny' };
  return {
    behavior: 'allow',
    updatedInput: { action: choice === 'secondary' ? 'skip' : supported ? 'configure' : 'install' },
  };
}
import type { PermissionDecision } from '../api.js';
