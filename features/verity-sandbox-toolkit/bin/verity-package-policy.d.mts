export interface ReleaseDelayDetection {
  protected: boolean;
  setupSupported?: boolean;
  path: string;
  key: string;
  value?: string | undefined;
}
export const RELEASE_DELAY_POLICIES: Record<
  string,
  {
    minimumVersion: string;
    file: string;
    key: string;
    value: string;
    unit?: number;
    section?: string;
  }
>;
export function supportsReleaseDelay(manager: string, version: string): boolean;
export function classifyInstall(manager: string, args: readonly string[]): boolean;
export function effectiveInstallDirectory(
  manager: string,
  args: readonly string[],
  cwd: string,
): string;
export function detectReleaseDelay(
  manager: string,
  cwd: string,
  env?: Record<string, string | undefined>,
  version?: string,
): ReleaseDelayDetection;
export function configureReleaseDelay(
  manager: string,
  cwd: string,
  version: string,
  env?: Record<string, string | undefined>,
): ReleaseDelayDetection;
