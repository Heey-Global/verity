export function npmInstallPlan(
  args: readonly string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): {
  root: string;
  resolveArgs: string[] | undefined;
  installArgs: string[] | undefined;
};
export function npmLockedPackages(root: string): {
  packages: { name: string; version: string }[];
  source: string;
  path: string;
};
export function npmProjectRoot(
  executable: string,
  directory: string,
  env: Record<string, string | undefined>,
  args: readonly string[],
): string;
export function npmStateDirectory(root: string): string;
export function preserveNpmDependencies(root: string): string | undefined;
export function lockNpmProject(
  root: string,
  env: Record<string, string | undefined>,
): Promise<{ fd: number; release(): void }>;
