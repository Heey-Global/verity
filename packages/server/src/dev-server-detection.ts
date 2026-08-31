import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { minimatch } from 'minimatch';

const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_WORKSPACE_MANIFESTS = 200;
const MAX_VISITED_DIRECTORIES = 1_000;
const MAX_WORKSPACE_DEPTH = 6;
const MAX_STANDALONE_DEPTH = 2;
const SCRIPT_NAMES = ['dev', 'start:dev', 'serve', 'preview', 'storybook'] as const;

export interface DevServerSuggestion {
  key: string;
  name: string;
  command: string;
  workdir: string | null;
  containerPort: string | null;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
}

interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface FoundManifest {
  path: string;
  manifest: PackageManifest;
}

export async function detectDevServers(repoRoot: string): Promise<DevServerSuggestion[]> {
  const root = resolve(repoRoot);
  const rootManifestPath = join(root, 'package.json');
  const rootManifest = await readManifest(rootManifestPath);
  if (!rootManifest && (await pathExists(rootManifestPath))) return [];
  const manifests = rootManifest
    ? await workspaceManifests(root, rootManifest)
    : await standaloneManifests(root);
  if (manifests.length === 0) return [];
  const rootPackageManager = (await lockfilePackageManager(root)) ?? 'npm';

  const suggestions: DevServerSuggestion[] = [];
  for (const { path, manifest } of manifests) {
    // Standalone packages install on their own, so their lockfile wins over the repo root's.
    const packageManager = rootManifest
      ? rootPackageManager
      : ((await lockfilePackageManager(dirname(path))) ?? rootPackageManager);
    suggestions.push(...suggestionsForManifest(root, path, manifest, packageManager));
  }
  return [...new Map(suggestions.map((suggestion) => [suggestion.key, suggestion])).values()];
}

async function workspaceManifests(
  root: string,
  rootManifest: PackageManifest,
): Promise<FoundManifest[]> {
  const patterns = new Set(workspacePatterns(rootManifest));
  for (const pattern of await pnpmWorkspacePatterns(root)) patterns.add(pattern);
  const manifests: FoundManifest[] = [{ path: join(root, 'package.json'), manifest: rootManifest }];

  for (const dir of await expandWorkspacePatterns(root, [...patterns])) {
    if (manifests.length >= MAX_WORKSPACE_MANIFESTS) break;
    const path = join(dir, 'package.json');
    const manifest = await readManifest(path);
    if (manifest) manifests.push({ path, manifest });
  }
  return manifests;
}

/**
 * Polyrepos have no root package.json but still ship apps in subdirectories (apps/web,
 * services/admin). Walk the top of the tree and treat the first manifest on each branch as a
 * standalone package.
 */
async function standaloneManifests(root: string): Promise<FoundManifest[]> {
  const manifests: FoundManifest[] = [];
  let visitedDirectories = 0;

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_STANDALONE_DEPTH) return;
    if (
      manifests.length >= MAX_WORKSPACE_MANIFESTS ||
      visitedDirectories++ >= MAX_VISITED_DIRECTORIES
    )
      return;
    for (const entry of await safeDirectories(dir)) {
      if (manifests.length >= MAX_WORKSPACE_MANIFESTS) return;
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const child = join(dir, entry);
      const path = join(child, 'package.json');
      const manifest = await readManifest(path);
      if (manifest) {
        manifests.push({ path, manifest });
        continue;
      }
      await visit(child, depth + 1);
    }
  };

  await visit(root, 1);
  return manifests;
}

function suggestionsForManifest(
  root: string,
  manifestPath: string,
  manifest: PackageManifest,
  packageManager: 'npm' | 'pnpm' | 'yarn',
): DevServerSuggestion[] {
  const scripts = manifest.scripts ?? {};
  const workdir = relative(root, dirname(manifestPath)).split(sep).join('/') || null;
  const packageName = displayName(manifest.name, workdir);
  return SCRIPT_NAMES.flatMap((scriptName) => {
    const rawScript = scripts[scriptName];
    const script = typeof rawScript === 'string' ? rawScript.trim() : '';
    if (!script) return [];
    const explicitPort = explicitPortFromScript(script);
    const framework = detectFramework(script);
    const containerPort = explicitPort ?? framework?.port ?? null;
    return [
      {
        key: `${workdir ?? '.'}:${scriptName}`,
        name: scriptName === 'dev' ? packageName : `${packageName} ${scriptName}`,
        command: `${packageManager} run ${scriptName}`,
        workdir,
        containerPort,
        confidence: explicitPort ? 'high' : framework ? 'medium' : 'low',
        evidence: explicitPort
          ? `package.json script "${scriptName}" declares port ${explicitPort}`
          : framework
            ? `${framework.name} default from package.json script "${scriptName}"`
            : `package.json script "${scriptName}"`,
      },
    ];
  });
}

function explicitPortFromScript(script: string): string | null {
  const match = /(?:^|\s)(?:--port(?:=|\s+)|-p\s+)(\d{2,5})(?=\s|$)/.exec(script);
  if (!match?.[1]) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? match[1] : null;
}

function detectFramework(script: string): { name: string; port: string } | null {
  // Wrappers such as `doppler run -- sh -c '… vite dev'` quote the inner command, so a quote
  // counts as a word boundary alongside whitespace.
  const candidates: Array<[string, RegExp, string]> = [
    ['Vite preview', /(?:^|[\s'"])(?:vite|vp)\s+preview(?=[\s'"]|$)/, '4173'],
    ['Vite', /(?:^|[\s'"])vite(?=[\s'"]|$)/, '5173'],
    ['Vite', /(?:^|[\s'"])vp\s+dev(?=[\s'"]|$)/, '5173'],
    ['Next.js', /(?:^|[\s'"])next\s+dev(?=[\s'"]|$)/, '3000'],
    ['Astro', /(?:^|[\s'"])astro\s+dev(?=[\s'"]|$)/, '4321'],
    ['Storybook', /(?:^|[\s'"])storybook\s+dev(?=[\s'"]|$)/, '6006'],
    ['Expo', /(?:^|[\s'"])expo\s+start(?=[\s'"]|$)/, '8081'],
  ];
  for (const [name, command, port] of candidates) {
    if (command.test(script)) return { name, port };
  }
  return null;
}

async function readManifest(path: string): Promise<PackageManifest | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) return null;
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function workspacePatterns(manifest: PackageManifest): string[] {
  if (Array.isArray(manifest.workspaces)) {
    return manifest.workspaces.filter((pattern): pattern is string => typeof pattern === 'string');
  }
  const packages =
    manifest.workspaces && typeof manifest.workspaces === 'object'
      ? manifest.workspaces.packages
      : undefined;
  return Array.isArray(packages)
    ? packages.filter((pattern): pattern is string => typeof pattern === 'string')
    : [];
}

async function pnpmWorkspacePatterns(root: string): Promise<string[]> {
  const path = join(root, 'pnpm-workspace.yaml');
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) return [];
    const content = await readFile(path, 'utf8');
    return [...content.matchAll(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*$/gm)].map((match) =>
      match[1]!.trim(),
    );
  } catch {
    return [];
  }
}

async function expandWorkspacePatterns(root: string, rawPatterns: string[]): Promise<string[]> {
  const patterns = rawPatterns.flatMap((rawPattern) => {
    const negated = rawPattern.startsWith('!');
    const pattern = rawPattern
      .slice(negated ? 1 : 0)
      .replace(/^\.\//, '')
      .replace(/\/$/, '');
    if (!pattern || pattern.startsWith('/') || pattern.split('/').includes('..')) return [];
    return [{ pattern, negated }];
  });
  if (!patterns.some(({ negated }) => !negated)) return [];
  const found: string[] = [];
  let visitedDirectories = 0;

  const visit = async (dir: string): Promise<void> => {
    const depth = relative(root, dir).split(sep).filter(Boolean).length;
    if (found.length >= MAX_WORKSPACE_MANIFESTS || depth > MAX_WORKSPACE_DEPTH) return;
    if (depth > 0) {
      const candidate = relative(root, dir).split(sep).join('/');
      let included = false;
      for (const { pattern, negated } of patterns) {
        if (minimatch(candidate, pattern, { dot: false, nonegate: true })) included = !negated;
      }
      if (included) found.push(dir);
      const canContainWorkspace = patterns.some(
        ({ pattern, negated }) =>
          !negated && minimatch(candidate, pattern, { dot: false, nonegate: true, partial: true }),
      );
      if (!canContainWorkspace) return;
    }
    if (visitedDirectories++ >= MAX_VISITED_DIRECTORIES) return;
    for (const entry of await safeDirectories(dir)) await visit(join(dir, entry));
  };

  await visit(root);
  return found;
}

async function safeDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          entry.name !== 'node_modules' &&
          entry.name !== '.git' &&
          entry.name !== '.verity-sessions',
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function lockfilePackageManager(dir: string): Promise<'npm' | 'pnpm' | 'yarn' | null> {
  if (await isFile(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await isFile(join(dir, 'yarn.lock'))) return 'yarn';
  if (await isFile(join(dir, 'package-lock.json'))) return 'npm';
  return null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function displayName(name: string | undefined, workdir: string | null): string {
  const candidate =
    (typeof name === 'string' ? name.split('/').at(-1)?.trim() : undefined) ||
    (workdir ? basename(workdir) : 'Dev server');
  return candidate
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}
