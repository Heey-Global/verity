const legacyDopplerCredentialKey = (key: string): boolean =>
  key === 'DOPPLER_TOKEN' || key === 'VERITY_DOPPLER_TOKEN_REF' || key.startsWith('DOPPLER_TOKEN_');

export function legacyDopplerCredentialEnvironmentKeys(environment: NodeJS.ProcessEnv): string[] {
  return Object.keys(environment).filter(legacyDopplerCredentialKey).sort();
}
