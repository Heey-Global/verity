import { ALLOWED_PERMISSION_MODES } from '@verity/session';
import { parseUnixBaseUrl } from './docker.js';
import { isUntaggedImageRepository } from './embedded-support.js';
import type { EmbeddedServerConfig } from './embedded-types.js';
import { validateRuntimeReadinessTtl } from './runtime-readiness-gate.js';

export function validateEmbeddedConfig(config: EmbeddedServerConfig): void {
  const untypedConfig = config as EmbeddedServerConfig & Record<string, unknown>;
  for (const removed of [
    'signingBrokerUrl',
    'sandboxNetwork',
    'perProjectNetwork',
    'selfContainerName',
  ]) {
    if (untypedConfig[removed] !== undefined) {
      throw new Error(`${removed} was removed; project relay wiring is mandatory`);
    }
  }
  if (
    config.permissionMode !== undefined &&
    !(ALLOWED_PERMISSION_MODES as readonly string[]).includes(config.permissionMode)
  ) {
    throw new Error(
      `invalid permissionMode "${config.permissionMode}": expected one of ${ALLOWED_PERMISSION_MODES.join(', ')}`,
    );
  }
  if (
    config.secretJobRuntimeRequired === true &&
    config.secretJobRuntimeReadiness === undefined &&
    config.dockerBaseUrl === undefined
  ) {
    throw new Error('dockerBaseUrl is required when the Secret Job runtime is required');
  }
  validateRuntimeReadinessTtl(config.secretJobRuntimeReadinessTtlMs);
  if (config.secretJobs !== undefined) {
    if (
      (config.secretJobs.resolveSecrets === undefined) ===
      (config.secretJobs.doppler === undefined)
    ) {
      throw new Error('Secret Jobs require exactly one of resolveSecrets or doppler');
    }
    if (
      config.secretJobs.doppler !== undefined &&
      config.secretJobs.authorizeProviderAdministration === undefined
    ) {
      throw new Error('Doppler Secret Jobs require provider administration authorization');
    }
    if (config.dockerBaseUrl === undefined) {
      throw new Error('dockerBaseUrl is required when Secret Jobs are configured');
    }
    if (!config.dockerBaseUrl.startsWith('unix://')) {
      throw new Error('Secret Jobs require a unix Docker socket for authenticated attach');
    }
    const { socketPath } = parseUnixBaseUrl(config.dockerBaseUrl);
    if (!socketPath.startsWith('/') || socketPath === '/') {
      throw new Error('Secret Jobs require an absolute, non-empty unix Docker socket path');
    }
    if (!isUntaggedImageRepository(config.secretJobs.executorImageRepository)) {
      throw new Error('Secret Job executor image repository must be an untagged repository');
    }
  }
}
