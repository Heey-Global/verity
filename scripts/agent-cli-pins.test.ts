import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * Two images install the agent CLIs: the devcontainer Feature builds project
 * Sandboxes, and `deploy/Dockerfile` builds the Server image, which also runs the
 * control-plane Runner. The same turn can land in either, so a version that differs
 * between them is not a cosmetic drift — it is a session that behaves one way in a
 * project and another way in the control plane, with nothing in the product naming
 * the difference.
 *
 * Renovate bumps each pin where it finds it, and it finds them independently: a
 * release that updates one file and not the other is the ordinary outcome of a
 * declined or conflicted pull request, not an exotic failure.
 */
const dockerfilePins = (source: string): Map<string, string> =>
  new Map(
    [
      ...source.matchAll(
        /# renovate: datasource=npm depName=(\S+)\nRUN npm install -g (\S+)@([^\s@]+)\n/gu,
      ),
    ]
      // The annotation names the package Renovate updates; the command names the
      // package npm installs. A pin whose two halves disagree is invisible to
      // Renovate, so read it as a pair and let the comparison below miss it rather
      // than silently trusting the annotation.
      .filter((pin) => pin[1] === pin[2])
      .map((pin) => [pin[1]!, pin[3]!]),
  );

const featurePins = (source: string): Map<string, string> =>
  new Map(
    [
      ...source.matchAll(/# renovate: datasource=npm depName=(\S+)\n\w+="\$\{\w+:-([^}]+)\}"\n/gu),
    ].map((pin) => [pin[1]!, pin[2]!]),
  );

describe('agent CLI version pins', () => {
  it('installs the same agent CLI versions in the Server image and in the Feature', async () => {
    const [dockerfile, feature] = await Promise.all([
      readFile('deploy/Dockerfile', 'utf8'),
      readFile('features/verity-sandbox-toolkit/install.sh', 'utf8'),
    ]);
    const image = dockerfilePins(dockerfile);
    const sandbox = featurePins(feature);
    const shared = [...image.keys()].filter((name) => sandbox.has(name));
    // Anchored on the CLIs an ACP turn actually spawns. Without this the test
    // passes for free the moment either extraction stops matching — a reformatted
    // `RUN`, a renamed shell variable — which is exactly when the pins start to
    // drift unobserved.
    expect(shared).toEqual(
      expect.arrayContaining(['@anthropic-ai/claude-code', '@openai/codex', 'opencode-ai']),
    );
    for (const name of shared) {
      expect(image.get(name), `${name} is pinned to different versions`).toBe(sandbox.get(name));
    }
  });

  it('builds the opencode-acp wrapper from one script in both images', async () => {
    const [dockerfile, feature, wrapper] = await Promise.all([
      readFile('deploy/Dockerfile', 'utf8'),
      readFile('features/verity-sandbox-toolkit/install.sh', 'utf8'),
      readFile('features/verity-sandbox-toolkit/bin/verity-opencode-acp-install.sh', 'utf8'),
    ]);
    // The wrapper decides which binary every OpenCode turn starts, and it is written
    // from a path resolved at build time. A second copy of that resolution would not
    // fail loudly — it would quietly bake a different target into one of the two
    // images.
    const script = 'verity-opencode-acp-install.sh';
    expect(dockerfile).toContain(script);
    expect(feature).toContain(script);
    expect(wrapper).toContain('/usr/local/bin/opencode-acp');
    for (const [name, source] of [
      ['deploy/Dockerfile', dockerfile],
      ['features/verity-sandbox-toolkit/install.sh', feature],
    ] as const) {
      expect(source, `${name} builds the wrapper itself instead of calling the script`).not.toMatch(
        /printf '#!\/bin\/sh\\nexec %s acp/u,
      );
    }
  });
});
