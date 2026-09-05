const projectDopplerCredentialKey = (key: string): boolean =>
  key === 'DOPPLER_TOKEN' || key === 'VERITY_DOPPLER_TOKEN_REF' || key.startsWith('DOPPLER_TOKEN_');

/** Project-scoped Doppler credentials violate the central-broker trust boundary. */
export function forbiddenDopplerCredentialEnvironmentKeys(
  environment: NodeJS.ProcessEnv,
): string[] {
  return Object.keys(environment).filter(projectDopplerCredentialKey).sort();
}
