import { randomUUID } from 'node:crypto';

export interface NpmInstallPolicy {
  minimumAgeDays: number;
  packages: ReadonlySet<string>;
  exceptions: ReadonlySet<string>;
}
interface InstallGrant {
  sourceToken: string;
  projectId: string;
  containerGeneration: string;
  sessionId: string;
  policy: NpmInstallPolicy;
  expires: number;
}

// These receipts authorize one bounded install, not future project installations.
const grants = new Map<string, InstallGrant>();
export function createNpmInstallGrant(input: Omit<InstallGrant, 'expires'>): string {
  for (const [token, grant] of grants) if (grant.expires <= Date.now()) grants.delete(token);
  if (grants.size >= 256) throw new Error('Package installation capacity reached; retry later.');
  const token = randomUUID();
  grants.set(token, { ...input, expires: Date.now() + 30 * 60_000 });
  return token;
}
export function npmInstallGrant(token: string): InstallGrant | undefined {
  const grant = grants.get(token);
  if (grant && grant.expires > Date.now()) return grant;
  grants.delete(token);
  return undefined;
}
export function revokeNpmInstallGrant(token: string): void {
  grants.delete(token);
}

export function npmPackageIdentity(name: string, version: string): string {
  return `${name}@${version}`;
}

export function npmReleaseEligibility(
  published: unknown,
  minimumAgeDays: number,
  now = Date.now(),
): { eligible: boolean; availableAt?: string } {
  if (
    typeof published !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(published)
  )
    return { eligible: false };
  const time = Date.parse(published);
  const available = time + Math.max(3, minimumAgeDays) * 86_400_000;
  if (!Number.isFinite(time) || !Number.isFinite(available) || Math.abs(available) > 8.64e15)
    return { eligible: false };
  if (new Date(time).toISOString().slice(0, 19) !== published.slice(0, 19))
    return { eligible: false };
  return { eligible: available <= now, availableAt: new Date(available).toISOString() };
}
