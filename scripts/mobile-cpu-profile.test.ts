import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-expect-error -- executable helper
import { stampProfileMap, extractProfile, toSpeedscope } from './mobile-cpu-profile.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const commit = 'a'.repeat(40);
function config(
  variant = 'staging',
  enabled = '1',
  sha = commit,
): {
  updates: { enabled?: boolean };
  runtimeVersion: string;
  plugins: unknown[];
  ios: { infoPlist: { VerityCPUProfiling?: boolean; VerityProfileCommit?: string } };
} {
  const result: unknown = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import config from ${JSON.stringify(pathToFileURL(resolve('apps/mobile/app.config.ts')).href)}; process.stdout.write(JSON.stringify(config));`,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          VERITY_APP_VARIANT: variant,
          EXPO_UPDATE_CHANNEL: variant,
          VERITY_CPU_PROFILING: enabled,
          VERITY_PROFILE_COMMIT: sha,
        },
      },
    ),
  );
  return result as {
    updates: { enabled?: boolean };
    runtimeVersion: string;
    plugins: unknown[];
    ios: { infoPlist: { VerityCPUProfiling?: boolean; VerityProfileCommit?: string } };
  };
}
const profile = {
  stackFrames: {
    '1': { name: '[root]' },
    '2': { name: 'minified', category: 'JavaScript', parent: 1, funcVirtAddr: '0', offset: '0' },
  },
  samples: [
    { pid: 1, tid: 9, ts: '10000', sf: 2 },
    { pid: 1, tid: 9, ts: '20000', sf: 2 },
    { pid: 1, tid: 9, ts: '35000', sf: 1 },
  ],
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'verity-profile-'));
  roots.push(root);
  const map = join(root, 'main.jsbundle.map');
  writeFileSync(
    map,
    JSON.stringify({
      version: 3,
      sources: ['src/slow.ts'],
      names: ['slowFunction'],
      mappings: 'AAAAA',
    }),
  );
  stampProfileMap(map, commit);
  const capture = join(root, 'capture.json');
  writeFileSync(
    capture,
    JSON.stringify({
      schema: 1,
      identity: {
        commit,
        mapSha256: JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).mapSha256,
      },
      recording: { startedAt: 1 },
      hermesProfile: profile,
    }),
  );
  return { root, map, capture, output: join(root, 'converted') };
}
describe('optimized CPU capture', () => {
  it('isolates profiling from OTA and normal builds and requires an exact identity', () => {
    const diagnostic = config();
    expect(diagnostic.updates.enabled).toBe(false);
    expect(diagnostic.runtimeVersion).toBe(`staging-profile-${commit}`);
    expect(diagnostic.ios.infoPlist.VerityProfileCommit).toBe(commit);
    expect(diagnostic.plugins).toContain('./plugins/withCPUProfiling');
    for (const variant of ['production', 'staging']) {
      const normal = config(variant, '0');
      expect(normal.plugins).not.toContain('./plugins/withCPUProfiling');
      expect(normal.ios.infoPlist.VerityCPUProfiling).toBe(false);
      expect(normal.updates.enabled).not.toBe(false);
    }
    expect(() => config('production')).toThrow();
    expect(() => config('staging', '1', 'dev')).toThrow();
  });
  it('uses the optimized staging profile while retaining release pod exclusion', () => {
    const { build } = JSON.parse(readFileSync('apps/mobile/eas.json', 'utf8'));
    expect(build.profiling.extends).toBe('staging');
    expect(build.profiling.ios.buildConfiguration).toBe('Release');
    expect(build.profiling.developmentClient).not.toBe(true);
    expect(build.profiling.env.VERITY_CPU_PROFILING).toBe('1');
  });
  it('compiles the sampler namespace expressions with both namespaces from the pinned Hermes API', () => {
    const source = readFileSync('apps/mobile/plugins/cpu-profiler/VerityCPUProfiler.mm', 'utf8');
    const calls = source.match(/auto \*api = .+;/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    // hermes.h declares both namespaces. Compile the actual expressions, not a
    // copied expression that would keep passing when the native source regresses.
    const declarations = `namespace hermes {}
namespace facebook {
namespace jsi { template<class T> T *castInterface(void *); }
namespace hermes { class IHermesRootAPI; void *makeHermesRootAPI(); }
}
`;
    const imports = (source.match(/^using namespace .+;/gm) ?? []).join('\n');
    execFileSync('c++', ['-std=c++20', '-fsyntax-only', '-x', 'c++', '-'], {
      input:
        declarations +
        imports +
        '\nvoid check() {\n' +
        calls.map((call) => `{ ${call} }`).join('\n') +
        '\n}',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });
  it('loads the bundle-phase helper when Expo is omitted from contract CI', () => {
    execFileSync(
      process.execPath,
      [
        '-e',
        `
      const Module = require('node:module');
      const original = Module._load;
      Module._load = function(name, ...args) {
        if (name === '@expo/config-plugins') throw new Error('Expo omitted in contract CI');
        return original.call(this, name, ...args);
      };
      const plugin = require(${JSON.stringify(resolve('apps/mobile/plugins/withCPUProfiling.js'))});
      if (typeof plugin.profileBundleScript !== 'function') throw new Error('Missing phase helper');
      plugin.profileBundleScript('exit 0\\n', ${JSON.stringify(commit)});
    `,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
  });
  it('runs the generated map phase and refreshes its identity on repeated prebuilds', () => {
    const plugin = createRequire(import.meta.url)(
      resolve('apps/mobile/plugins/withCPUProfiling.js'),
    ) as { profileBundleScript: (script: string, commit: string) => string };
    const f = fixture();
    const projectDir = join(f.root, 'apps/mobile/ios');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(f.root, 'App.app'));
    symlinkSync(resolve('scripts'), join(f.root, 'scripts'));
    const original = `printf '%s' '{"version":3,"sources":[],"names":[],"mappings":""}' > "$SOURCEMAP_FILE"\n`;
    const first = plugin.profileBundleScript(original, 'b'.repeat(40));
    const next = plugin.profileBundleScript(first, commit);
    expect(next).not.toContain('b'.repeat(40));
    expect(plugin.profileBundleScript(next, commit)).toBe(next);
    execFileSync('bash', ['-c', next], {
      env: {
        ...process.env,
        PROJECT_DIR: projectDir,
        TARGET_BUILD_DIR: f.root,
        UNLOCALIZED_RESOURCES_FOLDER_PATH: 'App.app',
        NODE_BINARY: process.execPath,
      },
    });
    const nativeIdentity = JSON.parse(
      readFileSync(join(f.root, 'App.app/verity-profile-map.json'), 'utf8'),
    );
    expect(nativeIdentity.commit).toBe(commit);
    expect(
      readFileSync(join(f.root, 'apps/mobile/profiling-artifacts/manifest.json'), 'utf8'),
    ).toBe(JSON.stringify(nativeIdentity, null, 2));
    // A failed bundle must not leave a usable identity from an earlier build.
    const failed = plugin.profileBundleScript('exit 9\n', commit);
    expect(() =>
      execFileSync('bash', ['-c', failed], { env: { ...process.env, PROJECT_DIR: projectDir } }),
    ).toThrow();
    expect(existsSync(join(f.root, 'apps/mobile/profiling-artifacts/manifest.json'))).toBe(false);
  });
  it('symbolicates a populated Hermes profile into a sampled Speedscope artifact', () => {
    const f = fixture();
    expect(extractProfile(f.capture, f.root, f.output)).toBe(3);
    const converted = JSON.parse(readFileSync(join(f.output, 'profile.speedscope.json'), 'utf8'));
    expect(converted.shared.frames[1].name).toContain('slowFunction(src/slow.ts:1:0)');
    expect(converted.profiles[0]).toMatchObject({
      samples: [[0, 1], [0, 1], [0]],
      weights: [10000, 15000, 0],
      startValue: 10000,
      endValue: 35000,
      unit: 'microseconds',
    });
    expect(
      JSON.parse(readFileSync(join(f.output, 'diagnostics.json'), 'utf8')).hermesProfile,
    ).toBeUndefined();
  });
  it.each(['commit', 'digest', 'different-build'])(
    'rejects a mismatched map %s before creating output',
    (kind) => {
      const f = fixture();
      if (kind === 'commit') stampProfileMap(f.map, 'b'.repeat(40));
      else {
        writeFileSync(f.map, readFileSync(f.map, 'utf8') + ' ');
        if (kind === 'different-build') stampProfileMap(f.map, commit);
      }
      expect(() => extractProfile(f.capture, f.root, f.output)).toThrow('do not match');
      expect(existsSync(f.output)).toBe(false);
    },
  );
  it('rejects empty, dangling and cyclic stacks rather than emitting a convincing empty profile', () => {
    expect(() => toSpeedscope({ samples: [], stackFrames: {} })).toThrow('No usable');
    expect(() => toSpeedscope({ ...profile, stackFrames: {} })).toThrow('Broken');
    expect(() => toSpeedscope({ ...profile, stackFrames: { '2': { parent: 2 } } })).toThrow(
      'cyclic',
    );
  });
});
