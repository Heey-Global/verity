import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface RenovateConfig {
  extends?: string[];
  semanticCommits?: string;
  ignorePaths?: string[];
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
