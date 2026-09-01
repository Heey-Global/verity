import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface RenovateConfig {
  extends?: string[];
  semanticCommits?: string;
  ignorePaths?: string[];
  npmrc?: string;
  npmrcMerge?: boolean;
  enabledManagers?: string[];
  customManagers: Array<{
    description?: string;
    matchStrings?: string[];
  }>;
  packageRules: Array<{
    description?: string;
    enabled?: boolean;
    groupName?: string;
    groupSlug?: string;
    matchDatasources?: string[];
    matchFileNames?: string[];
    matchManagers?: string[];
    matchPackageNames?: string[];
    semanticCommitType?: string;
  }>;
  dockerfile?: { managerFilePatterns?: string[]; fileMatch?: string[] };
}

describe('Renovate global CLI pins', () => {
  it('detects every CLI installed directly in the server image', () => {
    const config = JSON.parse(readFileSync('renovate.json', 'utf8')) as RenovateConfig;
    const manager = config.customManagers.find((candidate) =>
      candidate.description?.startsWith('Track globally-installed CLIs'),
    );
    const matchString = manager?.matchStrings?.[0];
    expect(matchString).toBeDefined();

    const dockerfile = readFileSync('deploy/Dockerfile', 'utf8');
    const dependencies = [...dockerfile.matchAll(new RegExp(matchString as string, 'g'))].map(
      (match) => ({
        datasource: match.groups?.datasource,
        depName: match.groups?.depName,
        currentValue: match.groups?.currentValue,
      }),
    );
    const installedCliNames = [...dockerfile.matchAll(/^RUN npm install -g (.+)@(\S+)$/gm)].map(
      (match) => match[1],
    );

    expect(dependencies.map(({ depName }) => depName).sort()).toEqual(installedCliNames.sort());

    expect(dependencies).toEqual(
      expect.arrayContaining([
        {
          datasource: 'npm',
          depName: '@devcontainers/cli',
          currentValue: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        },
        {
          datasource: 'npm',
          depName: '@anthropic-ai/claude-code',
          currentValue: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        },
        {
          datasource: 'npm',
          depName: '@openai/codex',
          currentValue: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        },
      ]),
    );
  });
});

/**
 * The website's release train rests on this one rule. Renovate types a Docker
 * bump `chore` by default, release-please releases nothing for a `chore`, and
 * the cluster pins a released version — so without the rule an nginx security
 * bump publishes a `sha-<commit>` image that no pin can ever reach. That is a
 * quiet failure: everything is green, the site just keeps serving the old base
 * image. Nothing else in the repository would notice.
 */
describe('Renovate website release typing', () => {
  const config = JSON.parse(readFileSync('renovate.json', 'utf8')) as RenovateConfig;
  const index = config.packageRules.findIndex((rule) =>
    rule.description?.startsWith("Type the website's base-image bumps"),
  );
  const rule = config.packageRules[index];
  // Every test below reads the file the rule names. Deleting the rule would
  // otherwise leave them passing against `undefined` — `not.toContain(undefined)`
  // is true of everything — so the one thing they all guard would be the one
  // thing none of them noticed.
  const requireDockerfile = () => {
    const dockerfile = rule?.matchFileNames?.[0];
    expect(dockerfile, 'the rule that makes an nginx bump a website release is gone').toBeDefined();
    return dockerfile as string;
  };

  it('types the website base-image bump as a release', () => {
    expect(index, 'the rule that makes an nginx bump a website release is gone').toBeGreaterThan(
      -1,
    );
    expect(rule?.semanticCommitType).toBe('fix');
    // Taken from the rule rather than restated: a Dockerfile that moved without
    // the rule following it matches nothing, and a rule matching nothing fails
    // exactly the way not having the rule does.
    expect(rule?.matchFileNames?.length).toBe(1);
    const dockerfile = rule?.matchFileNames?.[0] as string;
    expect(existsSync(dockerfile), `${dockerfile} is named by the rule but does not exist`).toBe(
      true,
    );
    // `semanticCommitType` is only read when semantic commits are on. Turning
    // them off repository-wide is a plausible thing to want, and it would leave
    // this rule syntactically fine and the train permanently quiet.
    expect(config.extends).toContain(':semanticCommits');
    expect(config.semanticCommits, 'semantic commits are off, so the type is ignored').not.toBe(
      'disabled',
    );
  });

  it('leaves the manager and the path enabled at all', () => {
    // A type only applies to a bump Renovate decided to make. Three settings
    // stop it deciding, none of them anywhere near the rule: a repository-level
    // `ignorePaths` covering the file, an `enabledManagers` allowlist that omits
    // `dockerfile`, or a packageRule disabling either. Each leaves the rule and
    // the test above intact, and the base image quietly never bumps again.
    expect(config.ignorePaths, 'ignorePaths could cover the website Dockerfile').toBeUndefined();
    expect(
      config.enabledManagers,
      'an allowlist could omit the dockerfile manager',
    ).toBeUndefined();
    const dockerfile = requireDockerfile();
    for (const candidate of config.packageRules) {
      if (candidate.enabled !== false) continue;
      const named = `"${candidate.description ?? 'a rule'}"`;
      expect(
        candidate.matchFileNames ?? [],
        `${named} disables the website Dockerfile`,
      ).not.toContain(dockerfile);
      expect(
        candidate.matchManagers ?? [],
        `${named} disables the manager that reads it`,
      ).not.toContain('dockerfile');
    }
  });

  it('leaves the dockerfile manager on its defaults, which is what finds the file', () => {
    // A `packageRule` only types a bump the manager already found. The stock
    // dockerfile manager scans any `Dockerfile`; narrowing it — a
    // `managerFilePatterns` scoped to `deploy/`, say — would stop base-image
    // bumps for this file being detected at all, and the rule above would go on
    // matching a file Renovate never reads. That failure is silent in both
    // directions, so the override is asserted absent rather than reasoned about.
    expect(config.dockerfile?.managerFilePatterns).toBeUndefined();
    expect(config.dockerfile?.fileMatch).toBeUndefined();
  });

  it('is not undone by a later rule', () => {
    // Renovate resolves packageRules in order and the last match wins, so a rule
    // added below this one that also types Docker bumps would silently restore
    // the `chore` behaviour without touching anything named here. Exact paths
    // only — a later rule could still reach this file through a glob, which no
    // check short of running Renovate would see.
    const dockerfile = requireDockerfile();
    for (const later of config.packageRules.slice(index + 1)) {
      if (later.semanticCommitType === undefined) continue;
      const named = `"${later.description ?? 'a later rule'}"`;
      expect(
        later.matchFileNames,
        `${named} sets a commit type with no file filter, so it re-types every file`,
      ).toBeDefined();
      expect(later.matchFileNames ?? [], `${named} re-types the website Dockerfile`).not.toContain(
        dockerfile,
      );
    }
  });

  it('is not batched into a group that types the branch for it', () => {
    // A grouped upgrade takes its commit message from the group, not from each
    // member: batching this bump into a shared Docker-digest group would leave
    // the rule matching and the commit typed `chore` again. A rule reaches it
    // four ways, and naming the file is the least likely of them — the existing
    // groups here all match by package name. So the base image is read out of
    // the Dockerfile and checked too. Only this repository's own rules are
    // checked; a preset in `extends` could group it and nothing short of
    // running Renovate would see that.
    const dockerfile = requireDockerfile();
    const baseImage = /^FROM\s+([^\s:@]+)/m.exec(readFileSync(dockerfile, 'utf8'))?.[1];
    expect(baseImage, `${dockerfile} has no FROM line to read a base image from`).toBeDefined();
    for (const candidate of config.packageRules) {
      if (candidate.groupName === undefined && candidate.groupSlug === undefined) continue;
      const named = `"${candidate.description ?? 'a rule'}"`;
      const reaches = [
        [candidate.matchFileNames, dockerfile, 'names the website Dockerfile'],
        [candidate.matchManagers, 'dockerfile', 'matches every Dockerfile'],
        [candidate.matchDatasources, 'docker', 'matches every Docker dependency'],
        [candidate.matchPackageNames, baseImage, 'names the website base image'],
      ] as const;
      for (const [values, needle, how] of reaches) {
        expect(values ?? [], `${named} ${how}, so it groups the website bump`).not.toContain(
          needle,
        );
      }
    }
  });
});

/**
 * Two files carry the same supply-chain cooldown for two different update
 * paths: the org Renovate preset for what Renovate proposes, and `.npmrc` for
 * what a person typing `npm install` gets. Each of the checks below guards a
 * way the pair can come apart while both files still look deliberate.
 */
describe('Supply-chain cooldown', () => {
  const ORG_PRESET = 'local>Heey-Global/.github';
  const config = JSON.parse(readFileSync('renovate.json', 'utf8')) as RenovateConfig;
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    engines?: Record<string, string>;
    workspaces: string[];
  };
  // Comments and blank lines dropped; what remains is what npm actually applies.
  // Trailing comments go too — `min-release-age=3 # three days` is a natural
  // thing to write, and keeping it would turn a working floor into a `NaN` here
  // and a confusing failure about the value not being a number.
  const npmrcSettings = readFileSync('.npmrc', 'utf8')
    .split('\n')
    .map((line) => line.replace(/\s+[#;].*$/u, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith(';'))
    .map((line) => {
      const separator = line.indexOf('=');
      return separator === -1
        ? { key: line, value: '' }
        : { key: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() };
    });

  /**
   * Ask npm what it resolved for a key, with everything that could answer for
   * it taken away first.
   *
   * User and global config are pointed at paths that do not exist, and every
   * inherited `npm_config_*` is dropped: each of those layers outranks the
   * project file, so without this a contributor's own `~/.npmrc` — or a
   * `NPM_CONFIG_MIN_RELEASE_AGE` exported by a shell profile — would answer for
   * a repository whose setting had been deleted. The loglevel is then pinned
   * back, because anything quieter than `warn` suppresses the
   * `Unknown project config` line that is the only evidence npm understood the
   * key at all.
   */
  const neutralEnv = (): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^npm_config_/iu.test(name)),
    ),
    npm_config_userconfig: '/nonexistent/user/.npmrc',
    npm_config_globalconfig: '/nonexistent/global/npmrc',
    npm_config_loglevel: 'warn',
  });

  const askNpm = (
    key: string,
  ): { status: number | null; stdout: string; stderr: string; failure?: string } => {
    const npm = spawnSync('npm', ['config', 'get', key], {
      encoding: 'utf8',
      env: neutralEnv(),
    });
    return {
      status: npm.status,
      stdout: npm.stdout?.trim() ?? '',
      stderr: npm.stderr ?? '',
      // The spawn error first: stderr carries the warnings this deliberately
      // keeps enabled, so preferring it would report a warning as the reason npm
      // never ran.
      failure: npm.error?.message ?? npm.stderr,
    };
  };

  /** Whether a `[major, minor, patch]` is at or above another one. */
  const reaches = (version: number[], floor: number[]): boolean => {
    const differs = floor.findIndex((part, at) => (version[at] ?? 0) !== part);
    return differs === -1 || (version[differs] ?? 0) > (floor[differs] ?? 0);
  };

  it('holds the npm floor in .npmrc, and npm reads it as one', () => {
    const floor = npmrcSettings.find(({ key }) => key === 'min-release-age');
    expect(floor, '.npmrc no longer holds a release-age floor for manual installs').toBeDefined();
    // The exact number, not merely a positive one. It has to match the org
    // preset's `minimumReleaseAge: "3 days"`, which lives outside this
    // repository and cannot be read from here — so the only thing that can hold
    // the two together is that changing one side forces someone to come here and
    // change the number deliberately.
    expect(Number(floor?.value), 'the floor no longer matches the org preset 3-day window').toBe(3);
    // Asking npm rather than trusting the file. A misspelled or unsupported key
    // is not an error to npm: it warns `Unknown project config` and then
    // installs exactly as if the line were absent, so a floor that protects
    // nothing looks identical from the file alone. That warning is the only
    // signal, and it goes to stderr — `npm config get` still prints the value it
    // was handed, whether or not it means anything, so reading stdout alone
    // would have missed this.
    //
    // The unit is days, not the minutes the same idea is counted in elsewhere:
    // npm's definition hints `<days>` and derives `before` as
    // `Date.now() - 86400000 * age`.
    const npm = askNpm('min-release-age');
    expect(npm.status, `npm config get did not run: ${npm.failure}`).toBe(0);
    expect(npm.stdout, 'npm resolves a different floor than .npmrc states').toBe(floor?.value);
    expect(npm.stderr, 'npm does not recognise a key in .npmrc, so it is ignoring it').not.toMatch(
      /Unknown project config/u,
    );
  });

  it('makes the version requirement the floor depends on binding', () => {
    // `engines` is advisory by default. An npm below `engines.npm` ignores the
    // floor above, prints one EBADENGINE warning among the install output, and
    // resolves fresh releases exactly as if `.npmrc` were absent — a repository
    // that looks protected and is not, which is the failure mode this whole
    // block exists to prevent. `engine-strict` is what turns that warning into a
    // refusal, so it is load-bearing here rather than a matter of taste.
    const strict = npmrcSettings.find(({ key }) => key === 'engine-strict');
    expect(
      strict?.value,
      '.npmrc no longer makes engines.npm binding, so the floor is advisory',
    ).toBe('true');
    const npm = askNpm('engine-strict');
    expect(npm.status, `npm config get did not run: ${npm.failure}`).toBe(0);
    expect(npm.stdout, 'npm resolves engine-strict differently than .npmrc states').toBe('true');
  });

  it('carries no dependency whose own engines the strict setting would refuse', () => {
    // The price of `engine-strict`: it applies to dependencies' `engines` too,
    // so one transitive package that excludes the running Node stops being a
    // warning and becomes a refused `npm ci` — in CI, in the image builds, on
    // every machine. That arrives with a lockfile bump nobody associates with
    // this setting, so it is worth catching in the branch that proposes it.
    //
    // Ask npm rather than reading the ranges out of the lockfile. Exclusion is
    // written as often as `^18.0.0` or `20.x` as it is as `<24`, so a scan
    // looking for upper bounds passes the caret forms without a word and
    // reports a tree it never checked — the shape of green this suite exists to
    // avoid. `--dry-run` builds the same ideal tree as a real `npm ci`, and
    // runs the same engine check against it, without writing node_modules;
    // `--offline` keeps the answer about this lockfile rather than about the
    // network, and needs nothing from the cache to do it.
    const npm = spawnSync('npm', ['ci', '--dry-run', '--ignore-scripts', '--offline'], {
      encoding: 'utf8',
      env: neutralEnv(),
    });
    expect(
      /EBADENGINE.*(?:\n.*)?/u.exec(`${npm.stdout ?? ''}${npm.stderr ?? ''}`)?.[0] ?? '',
      'engine-strict makes this a refused install rather than a warning',
    ).toBe('');
    expect(npm.status, `npm ci --dry-run failed: ${npm.error?.message ?? npm.stderr ?? ''}`).toBe(
      0,
    );
  });

  it('declares an npm version that honours the floor, not merely some npm version', () => {
    // Below npm 11.15.0 the key is either unknown or does not survive being read
    // from an `.npmrc` (it was added in 11.10.0 and the npmrc path was fixed in
    // 11.15.0). Either way npm only warns, so on an older npm the floor is
    // inert and everything still installs — which is the whole failure mode this
    // suite exists for, one layer below the file. `engines` is what states the
    // requirement to anyone whose npm did not come from the pinned Node.
    //
    // Asserting the range and not just its presence: a `>=9` inherited from
    // whatever the repository last cared about is present, plausible, and admits
    // every npm the floor does nothing on. 11.15.0 is knowledge about npm rather
    // than about this repository, so it is written down here instead of derived
    // — nothing in the tree records it.
    const FLOOR_HONOURED_FROM = [11, 15, 0];
    const declared = manifest.engines?.npm;
    expect(declared, 'nothing declares the npm version the floor needs').toBeDefined();
    // Deliberately narrow: only `>=x.y.z` is recognised, so a range that cannot
    // be read as a lower bound fails here rather than being waved through by a
    // parse that guessed. Widen it when a real need for another form turns up.
    const lowerBound = /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(declared ?? '');
    expect(
      lowerBound,
      `engines.npm is "${declared}", which states no lower bound this can read`,
    ).not.toBeNull();
    const bound = (lowerBound?.slice(1, 4) ?? []).map(Number);
    expect(
      reaches(bound, FLOOR_HONOURED_FROM),
      `engines.npm is "${declared}", which admits npm below ${FLOOR_HONOURED_FROM.join('.')} — the floor is inert there and installs proceed as if .npmrc were absent`,
    ).toBe(true);
    // And the requirement has to be one the pinned Node can actually meet.
    // Nothing here pins npm itself: it arrives bundled with Node, and the
    // version it bundles is not stated anywhere in the tree. If a Node bump ever
    // shipped an npm below this bound, `engine-strict` would turn every install
    // in the repository into a hard refusal — so it fails here first, on the
    // machine doing the bump.
    const running = spawnSync('npm', ['--version'], { encoding: 'utf8', env: neutralEnv() });
    const reported = running.stdout?.trim() ?? '';
    // Parsed strictly: a prerelease (`12.0.0-pre.1`) or a failed spawn would
    // otherwise reach the comparison as NaN and fail as though npm were too old,
    // which is a different problem with a different fix.
    const parts = /^(\d+)\.(\d+)\.(\d+)/u.exec(reported);
    expect(
      parts,
      `could not read a version from \`npm --version\`: ${running.error?.message ?? reported}`,
    ).not.toBeNull();
    expect(
      reaches((parts?.slice(1, 4) ?? []).map(Number), FLOOR_HONOURED_FROM),
      `the npm in use is ${reported}, below the ${declared} this declares — engine-strict makes that a refusal rather than a warning`,
    ).toBe(true);
  });

  it('is the only .npmrc npm would read', () => {
    // npm reads the `.npmrc` of the project root nearest the directory it runs
    // in, so a file in a workspace would override this floor for anything
    // installed from there — and Renovate's empty `npmrc` would override it
    // there too, in the opposite direction. Checked on disk rather than through
    // git, because an `.npmrc` holding registry auth is exactly the kind that
    // would be gitignored, and that copy overrides the floor just as effectively
    // as a tracked one.
    // Both patterns glob today (`packages/*`, `apps/*`). A directly-named
    // workspace is still valid npm and would otherwise be expanded one level too
    // far — its children searched, itself skipped — so it is treated as its own
    // root rather than as a parent to walk.
    const roots = manifest.workspaces.flatMap((pattern) => {
      if (!pattern.endsWith('/*')) return [pattern];
      const parent = pattern.slice(0, -2);
      // A pattern naming a directory that is not there is a broken manifest, but
      // it is not this test's finding to report, and an ENOENT stack trace out
      // of a `.npmrc` check would send whoever reads it the wrong way.
      if (!existsSync(parent)) return [];
      return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`);
    });
    const found = ['.', ...roots].filter((root) => existsSync(`${root}/.npmrc`));
    expect(
      found,
      'a workspace .npmrc overrides the root floor for installs run from it — if this is your own file, registry credentials belong in ~/.npmrc, which npm reads as well and nothing here overrides',
    ).toEqual(['.']);
  });

  it('inherits the Renovate window instead of restating it', () => {
    // `minimumReleaseAge` and the 0-day vulnerability fast-track come from the
    // org preset. Setting either here would override the org policy for this
    // repository alone, which is the kind of drift the preset exists to stop —
    // and the number would then disagree with `.npmrc` the moment one moved.
    expect(config.extends ?? [], 'the org preset is where the window comes from').toContain(
      ORG_PRESET,
    );
    // Searched rather than enumerated. Renovate honours `minimumReleaseAge` in
    // more places than the two worth naming — inside `vulnerabilityAlerts`,
    // under `patch`/`minor`/`major`, per-manager, and nested in a `packageRules`
    // entry's own children. Listing the ones thought of leaves the rest silent,
    // and the most damaging of them is the `vulnerabilityAlerts` override, which
    // would cancel the fast-track the test below exists to keep.
    const locate = (node: unknown, path: string): string[] => {
      if (Array.isArray(node)) return node.flatMap((item, at) => locate(item, `${path}[${at}]`));
      if (node === null || typeof node !== 'object') return [];
      return Object.entries(node).flatMap(([key, value]) =>
        key === 'minimumReleaseAge' ? [`${path}.${key}`] : locate(value, `${path}.${key}`),
      );
    };
    expect(
      locate(config, 'renovate.json'),
      'a local window overrides the org policy and drifts from .npmrc',
    ).toEqual([]);
  });

  it("keeps the npm floor out of Renovate's own lockfile updates", () => {
    // Renovate reads this `.npmrc` while refreshing the lockfile, and it knows
    // this key specifically: finding `min-release-age` in a repository's file,
    // it skips passing its OWN `--before` and defers to the file. So the 3-day
    // floor would not merely apply alongside the org policy, it would replace
    // it — including replacing `vulnerabilityAlerts.minimumReleaseAge: 0 days`,
    // so same-day security bumps would wait three days. Nothing fails; the
    // fast-track just stops being fast.
    //
    // A DEFINED `npmrc` is what makes Renovate override the repository file
    // (`isString(config.npmrc) && !config.npmrcMerge`, so an empty string
    // qualifies), and an empty one overrides it with nothing. Not
    // `ignoreNpmrcFile: true`, which Renovate dropped in v25 and now only
    // honours through a deprecation shim that rewrites it to exactly this — and
    // which, being deprecated, earns a "Migrate config" PR rather than doing its
    // job quietly.
    expect(config.npmrc, 'the npm floor would override the vulnerability fast-track').toBe('');
    // The override only happens because `npmrcMerge` is false. Set to true, the
    // config value is PREPENDED to the repository file instead of replacing it,
    // so the floor comes back — with the config still reading as though the file
    // were being ignored.
    expect(
      config.npmrcMerge ?? false,
      'npmrcMerge prepends instead of overriding, so the floor applies to Renovate after all',
    ).toBe(false);
  });

  it('carries nothing in .npmrc that Renovate would need', () => {
    // The empty `npmrc` in renovate.json replaces the whole file, not the one
    // setting it was added for. A registry, a scope mapping or an auth line
    // added here later would be silently invisible to Renovate's npm runs, and
    // the symptom — lockfile updates resolving against the wrong registry —
    // points nowhere near this file. Deliberately exact rather than a deny-list
    // of the risky keys: a harmless-looking addition still has to be argued for
    // here, which is cheaper than deciding after the fact which keys Renovate
    // needed. Sorted, because the order of two independent settings in a file is
    // not something to fail a build over.
    expect(
      npmrcSettings.map(({ key }) => key).sort(),
      "a setting was added to .npmrc that Renovate's empty npmrc now hides from it",
    ).toEqual(['engine-strict', 'min-release-age']);
  });
});
