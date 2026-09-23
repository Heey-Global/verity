import { readFile } from 'node:fs/promises';
import semver from 'semver';
import { describe, expect, it } from 'vitest';

import { CLAUDE_MODELS } from '../packages/server/src/server.js';

/**
 * The first `@anthropic-ai/claude-code` release whose own model catalog describes each
 * curated Claude id. A model missing from that catalog is NOT rejected by the CLI: it
 * logs `unrecognized_model` and then assumes a 200K context window, so a session on a
 * 1M-token model auto-compacts at a fifth of its real window and every turn still
 * succeeds. Nothing downstream can see the difference, which is why this floor is
 * recorded here rather than left to the release that happens to be pinned.
 *
 * Only models whose floor is ABOVE the version a fresh pin would already satisfy need an
 * entry; an id absent from this map is assumed to predate every supported pin.
 */
const CLAUDE_MODEL_CLI_FLOOR: Readonly<Record<string, string>> = {
  'claude-opus-5-5': '2.1.280',
};

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

  it('pins a Claude CLI whose model catalog describes every curated Claude model', async () => {
    const [dockerfile, feature] = await Promise.all([
      readFile('deploy/Dockerfile', 'utf8'),
      readFile('features/verity-sandbox-toolkit/install.sh', 'utf8'),
    ]);
    const name = '@anthropic-ai/claude-code';
    const pins = [
      ['deploy/Dockerfile', dockerfilePins(dockerfile).get(name)],
      ['features/verity-sandbox-toolkit/install.sh', featurePins(feature).get(name)],
    ] as const;
    // The floors are only meaningful against a pin that was actually extracted. Without
    // this the whole test passes for free once either extraction stops matching.
    for (const [file, pin] of pins) expect(pin, `no ${name} pin found in ${file}`).toBeDefined();
    // Read the requirement off the curated list rather than restating it: a model added
    // to CLAUDE_MODELS with a floor above the pin fails here, on release day, instead of
    // shipping as a silently 200K-capped default.
    for (const model of CLAUDE_MODELS) {
      const floor = CLAUDE_MODEL_CLI_FLOOR[model];
      if (floor === undefined) continue;
      for (const [file, pin] of pins) {
        expect(
          semver.gte(pin!, floor),
          `${file} pins ${name}@${pin!}, which predates ${model} (needs >= ${floor})`,
        ).toBe(true);
      }
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
