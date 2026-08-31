import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { on, once } from 'node:events';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ignore from 'ignore';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// @ts-expect-error -- plain .mjs helper, no types
import { RELEASE_IMAGES, SERVER_IMAGE } from './audit-release-images.mjs';

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  steps: WorkflowStep[];
};

describe('Verity website publication smoke', () => {
  // Two publishes reach this image: `sha-<commit>` on every main commit
  // (verity-website.yml) and `v<version>` on the website release train
  // (release.yml). They smoke the same build with the same script, so what
  // "healthy" means for this image cannot come to mean two things.
  const smoke = readFileSync('deploy/bin/verity-website-smoke', 'utf8');
  const publishes = ['.github/workflows/verity-website.yml', '.github/workflows/release.yml'];
  const workflow = (file: string) =>
    parse(readFileSync(file, 'utf8')) as {
      on?: Record<string, { paths?: string[] } | null>;
      concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
      env?: Record<string, string>;
      jobs: Record<
        string,
        {
          if?: string;
          needs?: string | string[];
          env?: Record<string, string>;
          steps?: WorkflowStep[];
        }
      >;
    };

  it('checks readiness inside the container and prints actionable diagnostics', () => {
    expect(smoke).toContain('readiness_deadline=$((SECONDS + 90))');
    expect(smoke).toContain('while (( SECONDS < readiness_deadline ))');
    expect(smoke).toContain('did not become ready within 90 seconds');
    expect(smoke).toContain('--network none');
    expect(smoke).toContain('docker exec "$TEST_CONTAINER" wget -T 2 -t 1');
    expect(smoke.match(/wget -T 2 -t 1/g)).toHaveLength(4);
    expect(smoke).not.toContain('-p 127.0.0.1:');
    expect(smoke).not.toContain('docker port');
    expect(smoke).toContain('Last health response:');
    expect(smoke).toContain('docker inspect --format');
    expect(smoke).toContain('docker logs "$TEST_CONTAINER"');
    expect(smoke).toContain('response_headers="$(');
    expect(smoke).toContain('<<<"$response_headers"');
    expect(smoke).not.toMatch(/wget[^\n]*\n(?:[^\n]*\n)*?\s*\|\s*grep/);
  });

  it('is a runnable script, not just a file the workflows name', () => {
    // Both callers invoke it by path, so the exec bit is load-bearing, and both
    // reach it on a runner rather than here — a lost bit or a syntax error would
    // surface for the first time as a failed publish. `bash -n` parses without
    // running, which is the whole of what can be checked without a daemon.
    const mode = execFileSync('git', ['ls-files', '-s', 'deploy/bin/verity-website-smoke'], {
      encoding: 'utf8',
    });
    expect(mode.startsWith('100755'), 'the smoke is committed without its exec bit').toBe(true);
    expect(smoke.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(() =>
      execFileSync('bash', ['-n', 'deploy/bin/verity-website-smoke'], { stdio: 'pipe' }),
    ).not.toThrow();
  });

  it('fails loudly rather than vacuously', () => {
    // The two ways this smoke could pass while proving nothing. An empty digest
    // makes the reference `name@`, and a page with no assets makes the asset
    // loop iterate zero times — both silent, both indistinguishable from health.
    expect(smoke).toContain('the digest or tag is empty');
    expect(smoke).toContain('the asset check proved nothing');
    // Armed before the container exists, or a `docker run` that creates without
    // starting leaks one past `set -e`; and a signal exits rather than resuming
    // into requests against the container the handler just removed.
    expect(smoke.indexOf('trap cleanup EXIT')).toBeLessThan(smoke.indexOf('docker run -d'));
    expect(smoke).toContain("trap 'cleanup; exit 130' INT");
    expect(smoke).toContain("trap 'cleanup; exit 143' TERM");
  });

  it('is what both publishes run, and neither re-implements it', () => {
    for (const file of publishes) {
      expect(readFileSync(file, 'utf8'), `${file} does not run the shared smoke`).toContain(
        'deploy/bin/verity-website-smoke',
      );
    }

    // A second copy inline is exactly how the two drifted apart before. Read
    // per job rather than per file: release.yml publishes several images, and a
    // readiness loop in one of the others is not this smoke drifting — it would
    // fail this check for a reason the check cannot name.
    const website = workflow('.github/workflows/verity-website.yml');
    const jobs = [
      ...Object.entries(website.jobs),
      [
        'publish-website',
        workflow('.github/workflows/release.yml').jobs['publish-website'],
      ] as const,
    ];
    for (const [name, job] of jobs) {
      const script = (job?.steps ?? []).map((step) => step.run ?? '').join('\n');
      expect(script, `${name} also smokes the image inline`).not.toContain('readiness_deadline');
    }

    // Running it is not the same as being triggered by it. While the smoke was
    // inline, editing it re-ran the workflow by construction; as a script it has
    // to be named in the filters too, or the first run of a broken smoke is the
    // release publish it was supposed to gate.
    for (const trigger of ['pull_request', 'push']) {
      expect(
        website.on?.[trigger]?.paths,
        `verity-website.yml runs the smoke but ${trigger} ignores changes to it`,
      ).toContain('deploy/bin/verity-website-smoke');
    }
  });

  it('builds and smokes the website image on pull requests', () => {
    const website = workflow('.github/workflows/verity-website.yml');
    const job = website.jobs['pr-image-smoke'];
    expect(job?.if).toBe("github.event_name == 'pull_request'");
    expect(job?.needs).toBe('static-checks');
    const build = job?.steps?.find((step) => step.uses?.startsWith('docker/build-push-action@'));
    expect(build?.with?.file).toBe('docs/website/Dockerfile');
    expect(build?.with?.load).toBe(true);
    expect(job?.steps?.some((step) => step.run?.includes('deploy/bin/verity-website-smoke'))).toBe(
      true,
    );
  });

  it('ships the public installer in the website image', () => {
    const dockerfile = readFileSync('docs/website/Dockerfile', 'utf8');
    expect(dockerfile).toContain(
      'COPY --chown=101:101 docs/website/site/install.sh /usr/share/nginx/html/install.sh',
    );
    const nginx = readFileSync('docs/website/nginx.conf', 'utf8');
    expect(nginx).toMatch(/location = \/install\.sh \{[\s\S]*?try_files \$uri =404;/u);
    expect(nginx).toContain('Content-Security-Policy');
    expect(nginx).toContain("script-src 'self' https://stats.heey.global");
  });

  it('tags the release build off the website train, not the backend one', () => {
    const job = workflow('.github/workflows/release.yml').jobs['publish-website'];
    expect(job?.if).toBe("needs.release-please.outputs.website-release-created == 'true'");
    expect(job?.env?.VERSION).toBe('${{ needs.release-please.outputs.website-version }}');
    expect(job?.env?.IMAGE_NAME).toBe('heey-global/verity/verity-website');
    // The version and the source have to come from the same release. Checking
    // out the default ref would tag `v1.2.0` on whatever main had reached by
    // then — an image that does not match the commit its own tag names, and
    // nothing downstream could tell.
    const checkout = job?.steps?.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('${{ needs.release-please.outputs.website-sha }}');
  });

  it('builds the same image the per-commit publish does', () => {
    // Extracting the smoke stopped the two publishes disagreeing about what
    // healthy means; it did nothing about them disagreeing on what they build.
    // A release that quietly builds a different Dockerfile, or pushes under a
    // different name, is the same class of drift and would show up as a version
    // tag on an image nobody smoked under that name.
    const build = (file: string, job: string) =>
      workflow(file).jobs[job]?.steps?.find((step) =>
        step.uses?.startsWith('docker/build-push-action@'),
      )?.with ?? {};
    const perCommit = build('.github/workflows/verity-website.yml', 'publish');
    const release = build('.github/workflows/release.yml', 'publish-website');
    for (const key of ['context', 'file', 'platforms', 'provenance', 'sbom', 'outputs']) {
      expect(release[key], `the two website builds disagree about \`${key}\``).toBe(perCommit[key]);
    }
    // `labels` is deliberately not compared: the release build labels the image
    // with the version it is about to tag, and the per-commit build has no
    // version to label with.
    const imageName = (file: string, job: string) => {
      const parsed = workflow(file);
      return parsed.jobs[job]?.env?.IMAGE_NAME ?? parsed.env?.IMAGE_NAME;
    };
    expect(imageName('.github/workflows/release.yml', 'publish-website')).toBe(
      imageName('.github/workflows/verity-website.yml', 'publish'),
    );
  });

  it('is a train of its own, tagged the way the cluster pins it', () => {
    // The publish job reads `website-*` outputs and tags `v${VERSION}`; both are
    // downstream of four properties in one file, none of which fails loudly.
    // Drop the root exclusion and a website change ships on the backend train,
    // moving a version the cluster does not track; drop the component from the
    // tag and release-please claims plain `vX.Y.Z`, which is the backend's.
    const config = JSON.parse(readFileSync('release-please-config.json', 'utf8')) as {
      packages: Record<
        string,
        {
          'package-name'?: string;
          'initial-version'?: string;
          'include-component-in-tag'?: boolean;
          'tag-separator'?: string;
          'exclude-paths'?: string[];
        }
      >;
    };
    const [path, website] =
      Object.entries(config.packages).find(([, pkg]) => pkg['package-name'] === 'website') ?? [];
    expect(path, 'the website has no package in the release config').toBeDefined();
    expect(config.packages['.']?.['exclude-paths'] ?? []).toContain(path);
    expect(website?.['include-component-in-tag']).toBe(true);
    expect(website?.['tag-separator']).toBe('-');
    // The first release has no manifest entry to read a version from, so this
    // is the only thing that decides what `website-v…` the cluster can first
    // pin — and it stops mattering the moment that release lands. The manifest
    // itself is not read here: it is release-managed, and a suite that reads
    // one is a check the release-only CI skip would silently drop.
    expect(website?.['initial-version']).toBe('1.0.0');
  });

  it('cannot tag a version it did not build, or report a tag that is not there', () => {
    const release = workflow('.github/workflows/release.yml');
    const steps = release.jobs['publish-website']?.steps ?? [];
    const script = steps.map((step) => step.run ?? '').join('\n');
    // Both outputs are read off the same release, so they agree by
    // construction — which is exactly why a disagreement means the two came
    // from different releases and the image would not be what its tag says.
    //
    // The package directory is read from the release config rather than
    // written here: its version file is release-managed, and a suite that
    // names one is a check the release-only CI skip would silently drop.
    const releaseConfig = JSON.parse(readFileSync('release-please-config.json', 'utf8')) as {
      packages: Record<string, { 'package-name'?: string }>;
    };
    const websitePath = Object.entries(releaseConfig.packages).find(
      ([, pkg]) => pkg['package-name'] === 'website',
    )?.[0];
    expect(websitePath, 'the website has no package in the release config').toBeDefined();
    expect(script, 'the guard does not read the checked-out website').toContain(
      `${websitePath as string}/`,
    );
    expect(script).toContain('but the release is $VERSION');
    // This image is deliberately outside audit-release-images.mjs, so the
    // promote step is the last and only place that can notice a tag the
    // registry did not actually keep — and the only place that can refuse to
    // move one the cluster is already running.
    expect(script).toContain('imagetools inspect');
    expect(script).toContain('does not resolve after promotion');
    expect(script).toContain('already published');
    // Re-creating the version tag is safe only because releases on a ref are
    // serialized. Cancelling one mid-promote is the case that argument does
    // not cover, and it is set two hundred lines from where it is relied on.
    expect(release.concurrency?.['cancel-in-progress']).toBe(false);
  });
});

describe('server test CI', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: {
      test: {
        strategy?: unknown;
        steps: WorkflowStep[];
      };
    };
  };
  const job = workflow.jobs.test;
  const test = job.steps.find((step) => step.run?.includes('vitest run --shard='));

  it('bounds aggregate Vitest workers on the hosted runner', () => {
    // One job starts four fresh processes serially: process exit resets RSS,
    // without four matrix jobs repeating the whole setup prologue.
    expect(job.strategy).toBeUndefined();
    expect(test?.run).toContain('for shard in 1 2 3 4');
    expect(test?.run).toContain('--shard="$shard/4"');
    expect(test?.run).toContain('--maxWorkers=1');
    expect(test?.run).toContain('--exclude packages/server/src/embedded.test.ts');

    const embedded = job.steps.find((step) =>
      step.run?.includes('vitest run packages/server/src/embedded.test.ts'),
    );
    expect(embedded?.if).toBeUndefined();
    expect(embedded?.run).toContain('--maxWorkers=1');
  });

  it('gives every Vitest-running step the shared PostgreSQL', () => {
    // The harness falls back to pglite when the URL is absent (see
    // packages/store/src/testing.ts), so a step that loses this env var does not
    // fail — it silently goes back to a WASM Postgres per file, which is exactly
    // the memory profile that has been killing workers. Assert it instead.
    const postgres = job.steps.find((step) => step.uses === './.github/actions/postgres');
    expect(postgres?.id).toBe('postgres');
    expect(postgres?.with?.['container-name']).not.toContain('matrix.shard');
    for (const step of job.steps.filter((s) => s.run?.includes('vitest run'))) {
      expect(step.env?.VERITY_TEST_SHARED_POSTGRES_URL).toBe('${{ steps.postgres.outputs.url }}');
    }
    // Containers outlive a cancelled job unless something removes them.
    const cleanup = job.steps.find((step) => step.run?.includes('docker rm -f'));
    expect(cleanup?.if).toBe('always()');

    const action = readFileSync('.github/actions/postgres/action.yml', 'utf8');
    expect(action).toContain('-p 127.0.0.1::5432');
    expect(action).toContain('@127.0.0.1:$port/verity');
    expect(action).not.toContain('/proc/net/route');
    expect(action).not.toContain('verity-test-postgres-run');
  });
});

describe('mobile native patch CI', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: { 'mobile-app': { steps: WorkflowStep[] } };
  };
  const steps = workflow.jobs['mobile-app'].steps;

  // scripts/patch-mobile-native-deps.mjs rewrites an installed native dependency
  // before the GitHub-hosted Xcode build, against byte-exact anchors. This job holds the only full
  // mobile install in CI, so it is the only place the anchors are checked against
  // the real tree before a release build finds out — which makes both the step and
  // its position load-bearing rather than incidental.
  it('checks the backported native patches against a real install', () => {
    const install = steps.findIndex((step) => step.run?.startsWith('npm ci'));
    const patch = steps.findIndex((step) =>
      step.run?.includes('npm run -w @verity/mobile-app patch:native'),
    );
    // Before the build, not merely after the install: the release workflow uses
    // the same order before generating the native project.
    const build = steps.findIndex((step) => step.run?.includes('npm run -w @verity/mobile build'));
    expect(install, 'the patch needs an installed dependency to check').toBeGreaterThanOrEqual(0);
    expect(patch, 'nothing else in CI runs the native patches').toBeGreaterThan(install);
    expect(build, 'this job builds the mobile data layer').toBeGreaterThan(patch);
  });
});

describe('native iOS compile gate', () => {
  it('dispatches the pinned organization Gitleaks policy for generated release PRs', () => {
    const workflow = parse(readFileSync('.github/workflows/gitleaks-dispatch.yml', 'utf8')) as {
      on?: { workflow_dispatch?: unknown };
      permissions?: { contents?: string };
      jobs: Record<string, { uses?: string }>;
    };
    expect(workflow.on?.workflow_dispatch).toBeDefined();
    expect(workflow.permissions?.contents).toBe('read');
    expect(workflow.jobs.gitleaks?.uses).toMatch(
      /^Heey-Global\/\.github\/\.github\/workflows\/gitleaks\.yml@[0-9a-f]{40}$/,
    );
  });

  it('compiles a non-publishing simulator build on a GitHub macOS runner', () => {
    const github = parse(readFileSync('.github/workflows/mobile-native-verify.yml', 'utf8')) as {
      on?: { pull_request?: unknown };
      jobs: Record<string, { 'runs-on': string; steps: WorkflowStep[] }>;
    };
    const job = github.jobs['verify-ios'];
    expect(job?.['runs-on']).toBe('macos-26');
    expect(github.on?.pull_request).toBeDefined();
    const commands = job?.steps.map((step) => step.run ?? '').join('\n') ?? '';
    expect(commands).toContain('expo prebuild --platform ios');
    expect(commands).toContain('pod install');
    expect(commands).toContain('xcodebuild');
    expect(commands).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(commands).not.toContain('eas-cli');
    expect(commands).not.toMatch(/testflight|submit/iu);
  });

  it('builds and uploads TestFlight releases on GitHub instead of EAS Build', () => {
    const release = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      jobs: Record<string, { 'runs-on': string; steps: WorkflowStep[] }>;
    };
    const job = release.jobs['publish-mobile-native'];
    expect(job?.['runs-on']).toBe('macos-26');
    const commands = job?.steps.map((step) => step.run ?? '').join('\n') ?? '';
    expect(commands).toContain('expo prebuild --platform ios');
    expect(commands).toContain('xcodebuild');
    expect(commands).toContain('archive');
    expect(commands).toContain('altool --upload-app');
    expect(commands).not.toContain('eas-cli');
    expect(commands.indexOf('patch:native')).toBeLessThan(commands.indexOf('expo prebuild'));
    expect(commands).toContain('scheme=Verity');
    expect(commands).toContain('https://api.appstoreconnect.apple.com/v1/builds');
    expect(commands).toContain('CURRENT_PROJECT_VERSION="$next_build"');
    expect(commands).toContain('filter[version]=$next_build');
    expect(commands).toContain('processingState');
    expect(commands).toContain('--retry 3 --retry-all-errors --max-time 30');
    expect(commands).toContain('App Store Connect check failed transiently');
    expect(commands.indexOf('altool --upload-app')).toBeLessThan(
      commands.indexOf('filter[version]=$next_build'),
    );
    const releaseSource = readFileSync('.github/workflows/release.yml', 'utf8');
    expect(releaseSource).toContain(
      '^apps/mobile/(CHANGELOG\\.md|app\\.config\\.ts|version\\.txt)$',
    );
    expect(releaseSource).toContain('gh workflow run mobile-native-verify.yml');
    expect(releaseSource).toContain('gh workflow run gitleaks-dispatch.yml');

    const appConfig = readFileSync('apps/mobile/app.config.ts', 'utf8');
    expect(appConfig).toContain("'expo-channel-name': expoUpdateChannel");
    const prebuild = job?.steps.find((step) => step.name === 'Generate the iOS project');
    expect(prebuild?.env?.EXPO_UPDATE_CHANNEL).toBe('testflight');
  });
});

describe('mobile OTA promotion', () => {
  it('stages an immutable candidate and opens a promotion PR', () => {
    const source = readFileSync('.github/workflows/mobile-ota.yml', 'utf8');
    expect(source).toContain('--branch "${{ steps.version.outputs.branch }}"');
    expect(source).toContain('channel:edit staging');
    expect(source).toContain('automation/promote-${OTA_TAG}');
    expect(source).toContain('--state open');
    expect(source).toContain('gh workflow run ci.yml --ref "$promotion_branch"');
    expect(source).toContain('git push origin "refs/tags/${OTA_TAG}"');
    expect(source).not.toContain('--channel testflight');
    expect(source).not.toContain('gh release create');
  });

  it('moves TestFlight to the approved EAS branch without rebuilding', () => {
    const source = readFileSync('.github/workflows/mobile-ota-promote.yml', 'utf8');
    expect(source).toContain("github.ref == 'refs/heads/main'");
    expect(source).toContain('paths: [apps/mobile/ota-promotion.json]');
    expect(source).toContain('channel:edit testflight');
    expect(source).toContain('--branch "${{ steps.candidate.outputs.branch }}"');
    expect(source).toContain('git merge-base --is-ancestor');
    expect(source).toContain('for _ in {1..12}');
    expect(source).toContain('git fetch --quiet --tags origin');
    expect(source).toContain('Reserved tag does not point at the approved candidate');
    expect(source).toContain('refusing to move TestFlight backwards');
    expect(source).toContain('gh release create');
    expect(source).toContain('gh release edit');
    expect(source).not.toContain('eas-cli@21.0.1 update');
  });

  it('does not compile the native app for an OTA promotion manifest', () => {
    const source = readFileSync('.github/workflows/mobile-native-verify.yml', 'utf8');
    expect(source).toContain("'!apps/mobile/ota-promotion.json'");
  });
});

describe('specialized smoke workflow overhead', () => {
  it('builds only the Server dependency closure for host-side harnesses', () => {
    for (const file of ['project-relay.yml', 'secret-job-worker.yml']) {
      const workflow = parse(readFileSync(join('.github/workflows', file), 'utf8')) as {
        jobs: Record<string, WorkflowJob>;
      };
      const commands = Object.values(workflow.jobs).flatMap((job) =>
        job.steps.map((step) => step.run ?? ''),
      );
      expect(commands.some((run) => run.includes('npm ci --workspace @verity/server'))).toBe(true);
      expect(commands.some((run) => run.includes('npm run build --workspace @verity/server'))).toBe(
        true,
      );
      expect(commands.some((run) => /^\s*npm ci --ignore-scripts\s*$/mu.test(run))).toBe(false);
      expect(commands.some((run) => /^\s*npm run build\s*$/mu.test(run))).toBe(false);
    }
  });

  it('validates the toolkit inside its existing sandbox smoke job', () => {
    expect(existsSync('.github/workflows/toolkit-publish.yml')).toBe(false);
    const sandbox = parse(readFileSync('.github/workflows/verity-sandbox.yml', 'utf8')) as {
      permissions: Record<string, string>;
      jobs: Record<string, WorkflowJob>;
    };
    const steps = sandbox.jobs['smoke-test']?.steps ?? [];
    expect(
      steps.some(
        (step) =>
          step.uses?.startsWith('devcontainers/action@') && step.with?.['validate-only'] === 'true',
      ),
    ).toBe(true);
    expect(sandbox.permissions).toEqual({ contents: 'read' });
  });
});

describe('coverage CI', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: { coverage: WorkflowJob };
  };
  const job = workflow.jobs.coverage;

  it('runs the instrumented suite against the shared PostgreSQL', () => {
    // Coverage runs all 223 files in ONE process pool, so it is the job that
    // pays the per-file pglite boot the most times — and the one that has been
    // losing embedded.test.ts to the OOM killer, which reads as a coverage
    // regression rather than a dead worker.
    expect(job.steps.find((step) => step.uses === './.github/actions/postgres')?.id).toBe(
      'postgres',
    );
    const coverage = job.steps.find((step) => step.run?.includes('npm run coverage'));
    expect(coverage?.env?.VERITY_TEST_SHARED_POSTGRES_URL).toBe(
      '${{ steps.postgres.outputs.url }}',
    );
    expect(job.steps.find((step) => step.run?.includes('docker rm -f'))?.if).toBe('always()');
  });

  it('collects coverage with a single worker', () => {
    // The shared PostgreSQL above does not cover the files that stay hermetic by
    // design — the `createIsolatedTestDb` callers and embedded.test.ts's 40
    // in-memory pglite servers — and this run is unsharded, so it would
    // otherwise inherit vitest.config.ts's default of two workers and let two of
    // those overlap under instrumentation. That default is what killed a worker
    // here, and a worker that dies takes its file's coverage with it while every
    // test still reports as passing: the job then fails as a threshold
    // regression that no code caused.
    const coverage = job.steps.find((step) => step.run?.includes('npm run coverage'));
    expect(coverage?.run).toContain('--maxWorkers=1');
  });
});

describe('shared-host test timeout budget', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    env?: Record<string, string>;
    jobs: Record<string, { env?: Record<string, string>; steps?: WorkflowStep[] }>;
  };
  const config = readFileSync('vitest.config.ts', 'utf8');
  const timeoutEnv = 'VERITY_TEST_TIMEOUT_MS';

  it('keeps a tight local default and a larger workflow-level CI override', () => {
    expect(config).toContain('const DEFAULT_TEST_TIMEOUT_MS = 20_000;');
    expect(config).toContain('Number.isFinite(overrideTimeoutMs) && overrideTimeoutMs > 0');
    expect(config).toContain('testTimeout: TEST_TIMEOUT_MS');
    expect(config).toContain('hookTimeout: TEST_TIMEOUT_MS');
    expect(Number(workflow.env?.[timeoutEnv])).toBeGreaterThan(20_000);
  });

  it('does not shadow or bypass the workflow-level timeout', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job.env?.[timeoutEnv], `job ${name} shadows the CI timeout`).toBeUndefined();
      for (const step of job.steps ?? []) {
        expect(step.env?.[timeoutEnv], `step in ${name} shadows the CI timeout`).toBeUndefined();
        if (step.run?.includes('vitest') || step.run?.includes('npm run coverage')) {
          expect(step.run).not.toMatch(/--(test|hook)Timeout/u);
        }
      }
    }
  });
});

describe('runner race CI', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: { 'runner-postgres-race': WorkflowJob };
  };
  const job = workflow.jobs['runner-postgres-race'];

  it('keeps its own database variable, separate from the shared test harness', () => {
    // VERITY_TEST_POSTGRES_URL un-skips the suites that own the `verity`
    // database directly. Reusing that name for the shared harness would drag
    // this job's suites into all four shards as a side effect.
    const race = job.steps.find((step) => step.run?.includes('runner-frames-postgres.test.ts'));
    expect(race?.env?.VERITY_TEST_POSTGRES_URL).toBe('${{ steps.postgres.outputs.url }}');
    expect(race?.env?.VERITY_TEST_SHARED_POSTGRES_URL).toBeUndefined();
  });

  it('names every suite gated on that variable', () => {
    // A gated suite this step does not name runs NOWHERE: the shard, coverage and
    // embedded jobs never set the variable, so the file's `describe` skips there,
    // and this is the only job that supplies it. The failure is silent in both
    // directions — a skipped describe is green, and a file absent from an
    // explicit list is invisible — which is how the PostgreSQL half of the
    // control-plane generation fence stayed written but unexecuted (ADR 0008).
    // So derive the expectation from the gate itself rather than from a name.
    // Assembled rather than written out, so this file does not match its own
    // search and demand to be listed as a PostgreSQL suite.
    const gate = ['process', 'env', 'VERITY_TEST_POSTGRES_URL'].join('.');
    const gated = execFileSync('git', ['ls-files', '*.test.ts'], { encoding: 'utf8' })
      .split('\n')
      .filter((path) => path !== '')
      .filter((path) => existsSync(path))
      .filter((path) => readFileSync(path, 'utf8').includes(gate));
    expect(gated.length).toBeGreaterThan(0);
    const race = job.steps.find((step) => step.run?.includes('vitest run'));
    for (const suite of gated) expect(race?.run).toContain(suite);
  });

  it('runs those suites one at a time', () => {
    // Every suite this step names shares the ONE database the job started, and
    // they are written on that promise: the generation-fence suite owns
    // `control_plane_generation` and the control-plane advisory lock outright and
    // terminates every session but its own between tests, and the pooled-error
    // suite kills a backend on purpose. Vitest is sequential WITHIN a file, not
    // across them — without this flag it would default to two workers and run two
    // of these files at once, so a suite whose whole subject is a database outage
    // would be inflicting one on its neighbour. The damage does not read as a
    // race either: it surfaces as the victim failing an assertion about locks or
    // rows it never touched.
    const race = job.steps.find((step) => step.run?.includes('vitest run'));
    expect(race?.run).toContain('--maxWorkers=1');
  });
});

describe('self-update release gate', () => {
  const workflow = parse(readFileSync('.github/workflows/self-update.yml', 'utf8')) as {
    on: {
      push?: { branches?: string[]; paths?: string[] };
      pull_request?: unknown;
      workflow_call?: { inputs?: Record<string, { required?: boolean; type?: string }> };
      workflow_dispatch?: unknown;
    };
    concurrency: { group: string };
    jobs: Record<string, { 'timeout-minutes'?: number }>;
  };

  it('labels backend release images with the checked-out source revision', () => {
    const release = readFileSync('.github/workflows/release.yml', 'utf8');
    expect(release).not.toContain('org.opencontainers.image.revision=${{ github.sha }}');
    expect(
      release.match(
        /org\.opencontainers\.image\.revision=\$\{\{ needs\.release-please\.outputs\.backend-sha \}\}/g,
      ),
    ).toHaveLength(4);
  });

  it('runs for actual release candidates and manual recovery, not every main commit', () => {
    expect(workflow.on.push).toBeUndefined();
    // This smoke exercises a live Docker cutover and belongs after merge. Pull
    // requests and ordinary main commits use the regular CI suite.
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.workflow_call?.inputs?.['candidate-sha']).toEqual({
      description: 'Exact backend release commit to exercise',
      required: true,
      type: 'string',
    });
    expect(workflow.on.workflow_call?.inputs?.['bootstrap-version']).toEqual({
      description: 'Explicit one-time version allowed to create the first Server package',
      required: false,
      default: '',
      type: 'string',
    });
    expect(workflow.on.workflow_dispatch).toBeDefined();
  });

  it('checks out and serializes by the exact release candidate', () => {
    const source = readFileSync('.github/workflows/self-update.yml', 'utf8');
    expect(workflow.concurrency.group).toContain('inputs.candidate-sha');
    expect(workflow.concurrency.group).toContain('github.event_name');
    expect(source).toContain('ref: ${{ inputs.candidate-sha || github.sha }}');
  });

  it('tests the candidate against the previous published Server image', () => {
    const source = readFileSync('.github/workflows/self-update.yml', 'utf8');
    // Published, not merely tagged, and the difference is not academic: v13.2.13
    // was tagged by release-please, its release run failed before the image
    // publish, and the next release then walked onto that tag as its predecessor
    // and blocked itself. A tag records that a release was CUT; only the registry
    // knows whether one shipped. So the candidate list comes from ghcr.io's own
    // catalogue and the local ref set is not consulted at all — which is also what
    // makes the answer independent of a persistent runner's refs.
    expect(source).toContain('/tags/list');
    expect(source).toContain('https://ghcr.io/token?service=ghcr.io&scope=repository:');
    // The credential the catalogue read needs in its own hand: docker/login-action
    // only ever put it inside the daemon.
    expect(source).toContain('VERITY_GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(source).toContain('docker pull "$previous"');
    expect(source).toContain('docker load --input "$RUNNER_TEMP/verity-smoke-previous.tar"');
    expect(source).toContain('"$VERITY_SMOKE_PREVIOUS_IMAGE"');
    expect(source).toContain('packages: read');
    // Which release gets picked, and every fail-closed edge, is exercised for real
    // in packages/server/src/self-update/self-update-workflow.test.ts — asserting
    // the text of this step would agree with a broken version of it.
  });

  it('prepares a candidate-backed predecessor only for the first package bootstrap', () => {
    const parsed = parse(readFileSync('.github/workflows/self-update.yml', 'utf8')) as {
      jobs: Record<string, { steps?: WorkflowStep[] }>;
    };
    const steps = parsed.jobs['live-smoke']?.steps ?? [];
    const load = steps.find(
      (step) => step.name === 'Load the previous release into the isolated daemon',
    );
    const build = steps.find(
      (step) => step.name === 'Build the Server image into the isolated daemon',
    );
    const bootstrap = steps.find(
      (step) => step.name === 'Prepare the first-release bootstrap predecessor',
    );
    const smoke = steps.find((step) => step.name === 'Run the live self-update smoke');

    expect(load?.if).toBe("env.VERITY_SMOKE_BOOTSTRAP != 'true'");
    expect(bootstrap?.if).toBe("env.VERITY_SMOKE_BOOTSTRAP == 'true'");
    expect(bootstrap?.run).toContain(
      'docker tag "$VERITY_SMOKE_IMAGE" "$VERITY_SMOKE_PREVIOUS_IMAGE"',
    );
    expect(steps.indexOf(build as WorkflowStep)).toBeLessThan(
      steps.indexOf(bootstrap as WorkflowStep),
    );
    expect(steps.indexOf(bootstrap as WorkflowStep)).toBeLessThan(
      steps.indexOf(smoke as WorkflowStep),
    );
  });

  it('provides the live smoke with a fresh masked database password', () => {
    const parsed = parse(readFileSync('.github/workflows/self-update.yml', 'utf8')) as {
      jobs: Record<string, { steps?: WorkflowStep[] }>;
    };
    const smoke = parsed.jobs['live-smoke']?.steps?.find(
      (step) => step.name === 'Run the live self-update smoke',
    );
    const run = smoke?.run ?? '';

    const generate = run.indexOf('postgres_password="$(openssl rand -hex 32)"');
    const mask = run.indexOf('echo "::add-mask::$postgres_password"');
    const exportPassword = run.indexOf('export VERITY_POSTGRES_PASSWORD="$postgres_password"');
    const invoke = run.indexOf('deploy/bin/verity-self-update-live-smoke');

    expect(generate).toBeGreaterThanOrEqual(0);
    expect(mask).toBeGreaterThan(generate);
    expect(exportPassword).toBeGreaterThan(mask);
    expect(invoke).toBeGreaterThan(exportPassword);
    expect(run).not.toMatch(/VERITY_POSTGRES_PASSWORD=['"][0-9a-f]{64}['"]/);
  });

  it('blocks every backend publish on the cutover verdict', () => {
    // The trigger above only produces a verdict; this is what makes it a gate.
    // Split across two files, so each half looks removable on its own: the gate
    // job without the trigger waits for a run nobody starts, and the trigger
    // without the gate publishes an image whose cutover was never exercised —
    // onto deployments that install it unattended, breaking the channel a fix
    // would have to arrive on.
    const release = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      jobs: Record<
        string,
        { needs?: string | string[]; if?: string; uses?: string; with?: Record<string, string> }
      >;
    };
    const gate = release.jobs['self-update-gate'];
    expect(gate).toBeDefined();
    // Same condition as the publishes it guards, so a push that releases nothing
    // skips the wait rather than idling on a runner for an hour.
    expect(gate?.if).toBe("needs.release-please.outputs.backend-release-created == 'true'");
    expect(gate?.uses).toBe('./.github/workflows/self-update.yml');
    expect(gate?.with?.['candidate-sha']).toBe('${{ needs.release-please.outputs.backend-sha }}');
    expect(gate?.with?.['bootstrap-version']).toBe('16.4.0');

    // Every job that pushes an artifact a managed deployment resolves at the
    // released version. The mobile train is deliberately absent: it carries no
    // Server image, so a Server cutover has nothing to say about it.
    for (const job of [
      'publish-toolkit',
      'publish-sandbox',
      'publish-project-relay',
      'publish-server',
      'publish-preview-images',
    ]) {
      const needs = release.jobs[job]?.needs;
      expect(Array.isArray(needs) ? needs : [needs]).toContain('self-update-gate');
    }
  });

  it('publishes previews only after the stable Server channel', () => {
    const release = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      jobs: Record<string, { needs?: string | string[] }>;
    };
    const needs = release.jobs['publish-preview-images']?.needs;

    expect(Array.isArray(needs) ? needs : [needs]).toContain('publish-server');
  });

  it('keeps maintenance bridge promises immutable and release-controlled', () => {
    const source = readFileSync('.github/workflows/release.yml', 'utf8');
    const parsed = parse(source) as {
      jobs: Record<string, { steps?: WorkflowStep[] }>;
    };
    const validation = parsed.jobs['release-please']?.steps?.find(
      (step) => step.name === 'Validate maintenance backend release',
    );
    expect(validation?.env?.GH_REPO).toBe('${{ github.repository }}');
    expect(source).toContain('backend-schema-forward-max:');
    expect(source).toContain('VERITY_SCHEMA_FORWARD_MAX=${{ env.SCHEMA_FORWARD_MAX }}');
    expect(source).toContain('finalize-maintenance-backend:');
    expect(source).not.toContain('gh workflow run self-update.yml');
    expect(source).toContain('candidate-sha: ${{ needs.release-please.outputs.backend-sha }}');
  });

  it('fails closed when the immutable website tag cannot be authorized', () => {
    const source = readFileSync('.github/workflows/release.yml', 'utf8');
    const promotion = source.slice(source.indexOf('- name: Promote tested digest'));
    expect(promotion).toContain("grep -qiE 'not found|manifest unknown|404'");
    expect(promotion).not.toMatch(/grep[^\n]*(denied|unauthorized)/iu);
    expect(promotion).toContain(
      'Refusing to tag without knowing whether one is already published.',
    );
  });

  it('keeps the live smoke itself bounded', () => {
    const release = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      jobs: Record<string, { 'runs-on'?: string | string[]; steps?: unknown[] }>;
    };
    const smoke = workflow.jobs['live-smoke']?.['timeout-minutes'];
    expect(smoke).toBeGreaterThan(0);
    expect(release.jobs['self-update-gate']?.['runs-on']).toBeUndefined();
    expect(release.jobs['self-update-gate']?.steps).toBeUndefined();
  });
});

describe('brokered secret canary', () => {
  const workflow = parse(readFileSync('.github/workflows/brokered-secret-canary.yml', 'utf8')) as {
    on: {
      schedule?: unknown;
      pull_request?: unknown;
      workflow_call?: unknown;
      workflow_dispatch?: unknown;
    };
  };

  it('runs every six hours and remains available for manual diagnosis', () => {
    expect(workflow.on.schedule).toEqual([{ cron: '17 */6 * * *' }]);
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.workflow_call).toBeUndefined();
    expect(workflow.on.workflow_dispatch).toBeDefined();
  });

  it('reports independently without coupling an outage to backend publication', () => {
    const release = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      jobs: Record<string, { needs?: string | string[] }>;
    };
    expect(release.jobs['brokered-secret-gate']).toBeUndefined();
    for (const job of [
      'publish-toolkit',
      'publish-sandbox',
      'publish-project-relay',
      'publish-server',
    ]) {
      const needs = release.jobs[job]?.needs;
      expect(Array.isArray(needs) ? needs : [needs]).not.toContain('brokered-secret-gate');
    }
  });
});

/**
 * The gate above decides whether a release publishes. This is the check that
 * notices when it decided no and nobody looked.
 *
 * release-please tags and publishes the GitHub release the instant its release PR
 * merges, while every image publish in release.yml is downstream of
 * `self-update-gate`. So a failed gate leaves a `draft=false, prerelease=false`
 * release standing forever with no image behind it, indistinguishable on the
 * releases page from one that shipped. v13.2.13 and v13.2.14 are both in that
 * state, and v13.2.13 sitting there unremarked is what broke v13.2.14's release
 * run six hours later.
 */
describe('release image audit', () => {
  type Job = {
    'runs-on'?: string | string[];
    'timeout-minutes'?: number;
    steps?: WorkflowStep[];
  };
  const audit = parse(readFileSync('.github/workflows/release-image-audit.yml', 'utf8')) as {
    on?: Record<string, unknown>;
    permissions?: Record<string, string>;
    jobs?: Record<string, Job>;
  };

  it('watches from a clock rather than from inside the workflow that breaks', () => {
    // The reason this is not a job in release.yml, asserted rather than left to
    // the header. A job that `needs:` the publishes is SKIPPED when the gate
    // fails — silent in exactly the case it exists for. A job with `if: always()`
    // runs, but inside a run that is already red, and only ever reports on its
    // own release: v13.2.13 stayed broken through two more releases and no run of
    // release.yml would have mentioned it again. And neither runs at all when the
    // release run is cancelled or never starts.
    expect(Object.keys(audit.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
    const release = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      jobs: Record<string, Job>;
    };
    expect(Object.keys(release.jobs)).not.toContain('audit');

    // Minute 0 is when every scheduled workflow on GitHub fires at once, and the
    // repository's other scheduled job already took :23.
    const crons = (audit.on?.schedule as { cron: string }[]).map((entry) => entry.cron);
    expect(crons).toHaveLength(1);
    const minute = crons[0].split(' ')[0];
    expect(minute).not.toBe('0');
    const janitor = parse(readFileSync('.github/workflows/cache-janitor.yml', 'utf8')) as {
      on?: { schedule?: { cron: string }[] };
    };
    expect(minute).not.toBe(janitor.on?.schedule?.[0]?.cron.split(' ')[0]);
  });

  it('reports and never repairs', () => {
    // A check that could delete a release or re-run a publish is a workflow that
    // can remove a release nobody asked it to, on a schedule. The two grants it
    // does need are the ones that make the registry the authority: `packages:
    // read` is what the ghcr.io token exchange trades for a pull token, and
    // `contents: read` is what lists the releases.
    expect(audit.permissions).toEqual({ contents: 'read', packages: 'read' });
    expect(Object.values(audit.permissions ?? {})).not.toContain('write');
  });

  it('keeps the policy in a unit-tested script, not in the YAML', () => {
    // Same split as cache-janitor: which releases are in scope, how long one may
    // legitimately have no images yet, and what separates "never published" from
    // "did not exist at that version" are the parts that can go wrong, and none of
    // them is observable from a workflow run that reports green.
    const steps = audit.jobs?.audit?.steps ?? [];
    const run = steps.find((step) => step.run !== undefined);
    expect(run?.run?.trim()).toBe('node scripts/audit-release-images.mjs');
    expect(steps.filter((step) => step.run !== undefined)).toHaveLength(1);
    // The script is `node`-only and reads ghcr.io over HTTPS, so setup-node has to
    // come first — the same ordering constraint self-update.yml's catalogue read
    // carries, for the same reason.
    const setupNode = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode).toBeGreaterThan(-1);
    expect(steps.indexOf(run as WorkflowStep)).toBeGreaterThan(setupNode);
    expect(audit.jobs?.audit?.['timeout-minutes']).toBeGreaterThan(0);
  });

  it('audits every image release.yml pushes at the released version', () => {
    // The drift this guards is silent by construction: adding a seventh image to
    // release.yml and forgetting it here leaves that image unaudited, and an
    // unaudited image reports green forever. Resolved from release.yml's own job
    // env and matrix rather than restated, so the two cannot agree by accident.
    const release = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      jobs: Record<
        string,
        {
          env?: Record<string, string>;
          strategy?: { matrix?: { include?: Record<string, string>[] } };
          steps?: WorkflowStep[];
        }
      >;
    };
    const pushed = new Set<string>();
    for (const job of Object.values(release.jobs)) {
      for (const matrix of job.strategy?.matrix?.include ?? [{}]) {
        // A sentinel version, so the match below keys on "pushed at the RELEASE
        // version" and not on `:latest` or `:sha-…`, which every publish also
        // pushes and which say nothing about whether a release shipped.
        const vars: Record<string, string> = { ...(job.env ?? {}), VERSION: '9.9.9' };
        let text = (job.steps ?? []).map((step) => step.run ?? '').join('\n');
        for (const [, name, value] of text.matchAll(
          /^\s*([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gm,
        )) {
          vars[name] ??= value.replace(/^["']|["']$/g, '');
        }
        for (let pass = 0; pass < 8; pass += 1) {
          const next = text
            .replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g, (_, key) => matrix[key] ?? '')
            .replace(/\$\{\{\s*env\.([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => vars[key] ?? '')
            .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, key) => vars[key] ?? all);
          if (next === text) break;
          text = next;
        }
        for (const [, image] of text.matchAll(/ghcr\.io\/([A-Za-z0-9._/-]+):v9\.9\.9/g)) {
          pushed.add(image);
        }
      }
    }

    // Guards the guard: a restructured `Compute tags` step would empty this set
    // and make the comparison below pass by matching nothing.
    expect(pushed.size).toBeGreaterThanOrEqual(7);
    // `publish-sandbox` dual-publishes to the pre-#475 path as well. Both tags come
    // off one step, so auditing the alias could only ever restate the same finding
    // — but it is named here rather than filtered by a pattern, so a NEW alias
    // shows up as a failure instead of disappearing into a regex.
    const LEGACY_ALIAS = 'heey-global/verity-sandbox';
    expect(pushed).toContain(LEGACY_ALIAS);
    // The website is versioned on its own train, so its `vX.Y.Z` is not the
    // release version this audit asks about — auditing it here would report it
    // missing for every backend release that did not happen to coincide with a
    // website one. Named rather than pattern-matched, for the same reason as the
    // alias above: a second off-train image has to be argued for, not absorbed.
    const OFF_TRAIN_IMAGE = 'heey-global/verity/verity-website';
    expect(pushed).toContain(OFF_TRAIN_IMAGE);
    const excluded = new Set([LEGACY_ALIAS, OFF_TRAIN_IMAGE]);
    expect([...pushed].filter((image) => !excluded.has(image)).sort()).toEqual(
      [...RELEASE_IMAGES].sort(),
    );
    expect(RELEASE_IMAGES).toContain(SERVER_IMAGE);
  });
});

/** BuildKit still needs a hard per-job ceiling: the GitHub-hosted VM also runs the
 * checkout, package installation and smoke containers beside the builder. */
describe('shared BuildKit footprint', () => {
  const steps = readdirSync('.github/workflows')
    .filter((file) => file.endsWith('.yml'))
    .flatMap((file) => {
      const workflow = parse(readFileSync(join('.github/workflows', file), 'utf8')) as {
        jobs?: Record<string, { steps?: WorkflowStep[] }>;
      };
      return Object.entries(workflow.jobs ?? {}).flatMap(([name, job]) =>
        (job.steps ?? [])
          .filter((step) => step.uses?.startsWith('docker/setup-buildx-action@') === true)
          .map((step) => ({ id: `${file}:${name}`, step })),
      );
    });

  it('bounds every builder within the GitHub-hosted VM', () => {
    expect(steps.length).toBeGreaterThanOrEqual(10);
    const required = ['memory=6g', 'memory-swap=6g', 'cpu-period=100000', 'cpu-quota=300000'];
    const unbounded = steps
      .filter(({ step }) => {
        const options = (step.with?.['driver-opts'] ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        return !required.every((option) => options.includes(option));
      })
      .map(({ id }) => id);
    expect(unbounded).toEqual([]);
  });
});

describe('GitHub-hosted runner boundary', () => {
  type Job = {
    'runs-on'?: string | string[];
    uses?: string;
    env?: Record<string, string>;
    steps?: WorkflowStep[];
  };
  const jobs = readdirSync('.github/workflows')
    .filter((file) => file.endsWith('.yml'))
    .flatMap((file) => {
      const workflow = parse(readFileSync(join('.github/workflows', file), 'utf8')) as {
        jobs?: Record<string, Job>;
      };
      return Object.entries(workflow.jobs ?? {}).map(([name, job]) => ({
        id: `${file}:${name}`,
        job,
      }));
    });
  const declaresRunner = ({ job }: { job: Job }) => job.uses === undefined;

  it('finds every job in every workflow', () => {
    // Guards the guard: a restructured `jobs:` block would make each assertion
    // below pass by matching nothing at all.
    expect(jobs.length).toBeGreaterThanOrEqual(20);
    expect(jobs.filter(declaresRunner).length).toBeGreaterThanOrEqual(30);
  });

  it('runs every concrete job on an approved ephemeral GitHub-hosted runner', () => {
    const hostedImages = new Set(['ubuntu-24.04', 'macos-26']);
    const offenders = jobs
      .filter(declaresRunner)
      .filter(({ job }) => typeof job['runs-on'] !== 'string' || !hostedImages.has(job['runs-on']))
      .map(({ id }) => id);
    expect(offenders).toEqual([]);
  });

  it('reclaims only known hosted-image SDKs before disk-heavy builds', () => {
    const selfUpdate = parse(readFileSync('.github/workflows/self-update.yml', 'utf8')) as {
      jobs: Record<string, Job>;
    };
    const reclaim = (selfUpdate.jobs['live-smoke']?.steps ?? []).find(
      (step) => step.uses === './.github/actions/reclaim-runner-disk',
    );
    expect(reclaim?.with?.['minimum-free-gib']).toBe('25');

    const sandbox = parse(readFileSync('.github/workflows/verity-sandbox.yml', 'utf8')) as {
      jobs: Record<string, Job>;
    };
    const sandboxReclaim = (sandbox.jobs['smoke-test']?.steps ?? []).find(
      (step) => step.uses === './.github/actions/reclaim-runner-disk',
    );
    expect(sandboxReclaim?.with?.['minimum-free-gib']).toBe('25');

    const release = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      jobs: Record<string, Job>;
    };
    const releaseReclaim = (release.jobs['publish-sandbox']?.steps ?? []).find(
      (step) => step.uses === './.github/actions/reclaim-runner-disk',
    );
    expect(releaseReclaim?.with?.['minimum-free-gib']).toBe('25');

    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: Record<string, Job>;
    };
    const serverImageSteps = ci.jobs['server-image']?.steps ?? [];
    const serverImageReclaim = serverImageSteps.find(
      (step) => step.uses === './.github/actions/reclaim-runner-disk',
    );
    const releaseBuildCache = serverImageSteps.find(
      (step) => step.name === 'Release build cache before isolated daemon',
    );
    const cleanInstall = serverImageSteps.find(
      (step) => step.name === 'Verify clean Compose installation on an empty Docker host',
    );
    expect(releaseBuildCache).toBeUndefined();
    expect(serverImageReclaim?.with?.['minimum-free-gib']).toBe('25');
    expect(serverImageSteps.indexOf(serverImageReclaim!)).toBe(
      serverImageSteps.indexOf(cleanInstall!) - 1,
    );

    const action = readFileSync('.github/actions/reclaim-runner-disk/action.yml', 'utf8');
    expect(action).toContain('RUNNER_KIND: ${{ runner.environment }}');
    expect(action).toContain('[[ "$RUNNER_KIND" != github-hosted ]]');
    expect(action).toContain('/usr/local/lib/android');
    expect(action).toContain('/usr/share/dotnet');
    expect(action).toContain('/opt/ghc');
    expect(action).toContain('/opt/hostedtoolcache/CodeQL');
    expect(action).not.toContain('$GITHUB_WORKSPACE');
  });

  it('loads the Verity sandbox image without a duplicate archive export', () => {
    const sandbox = parse(readFileSync('.github/workflows/verity-sandbox.yml', 'utf8')) as {
      jobs: Record<string, Job>;
    };
    const build = (sandbox.jobs['smoke-test']?.steps ?? []).find(
      (step) => step.name === 'Build amd64 and load Docker image',
    );
    expect(build?.with?.load).toBe(true);
    expect(build?.with?.outputs).toBeUndefined();
    expect(readFileSync('.github/workflows/verity-sandbox.yml', 'utf8')).not.toContain(
      'verity-sandbox-smoke.tar',
    );
  });

  it('always scans the public snapshot on its own hosted runner', () => {
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: Record<string, Job>;
    };
    const snapshot = ci.jobs['public-snapshot'];
    expect(snapshot?.if).toBeUndefined();
    expect(snapshot?.needs).toBeUndefined();
    expect(snapshot?.['runs-on']).toBe('ubuntu-24.04');
    const install = (snapshot?.steps ?? []).find((step) => step.name === 'Install pinned Gitleaks');
    expect(install?.run).toContain('version=8.30.1');
    expect(install?.run).toContain(
      '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
    );
    expect(install?.run).toContain('sha256sum --check --strict');
    const sourceScan = (snapshot?.steps ?? []).find(
      (step) => step.name === 'Scan public source tree',
    );
    expect(sourceScan?.run).toContain('env -i PATH="$PATH" TMPDIR="$RUNNER_TEMP" gitleaks git');
    expect(sourceScan?.run).toContain('--redact');
    expect(sourceScan?.run).toContain('--report-format json');
    expect(sourceScan?.run).toContain('.');
    expect(ci.jobs['ci-checks']?.needs).toContain('public-snapshot');
    const gate = (ci.jobs['ci-checks']?.steps ?? []).find(
      (step) => step.name === 'Verify all required jobs succeeded',
    );
    expect(gate?.run).toContain(
      'require_success public-snapshot "${{ needs.public-snapshot.result }}"',
    );
  });

  it('runs the installer suite in an isolated container', () => {
    // The suite drives the real installer under `unshare -r`, and the runner
    // containers get Docker's default seccomp profile, which rejects CLONE_NEWUSER.
    // That is the entire reason this job was GitHub-hosted, and it is a property of
    // one container rather than of the pool — so the exemption is spent on a
    // throwaway container the job starts, not on the runners.
    //
    // `--user` matters as much as the seccomp flag: the suite asserts the installer
    // REFUSES a non-root caller by invoking it outside `unshare -r`. As root that
    // case passes the check it exists to fail, and the assertion inverts silently.
    // `--env CI=true` matters for the mirror image: without it, a container that
    // cannot unshare reports green having exercised nothing.
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: Record<string, Job>;
    };
    const job = ci.jobs.installer;
    expect(job?.['runs-on']).toBe('ubuntu-24.04');
    expect(job?.env?.VERITY_INSTALLER_SANDBOX).toContain('--security-opt seccomp=unconfined');
    const suite = (job?.steps ?? []).find((step) =>
      step.run?.includes('node --test deploy/bin/verity-install.test.mjs'),
    );
    expect(suite?.run).toContain('$VERITY_INSTALLER_SANDBOX');
    expect(suite?.run).toContain('--user "$(id -u):$(id -g)"');
    expect(suite?.run).toContain('--env CI=true');
  });

  it('namespaces every host-daemon tag the cutover smoke creates', () => {
    // The isolated daemon's names are its own business; these three land in the
    // SHARED image store. self-update runs per commit and never cancels a sibling
    // (the concurrency group is per-sha, on purpose), so two runs overlap by design
    // — and a fixed `verity-server:self-update-previous` lets the second retag it
    // between the first's `docker tag` and its `docker save`, which silently tests
    // the candidate against the wrong previous release.
    const workflow = parse(readFileSync('.github/workflows/self-update.yml', 'utf8')) as {
      jobs: Record<string, Job>;
    };
    const env = workflow.jobs['live-smoke']?.env ?? {};
    for (const name of ['VERITY_SMOKE_DIND', 'VERITY_SMOKE_IMAGE', 'VERITY_SMOKE_PREVIOUS_IMAGE']) {
      // Both halves: run_id alone repeats across a re-run of the same run.
      expect(env[name], `${name} is shared with concurrent runs`).toContain('${{ github.run_id }}');
      expect(env[name]).toContain('${{ github.run_attempt }}');
    }
  });

  it('reclaims leaked isolated-daemon state at job start, and only that', () => {
    // The teardown is `if: always()`, which is the workflow's always and not the
    // machine's — an OOM kill, a converge that recreates the lane, or a lost runner
    // skips it. Each leak is a whole Docker root on the disk the live deployment
    // writes to, and nothing else on this host has a reason to remove it. So the
    // reclaimer has to be the NEXT run, before it starts its own daemon, rather than
    // the step the crash is exactly what skipped.
    //
    // And it has to be unable to match anything else: `docker volume prune` here
    // would take `verity-data` and the gateway control volumes with it. Two
    // independent scopes are asserted because either one alone is a single edit away
    // from being general.
    const workflow = parse(readFileSync('.github/workflows/self-update.yml', 'utf8')) as {
      jobs: Record<string, Job>;
    };
    const steps = workflow.jobs['live-smoke']?.steps ?? [];
    // `volume ls`, not `docker volume ls`: the call names its daemon explicitly, so
    // the two words are not adjacent.
    const janitor = steps.find((step) => step.run?.includes('volume ls'));
    expect(janitor?.name).toBe('Reclaim leaked isolated-daemon state');
    // Daemon-side scope: the FULL name this workflow builds — both fields, both
    // numeric, anchored at both ends — and never a volume a container still
    // references. A `.*` in the middle accepts anything that ever takes the
    // prefix, and this step force-removes on the host that serves production.
    expect(janitor?.run).toContain("--filter 'name=^verity-self-update-dind-[0-9]+-[0-9]+-data$'");
    expect(janitor?.run).toContain('--filter dangling=true');
    // Shell-side scope: every name is re-checked against that same shape before it
    // is removed, so a filter that stopped meaning what it means here removes
    // nothing.
    expect(janitor?.run).toContain('^verity-self-update-dind-[0-9]+-[0-9]+-data$');
    expect(janitor?.run).toMatch(/docker[^\n]*volume rm "\$volume"/);

    // The container half, and the reason the volume half cannot stand alone. A run
    // killed after `docker run --detach` leaves a PRIVILEGED dind running on the
    // production host — and while it runs it references its volume, so `dangling`
    // filters the sweep above away from precisely the worst leak. The container has
    // to go first, in this same step, for the volume to become reclaimable.
    expect(janitor?.run).toContain("--filter 'name=^verity-self-update-dind-[0-9]+-[0-9]+$'");
    expect(janitor?.run).toMatch(/docker[^\n]*rm --force[^\n]*"\$container"/);
    expect(janitor?.run).toContain('^verity-self-update-dind-[0-9]+-[0-9]+$');
    // Neither scope may fall back to a prefix. Spelled out, because
    // `name=^verity-self-update-dind-` is what a careless narrowing edit leaves
    // behind and it reads as equivalent to the anchored form. Comments stripped:
    // the step names the prefix form at length to say why it is not used.
    const executed = (janitor?.run ?? '')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(executed, 'a prefix scope selects containers that are not ours').not.toMatch(
      /verity-self-update-dind-(?:\*|\.\*|'|\s)/,
    );
    // The age gate is the second and independent guard: the job's own budget is 90
    // minutes, so a container old enough to be measured in days cannot belong to a
    // run that is still alive. Anything finer would be a race with a release on the
    // other side of it.
    expect(janitor?.run).toContain('{{.RunningFor}}');
    expect(janitor?.run).toContain('*day*|*week*|*month*|*year*) ;;');
    expect(executed, 'a minute- or hour-scale age gate can match a live sibling run').not.toMatch(
      /\*(minute|hour|second)\*/,
    );
    // Both guards are asserted here as text and EXECUTED against representative
    // `docker ps` output in
    // packages/server/src/self-update/self-update-workflow.test.ts — what this
    // step SELECTS is not something a text assertion can exercise.

    expect(
      steps.findIndex((step) => step === janitor),
      'the reclaim runs after the daemon it is meant to clean up after',
    ).toBeLessThan(steps.findIndex((step) => step.name === 'Start the isolated Docker daemon'));
  });
});

/**
 * The single safety change in the move, and the one that has to hold when every
 * other one has been edited away.
 *
 * `deploy/bin/verity-self-update-live-smoke` drives the deployment's REAL container
 * names, because the deployment-spec allowlist pins them, and its cleanup trap ends
 * in `docker ps -aq --filter 'name=^verity-managed-' | xargs -r docker rm -f`. On
 * the runners that line is one step-ordering mistake away from the live Verity
 * deployment. `${DOCKER_HOST:?}` never protected against that — it asks whether the
 * variable is set, and the failure mode is a variable that is set to the wrong
 * thing.
 *
 * Asserted by execution rather than by reading the source for the string: what
 * matters is that the script REFUSES, and a guard can be present and inert.
 */
describe('live cutover smoke daemon guard', () => {
  const script = 'deploy/bin/verity-self-update-live-smoke';

  // A complete argument list, so a refusal below is the guard's and not the usage
  // message's: image, previous image, and the tag the previous release was cut
  // from. `HEAD` stands in for that tag because the only thing the script asks of
  // it before the daemon checks is that this checkout can resolve it.
  const arguments_ = ['verity-server:guard-probe', 'verity-server:guard-previous', 'HEAD'];

  const attempt = (
    dockerHost: string | undefined,
    options: { path?: string; argv?: readonly string[] } = {},
  ) => {
    const env = { ...process.env };
    delete env.DOCKER_HOST;
    if (dockerHost !== undefined) env.DOCKER_HOST = dockerHost;
    if (options.path !== undefined) env.PATH = options.path;
    // Absolute `bash`, because one case below empties PATH on purpose.
    const result = spawnSync('/bin/bash', [script, ...(options.argv ?? arguments_)], {
      encoding: 'utf8',
      env,
    });
    return { status: result.status, stderr: result.stderr ?? '' };
  };

  /**
   * Refused, and refused TERMINALLY. The message alone does not settle it: a guard
   * that prints its objection and lets execution carry on still reaches the cleanup
   * trap, and it will fail on something later — so the exit code is non-zero and the
   * message is there, and a test that asks only those two questions stays green
   * while the deployment is being removed. Requiring the refusal to be the LAST
   * thing on stderr is what says execution stopped where it said it did.
   */
  const expectRefusal = (dockerHost: string, reason: string) => {
    const { status, stderr } = attempt(dockerHost);
    expect(status).not.toBe(0);
    expect(stderr).toContain(reason);
    expect(stderr.trimEnd().split('\n').at(-1), 'the smoke kept going after refusing').toContain(
      'verity-managed-* container on the daemon it is given.',
    );
  };

  it('refuses the host daemon socket by name', () => {
    // The literal a mis-ordered step produces, and the one a hand-run reproduces.
    expectRefusal('unix:///var/run/docker.sock', 'DOCKER_HOST is the host daemon socket');
  });

  it('refuses a daemon that is not addressed by a unix socket at all', () => {
    expectRefusal('tcp://127.0.0.1:2375', 'DOCKER_HOST is not a unix:// socket');
  });

  it('refuses a unix socket that is not in a per-run daemon directory', () => {
    // Not merely "some other socket": a `docker context` or a rootless daemon puts a
    // perfectly ordinary socket somewhere else, and the smoke would adopt whatever
    // stack is on it.
    expectRefusal(
      'unix:///var/lib/somewhere/docker.sock',
      'is not a per-run verity-*dind* directory',
    );
  });

  it('refuses a correctly named path with nothing listening on it', () => {
    expectRefusal(
      'unix:///nonexistent/verity-self-update-dind-1-1/docker.sock',
      'nothing is listening on that socket path',
    );
  });

  it('refuses when DOCKER_HOST is absent entirely', () => {
    // Which layer catches this is deliberately not pinned: `${DOCKER_HOST:?}` and
    // the scheme check both do, and that overlap is the point rather than an
    // accident to tidy up.
    const { status, stderr } = attempt(undefined);
    expect(status).not.toBe(0);
    expect(stderr).toContain('DOCKER_HOST');
  });

  it('accepts the run-scoped shape and moves on to proving the daemon', async () => {
    // Guards the guard, and it is not a formality: every assertion above is also
    // satisfied by a guard that refuses everything, which would take the release
    // gate down rather than production. A real socket in the shape the workflow
    // creates has to get PAST the name checks and fail on the next layer instead —
    // the one that asks the daemon who it is.
    // Short prefix: a unix socket path is capped at ~104 bytes, and macOS's
    // `$TMPDIR` spends about half of that before this adds anything.
    const dir = await mkdtemp(join(tmpdir(), 'bz-'));
    const socketDir = join(dir, 'verity-dind');
    await mkdir(socketDir);
    const socketPath = join(socketDir, 'docker.sock');
    const server = createServer((connection) => connection.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      // PATH is emptied so `docker` is not found, which is the ONLY cheap way to
      // reach the daemon layer deterministically: the Docker CLI applies no timeout
      // to an API call, so a stand-in listener that is not a daemon does not answer
      // "no" — it hangs, for as long as the caller is willing to wait (measured at
      // >20 s before the probe was killed). An absent client and an absent daemon
      // land on the same branch of the guard, and that branch is the one under test.
      const { status, stderr } = attempt(`unix://${socketPath}`, { path: '/var/empty' });
      expect(status).not.toBe(0);
      expect(stderr).not.toContain('is not a per-run verity-*dind* directory');
      expect(stderr).not.toContain('nothing is listening on that socket path');
      expect(stderr).toContain('no Docker daemon answered on that socket');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The two layers above the name checks are the ones naming cannot spoof, and they
   * are the reason the guard is worth having — so they cannot be the untested part.
   *
   * Standing up a genuine second daemon is not available here, and a stand-in
   * listener is worse than nothing: the Docker CLI puts no timeout on an API call,
   * so a socket that accepts and does not speak the API hangs rather than answers.
   * What CAN be exercised is the decision itself. `docker` is a stub on PATH,
   * answering the three questions the guard asks — the isolated daemon's ID, the
   * host daemon's ID, and which `verity-*` containers exist — so each branch is
   * driven by a fixture instead of by an environment nobody can arrange.
   *
   * The stub also refuses everything else, loudly. That is what makes the accepting
   * case provable rather than merely silent: if the guard lets execution through,
   * the smoke's first real command hits the stub and says so.
   */
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

  const stubDocker = (answers: {
    isolated: string | null;
    host: string | null;
    adopted: string[];
  }) =>
    '#!/usr/bin/env bash\n' +
    'argv="$*"\n' +
    'case "$argv" in\n' +
    // Checked first: the host lookup's argv also matches the isolated pattern.
    '  *"unix:///var/run/docker.sock info"*)\n' +
    (answers.host === null ? '    exit 1 ;;\n' : `    printf '%s\\n' ${quote(answers.host)} ;;\n`) +
    '  *" info "*)\n' +
    (answers.isolated === null
      ? '    exit 1 ;;\n'
      : `    printf '%s\\n' ${quote(answers.isolated)} ;;\n`) +
    '  *" ps "*)\n' +
    `    printf '%s' ${quote(answers.adopted.map((id) => `${id}\n`).join(''))} ;;\n` +
    '  *" volume ls "*|*" network ls "*)\n' +
    '    exit 0 ;;\n' +
    // The drift stage's own precondition, asked between the guard and the first
    // container. Answered rather than refused so the accepting case below still
    // proves what it says: that execution reached a real command.
    '  "compose version")\n' +
    '    exit 0 ;;\n' +
    '  *)\n' +
    '    echo "STUB: the guard let execution reach: docker $argv" >&2\n' +
    '    exit 97 ;;\n' +
    'esac\n';

  // The smoke reaches `mkdir --mode=0700` immediately after the guard, and BSD
  // userland has no `--mode`. Without this the accepting case below could not tell
  // "the guard passed" from "the guard passed and then macOS ended the script one
  // line later", which is the difference the assertion is about.
  const portableMkdir =
    '#!/usr/bin/env bash\n' +
    'args=()\n' +
    'for arg in "$@"; do\n' +
    '  case "$arg" in\n' +
    '    --mode=*) args+=(-m "${arg#--mode=}") ;;\n' +
    '    *) args+=("$arg") ;;\n' +
    '  esac\n' +
    'done\n' +
    'for candidate in /bin/mkdir /usr/bin/mkdir; do\n' +
    '  [[ -x "$candidate" ]] && exec "$candidate" "${args[@]}"\n' +
    'done\n' +
    'echo "no system mkdir" >&2\n' +
    'exit 1\n';

  const withStubbedDaemons = async (
    answers: {
      isolated: string | null;
      host: string | null;
      adopted: string[];
      argv?: readonly string[];
    },
    check: (result: { status: number | null; stderr: string }) => void,
  ) => {
    const dir = await mkdtemp(join(tmpdir(), 'bz-'));
    const socketDir = join(dir, 'verity-dind');
    const stubDir = join(dir, 'stub');
    await mkdir(socketDir);
    await mkdir(stubDir);
    await writeFile(join(stubDir, 'docker'), stubDocker(answers), { mode: 0o755 });
    await writeFile(join(stubDir, 'mkdir'), portableMkdir, { mode: 0o755 });
    const socketPath = join(socketDir, 'docker.sock');
    const server = createServer((connection) => connection.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      check(
        attempt(`unix://${socketPath}`, {
          path: `${stubDir}:${process.env.PATH ?? ''}`,
          ...(answers.argv === undefined ? {} : { argv: answers.argv }),
        }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('refuses a daemon whose identity is the host daemon’s', async () => {
    // The failure the name checks structurally cannot see: a socket in a perfectly
    // run-scoped path that is a symlink, bind mount or proxy onto production. Same
    // ID on both sides is what that looks like from here, and it is the only thing
    // that looks like it.
    await withStubbedDaemons(
      { isolated: 'daemon-shared', host: 'daemon-shared', adopted: [] },
      ({ status, stderr }) => {
        expect(status).not.toBe(0);
        expect(stderr).toContain('that socket is answered by the HOST Docker daemon');
      },
    );
  });

  it('refuses when the host daemon cannot be identified at all', async () => {
    // Fails CLOSED, which is the whole point and was the bug: an unreadable
    // /var/run/docker.sock used to be accepted, on the reading that a host daemon
    // which does not answer cannot be the one on the other socket. It proves no such
    // thing — it removes the evidence. And it removes it in exactly the environments
    // that earn the check: a remapped, proxied or partially mounted socket layout is
    // both why the canonical path goes quiet and how a run-scoped path ends up wired
    // to production.
    await withStubbedDaemons(
      { isolated: 'daemon-isolated', host: null, adopted: [] },
      ({ status, stderr }) => {
        expect(status).not.toBe(0);
        expect(stderr).toContain('could not be identified');
        // Not the generic one: the operator has to be told which half is missing.
        expect(stderr).not.toContain('answered by the HOST Docker daemon');
      },
    );
  });

  it('refuses a daemon that already holds verity-* containers', async () => {
    // The backstop for a failure nobody has thought of yet. Whatever new route a
    // future edit finds to hand this script the production daemon, that daemon has
    // the production containers on it — and they are precisely what the cleanup trap
    // force-removes, so their presence is disqualifying on its own.
    await withStubbedDaemons(
      {
        isolated: 'daemon-isolated',
        host: 'daemon-host',
        adopted: ['c0ffee1234', 'deadbeef56'],
      },
      ({ status, stderr }) => {
        expect(status).not.toBe(0);
        expect(stderr).toContain('the daemon already holds 2 verity-* container(s)');
      },
    );
  });

  it('lets a daemon that answers all three questions correctly through', async () => {
    // The one that keeps every assertion above honest. A guard that refused
    // unconditionally would satisfy all of them and take the release gate down
    // instead of production — a quieter failure, and a worse one, because it would be
    // "fixed" by weakening the guard. Proven positively: the stub reports the smoke's
    // first real command, so passing here means execution actually continued.
    await withStubbedDaemons(
      { isolated: 'daemon-isolated', host: 'daemon-host', adopted: [] },
      ({ stderr }) => {
        expect(stderr).not.toContain('refuses to run');
        expect(stderr).toContain(
          'STUB: the guard let execution reach: docker run --detach --name verity-smoke-registry',
        );
      },
    );
  });

  /**
   * The drift stage's inputs, refused on the same terms as the daemon.
   *
   * That stage is the only place this smoke can see a difference between the
   * release a host was installed from and the one it is being offered, and it can
   * only see it because the caller hands over the PREVIOUS RELEASE'S TAG. Default
   * that to the working tree and the stage compares a release against itself:
   * green, always, on the exact class of change that took production down twice in
   * one night. So a missing or unresolvable tag stops the run rather than
   * degrading it — and it does so AFTER the daemon guard, because being pointed at
   * production is the more urgent of the two mistakes.
   */
  it('refuses to run the drift stage against an unnamed previous release', async () => {
    await withStubbedDaemons(
      {
        isolated: 'daemon-isolated',
        host: 'daemon-host',
        adopted: [],
        argv: ['verity-server:guard-probe', 'verity-server:guard-previous'],
      },
      ({ status, stderr }) => {
        expect(status).not.toBe(0);
        expect(stderr).toContain('the previous release tag is required');
        // Refused BEFORE anything is created: reaching the registry would mean the
        // run is under way and the cleanup trap is armed.
        expect(stderr).not.toContain('STUB: the guard let execution reach');
      },
    );
  });

  it('refuses a previous release this checkout cannot show the Compose file of', async () => {
    // Fails closed on purpose. The alternative — carrying on without the drift
    // stage — turns a shallow clone or a missing `fetch-depth: 0` into a silently
    // weaker release gate, which is indistinguishable from a green one.
    await withStubbedDaemons(
      {
        isolated: 'daemon-isolated',
        host: 'daemon-host',
        adopted: [],
        argv: ['verity-server:guard-probe', 'verity-server:guard-previous', 'v0.0.0-never-tagged'],
      },
      ({ status, stderr }) => {
        expect(status).not.toBe(0);
        expect(stderr).toContain("'v0.0.0-never-tagged' is not a commit in this checkout");
        expect(stderr).not.toContain('STUB: the guard let execution reach');
      },
    );
  });

  it('refuses the daemon before it notices the missing tag', async () => {
    // Ordering, asserted rather than assumed. Both refusals are correct, but only
    // one of them is about a daemon that may be production's — and a run that
    // stopped on the argument list would have been re-run with the argument added,
    // straight into the daemon this exists to keep it away from.
    const { status, stderr } = attempt('unix:///var/run/docker.sock', {
      argv: ['verity-server:guard-probe'],
    });

    expect(status).not.toBe(0);
    expect(stderr).toContain('DOCKER_HOST is the host daemon socket');
    expect(stderr).not.toContain('the previous release tag is required');
  });
});

describe('CI runner footprint', () => {
  type Job = { 'runs-on'?: string | string[]; steps?: WorkflowStep[] };
  const runnerJobs = readdirSync('.github/workflows')
    .filter((file) => file.endsWith('.yml'))
    .flatMap((file) => {
      const workflow = parse(readFileSync(join('.github/workflows', file), 'utf8')) as {
        jobs: Record<string, Job>;
      };
      return Object.entries(workflow.jobs ?? {}).map(([name, job]) => ({
        id: `${file}:${name}`,
        job,
      }));
    });

  it('still sets up Node in the jobs that need it', () => {
    const setups = runnerJobs.flatMap(({ job }) =>
      (job.steps ?? []).filter((step) => step.uses?.includes('actions/setup-node')),
    );
    expect(setups.length).toBeGreaterThanOrEqual(8);
  });

  it('installs only the workspaces covered by the root lint gate', () => {
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: Record<string, { steps?: WorkflowStep[] }>;
    };
    const install = (ci.jobs.lint?.steps ?? []).find((step) => step.run?.includes('npm ci'))?.run;

    expect(install).toContain('--workspace packages');
    expect(install).toContain('--include-workspace-root');
    expect(install).toContain('--ignore-scripts');
    expect(install).toContain('--omit=optional');
    expect(install).not.toMatch(/^npm ci$/u);
  });

  it('keys the Prettier cache by content, not by mtime', () => {
    // Prettier's default cache strategy is `metadata` — mtime and size. Our six
    // lanes each check the tree out into their own workspace, so the mtimes a
    // cached entry was written against belong to whichever lane produced it. An
    // mtime-keyed cache restored onto any other lane misses on every file, which
    // is a cache that costs a network round trip and returns nothing. This is a
    // single flag that reads like noise and would not survive a tidy-up, so it is
    // asserted rather than commented.
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> }
    ).scripts;
    expect(scripts?.format).toContain('--cache-strategy content');
    expect(scripts?.format).toContain('--cache-location .cache/prettier');
  });

  it('persists the Prettier cache across runs', () => {
    // Without a cache step the flag above is inert: `actions/checkout` cleans the
    // workspace at the start of every job, so `.cache/prettier` would be created
    // and thrown away each time.
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: Record<string, { steps?: WorkflowStep[] }>;
    };
    const cached = (ci.jobs.lint?.steps ?? []).some(
      (step) => step.uses?.includes('actions/cache') && step.with?.path === '.cache/prettier',
    );
    expect(cached).toBe(true);
  });

  it('never caches the ESLint result, because that cache fails OPEN', () => {
    // Prettier's cache above is safe; ESLint's is not, and the difference is not
    // visible from the shape of the two steps — which is why this is asserted and
    // not left to the comment in ci.yml. An ESLint cache entry is invalidated by
    // the linted file's own content, but typescript-eslint `projectService`
    // findings depend on OTHER files' types: change a type in packages/events,
    // leave a consumer in packages/server untouched, and the consumer is served
    // its pre-change verdict. A stale entry does not produce a spurious error
    // that someone investigates — it produces a GREEN gate over code that no
    // longer lints. The key hashed only package-lock.json and eslint.config.js,
    // so no source change busted it, and `restore-keys` restored arbitrarily old
    // entries on top.
    //
    // It also almost certainly never hit: ESLint's default `cacheStrategy` is
    // `metadata` (mtime + size) and the six lanes each check the tree out into
    // their own workspace, so an entry written on one lane re-lints everything on
    // the next. Both halves are asserted because "add --cache, it is free" is the
    // obvious review comment and the flag costs one line to reintroduce.
    //
    // `lint:changed` is deliberately NOT covered: the pre-push hook runs it on a
    // single machine with stable mtimes, and it only ever lints the changed files,
    // so it never claimed to see an unchanged consumer in the first place.
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> }
    ).scripts;
    expect(scripts?.lint).not.toContain('--cache');
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: Record<string, { steps?: WorkflowStep[] }>;
    };
    const restored = (ci.jobs.lint?.steps ?? []).filter(
      (step) =>
        step.uses?.includes('actions/cache') && String(step.with?.path ?? '').includes('eslint'),
    );
    expect(restored).toEqual([]);
    // Guards the guard: `lint` must still be the whole-tree ESLint invocation, or
    // the assertion above passes over a script that no longer runs ESLint at all.
    expect(scripts?.lint).toContain('eslint');
    const eslintStep = (ci.jobs.lint?.steps ?? []).find((step) => step.name === 'ESLint');
    expect(eslintStep?.run ?? '(the lint job has no step named ESLint)').toContain('npx eslint');
    // Comment lines are stripped: the note left in that step explains what was
    // removed and therefore says `--cache` itself.
    const flags = (eslintStep?.run ?? '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'));
    expect(flags.filter((line) => line.includes('--cache'))).toEqual([]);
  });
});

describe('Actions cache budget', () => {
  // The repository has ONE 10 GB Actions cache, shared by six Dockerfiles across
  // nine build steps and by anything else that caches. Run 31219396281 failed
  // with the repo 2.29 GB over that limit: buildx reported layers as CACHED,
  // GitHub evicted them mid-build, and `cache-from` died on `blob <sha>: not
  // found` — on a PR whose diff was a single Vitest flag. Each assertion below is
  // one of the three ways a build step can spend that budget badly.
  type Job = { steps?: WorkflowStep[]; 'timeout-minutes'?: number };
  const gha = readdirSync('.github/workflows')
    .filter((file) => file.endsWith('.yml'))
    .flatMap((file) => {
      const workflow = parse(readFileSync(join('.github/workflows', file), 'utf8')) as {
        on?: Record<string, unknown>;
        jobs?: Record<string, Job>;
      };
      const triggers = Object.keys(workflow.on ?? {});
      return Object.entries(workflow.jobs ?? {}).flatMap(([jobName, job]) =>
        (job.steps ?? [])
          .filter((step) =>
            [step.with?.['cache-from'], step.with?.['cache-to']].some((value) =>
              String(value ?? '').includes('type=gha'),
            ),
          )
          .map((step) => ({
            id: `${file}:${jobName}:${step.name ?? step.uses ?? '(unnamed)'}`,
            triggers,
            dockerfile: String(step.with?.file ?? '(none)'),
            from: String(step.with?.['cache-from'] ?? ''),
            to: String(step.with?.['cache-to'] ?? ''),
            timeoutMinutes: job['timeout-minutes'],
          })),
      );
    });

  const janitor = parse(readFileSync('.github/workflows/cache-janitor.yml', 'utf8')) as {
    on?: Record<string, unknown>;
    permissions?: Record<string, string>;
    jobs?: Record<string, Job>;
  };

  const scopeOf = (value: string) => /scope=([^,'"\s]+)/.exec(value)?.[1];

  it('finds every gha cache site', () => {
    // Guards the guard: a renamed input or a restructured step would make all of
    // the assertions below pass by matching nothing.
    expect(gha.length).toBeGreaterThanOrEqual(9);
  });

  it('gives every image its own cache scope', () => {
    // Without `scope` every build exports into buildkit's default scope
    // `buildkit`, so each of the nine steps overwrites the index the previous one
    // wrote. A build then imports a manifest describing a DIFFERENT image's
    // layers, which is the second half of the `blob: not found` failure.
    expect(gha.filter((site) => scopeOf(site.from) === undefined).map((s) => s.id)).toEqual([]);
    expect(
      gha.filter((site) => site.to !== '' && scopeOf(site.to) === undefined).map((s) => s.id),
    ).toEqual([]);
  });

  it('reads from the same scope it writes to', () => {
    // A `cache-to` scope without the matching `cache-from` scope is worse than no
    // scope at all: the export succeeds, the import silently misses everything,
    // and the build looks merely slow.
    const mismatched = gha
      .filter((site) => site.to !== '' && scopeOf(site.from) !== scopeOf(site.to))
      .map((site) => `${site.id}: ${String(scopeOf(site.from))} != ${String(scopeOf(site.to))}`);
    expect(mismatched).toEqual([]);
  });

  it('keys the scope by image, not by workflow', () => {
    // ci.yml, verity-server.yml and release.yml all build deploy/Dockerfile and
    // SHOULD share one entry — splitting them triples the budget for identical
    // layers. Two different Dockerfiles sharing a scope is the original bug.
    const group = (key: (site: (typeof gha)[number]) => string, value: typeof key) => {
      const groups = new Map<string, Set<string>>();
      for (const site of gha) {
        const bucket = groups.get(key(site)) ?? new Set<string>();
        bucket.add(value(site));
        groups.set(key(site), bucket);
      }
      return [...groups].filter(([, members]) => members.size > 1).map(([name]) => name);
    };
    const scope = (site: (typeof gha)[number]) => scopeOf(site.from) ?? '(none)';
    expect(group((site) => site.dockerfile, scope)).toEqual([]);
    expect(group(scope, (site) => site.dockerfile)).toEqual([]);
  });

  it('never lets a cache export fail the build', () => {
    // Every one of these images is either `load`ed for a smoke test or pushed to
    // ghcr before the export runs, so the gha entry is pure optimization: a cache
    // the next run cannot reuse costs time, not correctness. Without
    // `ignore-error` buildx propagates the exporter's failure and the job goes
    // red on a working image — run 31219396281 sat 2.5 minutes on `#74 writing
    // layer <sha>` while GitHub was evicting the blobs being written.
    const offenders = gha
      .filter((site) => site.to !== '' && !site.to.includes('ignore-error=true'))
      .map((site) => site.id);
    expect(offenders).toEqual([]);
  });

  it('does not write the cache from a pull request ref', () => {
    // GitHub scopes entries by ref: one written from `refs/pull/N/merge` is
    // invisible to main and to every other PR, readable only by later pushes to
    // that same PR. So a PR write mostly consumes budget — and what gets evicted
    // for it are main's entries, the ones every branch reads.
    const offenders = gha
      .filter(
        (site) =>
          site.triggers.includes('pull_request') &&
          site.to !== '' &&
          !site.to.includes("github.event_name != 'pull_request' && 'type=gha"),
      )
      .map((site) => site.id);
    expect(offenders).toEqual([]);
  });

  it('spells the gate so the empty string is the fallback', () => {
    // GitHub's `&&`/`||` return operands, not booleans, and `''` is falsy. So
    // `event_name == 'pull_request' && '' || 'type=gha…'` reads correctly and
    // does the opposite: the empty branch falls straight through to the cache
    // string, exporting on every event. It is the natural way to write this and
    // it passed review once already.
    const inverted = gha.filter((site) => /&&\s*''\s*\|\|/.test(site.to)).map((site) => site.id);
    expect(inverted).toEqual([]);
  });

  it('keeps a janitor as the fallback line, with only the permission it needs', () => {
    // Every assertion above can regress silently, and the symptom lands on an
    // unrelated PR. The janitor trims the budget between runs so GitHub never has
    // to evict inside one. `actions: write` is deliberately NOT on the project App
    // token (packages/server/src/github-app-token.ts) — this scheduled workflow is
    // the sanctioned place for it, so its permission block stays minimal.
    expect(Object.keys(janitor.on ?? {})).toContain('schedule');
    expect(janitor.permissions).toEqual({ actions: 'write', contents: 'read' });
    const steps = Object.values(janitor.jobs ?? {}).flatMap((job) => job.steps ?? []);
    // The policy lives in a unit-tested script, not in inline bash: "which entries
    // are safe to delete" is the part that can go wrong quietly.
    expect(steps.some((step) => step.run?.includes('scripts/prune-actions-cache.mjs'))).toBe(true);
  });

  it('bounds every cache consumer below the janitor grace period', () => {
    // The janitor only deletes entries nobody has read for `CACHE_MIN_AGE_MINUTES`,
    // which keeps it from pulling a cache out from under a build that is still
    // restoring it. That argument only holds if a job cannot outlive the grace
    // period — and a job with no `timeout-minutes` inherits GitHub's 360-minute
    // default, six times the window. Every one of these images is a single-arch
    // amd64 build on GitHub-hosted runners and finishes in minutes, so the
    // bound costs nothing; without it the grace period is an assumption rather
    // than a guarantee.
    const graceMinutes = Number(
      Object.values(janitor.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .map((step) => step.env?.CACHE_MIN_AGE_MINUTES)
        .find((value) => value !== undefined),
    );
    expect(graceMinutes).toBeGreaterThan(0);

    const offenders = gha
      .filter(
        (site) => !(typeof site.timeoutMinutes === 'number') || site.timeoutMinutes >= graceMinutes,
      )
      .map((site) => `${site.id}: ${site.timeoutMinutes ?? 'no timeout-minutes'}`);
    expect(offenders).toEqual([]);
  });
});

describe('persistent buildx builder', () => {
  // `docker/setup-buildx-action` with no inputs mints a docker-container builder
  // per job and (v4 default `cleanup: true`) deletes it — and its `_state` volume
  // — in its post step, on a host whose Docker daemon persists. The image jobs
  // pin ONE named builder instead, so local layers survive between runs. That is
  // what makes a second push to the same PR cheap: `cache-to` is gated off on PR
  // refs, so `type=gha` alone can never carry anything from one PR push to the
  // next. Every assertion here covers a way that setup silently degrades back to
  // "builds fine, caches nothing".
  const BUILDER = 'verity-ci-bounded-v1';
  type Job = { steps?: WorkflowStep[] };
  const jobs = readdirSync('.github/workflows')
    .filter((file) => file.endsWith('.yml'))
    .flatMap((file) => {
      const workflow = parse(readFileSync(join('.github/workflows', file), 'utf8')) as {
        jobs?: Record<string, Job>;
      };
      return Object.entries(workflow.jobs ?? {}).map(([jobName, job]) => ({
        id: `${file}:${jobName}`,
        file,
        job,
      }));
    });

  it('retires the previous unbounded persistent builder during migration', () => {
    const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: Record<string, { steps?: WorkflowStep[] }>;
    };
    const migration = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.name === 'Retire previous persistent builder');
    expect(migration?.run).toContain('docker buildx rm --force verity-ci');
  });
  const persistent = jobs.flatMap(({ id, file, job }) =>
    (job.steps ?? [])
      .filter((step) => step.uses?.includes('docker/setup-buildx-action') && step.with?.name)
      .map((step) => ({ id, file, with: step.with ?? {} })),
  );

  it('uses one builder name everywhere, and points every build at it', () => {
    // Two names mean two buildkit containers and two `_state` volumes on one
    // host: the cache is split, the disk bill doubles, and nothing fails.
    expect([...new Set(persistent.map((site) => String(site.with.name)))]).toEqual([BUILDER]);
    // `builder:` on the build step is not redundant with `name:`. The action
    // passes `--use` only on the path where it CREATES the builder; once the
    // builder exists it logs "skipping creation" and leaves the lane's current
    // builder wherever it was — which release.yml's ephemeral builder resets to
    // `default` when its post step removes it. A build that lands on `default` is
    // on the docker driver, which cannot even import `type=gha`.
    const files = new Set(persistent.map((site) => site.file));
    const unpinned = jobs
      .filter(({ file, job }) => files.has(file) && (job.steps ?? []).some((s) => s.with?.name))
      .flatMap(({ id, job }) =>
        (job.steps ?? [])
          .filter(
            (step) =>
              step.uses?.includes('docker/build-push-action') && step.with?.builder !== BUILDER,
          )
          .map((step) => `${id}:${step.name ?? step.uses ?? '(unnamed)'}`),
      );
    expect(unpinned).toEqual([]);
  });

  it('never lets a job boundary remove the shared builder', () => {
    // `keep-state: true` looks like the input for this and is the wrong one: it
    // still runs `buildx rm --keep-state` in the post step, which keeps the volume
    // but DELETES the container. With one name shared by six lanes on one daemon,
    // that tears the builder out from under whichever lane is mid-build. Only
    // `cleanup: false` makes the post step a no-op.
    const removers = persistent
      .filter((site) => String(site.with.cleanup) !== 'false')
      .map((site) => site.id);
    expect(removers).toEqual([]);
    expect(persistent.filter((site) => site.with['keep-state'] !== undefined)).toEqual([]);
  });

  it('keeps release publishing and the throwaway dind daemon off it', () => {
    // Deliberate asymmetry, pinned so nobody "aligns" the remaining sites. The
    // shared builder is written by every PR build on the host, and a BuildKit
    // entry's RESULT is whatever the build that first produced its key wrote — so
    // the jobs that push and sign release artifacts keep the ephemeral builder and
    // take their layers from this job plus what main wrote to `type=gha`.
    // self-update.yml is excluded for a different reason: its DOCKER_HOST points
    // at a throwaway dind daemon, so there is no surviving state to keep.
    expect([...new Set(persistent.map((site) => site.file))].sort()).toEqual([
      'ci.yml',
      'project-relay.yml',
      'verity-sandbox.yml',
      'verity-server.yml',
    ]);
  });

  it('bounds the shared build cache by size, never by age', () => {
    // Two different stores live on this host: the daemon's own build cache, which
    // `docker builder prune` addresses, and the docker-container builder's
    // `_state` volume, which only `docker buildx prune --builder` reaches. The
    // cleanup steps used to age-filter the first and never touch the second — so
    // now that the second survives the job, nothing would ever bound it.
    //
    // An age filter is the wrong tool on shared state twice over: it deletes by
    // last-use no matter how much disk is actually at stake (throwing away exactly
    // the base layers a cold PR needs after a quiet weekend), and it runs at the
    // end of EVERY job while five other lanes may be mid-build. A size cap removes
    // nothing until the store is genuinely over budget.
    const prunes = jobs.flatMap(({ id, job }) =>
      (job.steps ?? [])
        .filter((step) => /docker (builder|buildx) prune/.test(step.run ?? ''))
        .map((step) => ({ id, run: step.run ?? '' })),
    );
    expect(prunes.length).toBeGreaterThanOrEqual(4);
    const ageFiltered = prunes.flatMap(({ id, run }) =>
      run
        .split('\n')
        .filter((line) => /\bprune\b/.test(line) && line.includes('--filter'))
        .map((line) => `${id}: ${line.trim()}`),
    );
    expect(ageFiltered).toEqual([]);
    // Whoever writes into the shared store also caps it — otherwise a PR that
    // only touches the relay never runs the job that happens to hold the cap.
    const uncapped = jobs
      .filter(({ job }) => (job.steps ?? []).some((step) => step.with?.builder === BUILDER))
      .filter(
        ({ job }) =>
          !(job.steps ?? []).some(
            (step) =>
              step.run?.includes(`docker buildx prune --builder ${BUILDER}`) &&
              step.run.includes('--keep-storage'),
          ),
      )
      .map(({ id }) => id);
    expect(uncapped).toEqual([]);
  });
});

describe('server image CI smoke', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: {
      'server-image': {
        env: Record<string, string>;
        steps: WorkflowStep[];
      };
    };
  };
  const job = workflow.jobs['server-image'];
  const build = job.steps.find((step) => step.name === 'Build Verity server image');
  const smoke = job.steps.find((step) => step.name === 'Smoke-test Verity server image');
  const cleanInstall = job.steps.find(
    (step) => step.name === 'Verify clean Compose installation on an empty Docker host',
  );

  // The gha cache invariants for this step (scope, `ignore-error`, no write from
  // a PR ref) are asserted for every build step in the repo by the
  // `Actions cache budget` block above.

  it('starts the relay-only runtime with every mandatory deployment seam', () => {
    expect(job.env.VERITY_CI_RELAY_IMAGE).toMatch(
      /^ghcr\.io\/heey-global\/verity\/verity-project-relay@sha256:[a-f0-9]{64}$/,
    );
    expect(build?.with?.['build-args']).toContain(
      'VERITY_BUNDLED_PROJECT_RELAY_IMAGE=${{ env.VERITY_CI_RELAY_IMAGE }}',
    );
    expect(smoke?.run).toContain('--group-add 65532');
    expect(smoke?.run).toContain('-e VERITY_DOCKER_BASE_URL=unix:///var/run/docker.sock');
    expect(smoke?.run).toContain('-e VERITY_DATA_VOLUME=verity-data');
    expect(smoke?.run).toContain('-e VERITY_PROJECT_RELAY_IMAGE="$VERITY_CI_RELAY_IMAGE"');
    expect(smoke?.run).toContain(
      '-e VERITY_AGENT_GATEWAY_CONTROL_SOCKET=/tmp/verity-agent-gateway-control.sock',
    );
    expect(smoke?.run).toContain(
      '-e VERITY_AGENT_GATEWAY_UNSEAL_KEY="$VERITY_CI_GATEWAY_UNSEAL_KEY"',
    );
    expect(smoke?.run).toContain('-e VERITY_AGENT_GATEWAY_URL=https://verity-agent-gateway:9443');
    expect(smoke?.run).toContain('-e VERITY_CLAUDE_EGRESS_GATEWAY_URL=https://verity:9443');
    expect(smoke?.run).toContain('-e VERITY_CLAUDE_CONNECTOR_PORT=47821');
  });

  it('runs the public Compose quick start against an isolated empty daemon', () => {
    expect(job.env.VERITY_CI_CLEAN_DIND).toContain('${{ github.run_id }}');
    expect(job.env.VERITY_CI_CLEAN_DIND).toContain('${{ github.run_attempt }}');
    expect(job.env.VERITY_CI_CLEAN_DIND_VOLUME).toContain('${{ github.run_id }}');
    expect(job.env.VERITY_CI_CLEAN_DIND_VOLUME).toContain('${{ github.run_attempt }}');
    expect(cleanInstall?.run).toContain(
      'docker save "$VERITY_CI_IMAGE" | docker --host "$isolated" load',
    );
    expect(cleanInstall?.run).not.toContain('verity-clean-install-server.tar');
    expect(cleanInstall?.run).not.toContain('load --input');
    expect(cleanInstall?.run).toContain('--volume "$socket_dir:$socket_dir"');
    expect(cleanInstall?.run).toContain('--host="unix://$socket_path"');
    expect(cleanInstall?.run).toContain(
      'VERITY_CLEAN_INSTALL_DAEMON_ID="$isolated_id" DOCKER_HOST="$isolated" deploy/bin/verity-clean-install-smoke "$VERITY_CI_IMAGE"',
    );
    expect(cleanInstall?.run).toContain(
      'docker --host unix:///var/run/docker.sock rm --force "$VERITY_CI_CLEAN_DIND"',
    );
    expect(cleanInstall?.run).not.toContain('GITHUB_ENV');

    const harness = readFileSync('deploy/bin/verity-clean-install-smoke', 'utf8');
    expect(harness).toContain('host_state_root="$(mktemp -d "$socket_dir/state.XXXXXX")"');
    expect(harness).toContain('VERITY_DOCKER_SOCKET_PATH="$socket"');
    expect(harness).toContain('VERITY_AGENT_SEED_HOST_PATH="$host_state_root/agent-seed"');
    expect(harness).toContain('VERITY_HOST_CLONE_ROOT="$host_state_root/workspaces"');
    expect(harness).toContain('VERITY_SECRET_MATERIALIZATION_ROOT="$host_state_root/secrets"');
    expect(harness).toContain('VERITY_PAIRING_STATE_HOST_PATH="$pairing_state"');
    expect(harness).toContain('export VERITY_MANAGED_DEPLOYMENT_ID=');
    expect(harness).toContain('/opt/verity-install/deploy/bin/verity-pairing-material');
    expect(harness).toContain('--env VERITY_SERVER_UID=1000');
    expect(harness).not.toContain('VERITY_PROJECT_RELAY_IMAGE');
    expect(harness).toContain('failure diagnostics');
    expect(harness).toContain('"$compose" logs --no-color --tail 200');
    expect(harness).toContain('type=bind,src=$host_state_root,dst=/state');
    expect(harness).toContain('find /state -mindepth 1 -delete');
    expect(harness).toContain('isolated_id');
    expect(harness).toContain('host_id');
    expect(harness).toContain('"$isolated_id" != "$host_id"');
    expect(harness).toContain('"$isolated_id" == "$VERITY_CLEAN_INSTALL_DAEMON_ID"');
    expect(harness).toContain('ps --all --quiet');
    expect(harness).toContain('volume ls --quiet');
    expect(harness).toContain('custom_networks');
    expect(harness).toContain('export VERITY_RUNNER_SUPERVISOR=1');
    expect(harness).toContain('export VERITY_POSTGRES_PASSWORD="$(openssl rand -hex 32)"');
    expect(harness).toContain('"$compose" up --detach');
    expect(harness).toContain('wait_for_service verity');
    expect(harness).toContain('ps --all --quiet verity-agent-gateway');
    expect(harness).toContain('Agent Gateway container is not running');
    expect(harness).toContain('ps --all --quiet verity-control-runner');
    expect(harness).toContain('control-plane Runner container is not running');
    expect(harness).toContain('ps --all --quiet verity-agent-seed');
    expect(harness).toContain("'{{.State.Status}}:{{.State.ExitCode}}'");
    expect(harness).toContain('[[ "$seed_status" = exited:0 ]]');
    expect(harness).toContain('/onboarding/status');
    expect(harness).toContain('rejectUnauthorized: false');
    expect(harness).toContain('nextStep: "master-password"');
    expect(harness).toContain('unexpected first-run onboarding state');
    expect(harness).toContain(
      '-Atqc "select count(*) > 0 from information_schema.tables where table_schema = \'public\'"',
    );
    expect(harness).not.toContain('-Atqc +');
    expect(harness).toContain('"$compose" down --volumes --remove-orphans');
  });
});

describe('sandbox smoke isolation', () => {
  const raw = readFileSync('.github/workflows/verity-sandbox.yml', 'utf8');
  const workflow = parse(raw) as {
    jobs: { 'smoke-test': { env?: Record<string, string>; steps: WorkflowStep[] } };
  };
  const job = workflow.jobs['smoke-test'];
  // Everything after `steps:` — the comment above the job explains the failure
  // mode using the old literal names, so it must not count as a usage.
  const steps = raw.slice(raw.indexOf('    steps:'));

  it('namespaces the image, container and host path by run', () => {
    for (const name of [
      'SMOKE_IMAGE',
      'DEVCONTAINER_IMAGE',
      'SMOKE_ENTRYPOINT',
      'SMOKE_GH_CAPABILITY',
    ]) {
      // Both halves matter: run_id alone repeats across a re-run of the same run.
      expect(job.env?.[name]).toContain('${{ github.run_id }}');
      expect(job.env?.[name]).toContain('${{ github.run_attempt }}');
    }
  });

  it('leaves no shared docker name for a concurrent run to delete', () => {
    // The dev-server runners share one Docker daemon, so a fixed tag, container
    // name or host path lets whichever run cleans up first pull the image out
    // from under a run that is still testing against it.
    expect(steps).not.toMatch(/verity-sandbox:smoke(?![-\w])/u);
    expect(steps).not.toMatch(/verity-devcontainer:smoke(?![-\w])/u);
    expect(steps).not.toMatch(/(?<![-\w"$])verity-ep(?![-\w])/u);
    expect(steps).not.toMatch(/\/tmp\/verity-smoke-ghcap(?![-\w])/u);
  });

  it('hands this run’s image to every live smoke script', () => {
    const scripts = job.steps.filter((step) => step.run?.includes('scripts/test-runner-'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const step of scripts) {
      // Without this the script falls back to the shared default and the
      // namespacing above would silently buy nothing.
      expect(step.env?.VERITY_LIVE_SMOKE_IMAGE).toBe('${{ env.SMOKE_IMAGE }}');
    }
  });
});

describe('Claude ACP sandbox smoke', () => {
  const workflow = parse(readFileSync('.github/workflows/verity-sandbox.yml', 'utf8')) as {
    jobs: {
      'smoke-test': {
        steps: WorkflowStep[];
      };
    };
  };
  const source = readFileSync('packages/server/src/runner-claude-live-server.ts', 'utf8');
  const script = readFileSync('scripts/test-runner-claude-live-container.sh', 'utf8');
  const smoke = workflow.jobs['smoke-test'].steps.find((step) =>
    step.run?.includes('test-runner-claude-live-container.sh'),
  );

  it('keeps the hard-restart release gate on ACP with credential-boundary assertions', () => {
    expect(smoke?.name).toBe('Claude ACP Runner survives a hard Server restart');
    expect(source).toContain("runnerSupervisorBackend: 'claude-acp'");
    expect(script).toContain('-e DOPPLER_TOKEN=must-not-cross');
    expect(script).toContain('-e GITHUB_TOKEN=must-not-cross');
    expect(script).toContain('"credentialBoundary":"no-credentials"');
  });

  it('waits for the ACP stream-json prompt before emitting Claude output', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'verity-claude-acp-fixture-'));
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      await writeFile(join(worktree, 'continue'), 'continue');
      child = spawn(
        process.execPath,
        ['scripts/fixtures/fake-claude-live-smoke.mjs', '--input-format', 'stream-json'],
        {
          env: {
            PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
            VERITY_LIVE_SMOKE_WORKTREE: worktree,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      const waitForStdout = async (needle: string) => {
        if (stdout.includes(needle)) return;
        const signal = AbortSignal.timeout(5_000);
        try {
          for await (const chunks of on(child.stdout, 'data', { signal })) {
            void chunks;
            if (stdout.includes(needle)) return;
          }
        } catch (error) {
          if (!signal.aborted) throw error;
          throw new Error(`Timed out waiting for fixture stdout: ${needle}`, { cause: error });
        }
      };
      await waitForStdout('"subtype":"init"');
      expect(stdout).toContain('"apiKeySource":"oauth"');
      await expect(access(join(worktree, 'before'))).rejects.toThrow();
      child.stdin.write(
        `${JSON.stringify({
          type: 'control_request',
          request_id: 'initialize-smoke',
          request: { subtype: 'initialize' },
        })}\n`,
      );
      await waitForStdout('"type":"control_response"');
      expect(stdout).toContain('"response":{"subtype":"success","request_id":"initialize-smoke"');
      expect(stdout).toContain('"models":[{"value":"smoke"');
      await expect(access(join(worktree, 'before'))).rejects.toThrow();
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5_000) });
      child.stdin.end(`${JSON.stringify({ type: 'user', message: 'smoke' })}\n`);
      const [code] = (await exited) as [number | null];
      expect(code, stderr).toBe(0);
      expect(stdout).toContain('"subtype":"success"');
      expect(stdout).toContain('"stop_reason":"end_turn"');
      await expect(access(join(worktree, 'before'))).resolves.toBeUndefined();
    } finally {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      await rm(worktree, { recursive: true, force: true });
    }
  });
});

describe('manual server image smoke', () => {
  const workflow = parse(readFileSync('.github/workflows/verity-server.yml', 'utf8')) as {
    env: Record<string, string>;
    jobs: {
      'smoke-test': {
        steps: WorkflowStep[];
      };
    };
  };
  const smoke = workflow.jobs['smoke-test'].steps.find((step) => step.name === 'Smoke-test image');

  it('starts the relay-only runtime with every mandatory deployment seam', () => {
    expect(workflow.env.VERITY_CI_RELAY_IMAGE).toMatch(
      /^ghcr\.io\/heey-global\/verity\/verity-project-relay@sha256:[a-f0-9]{64}$/,
    );
    expect(smoke?.run).toContain('--group-add 65532');
    expect(smoke?.run).toContain('-e VERITY_DOCKER_BASE_URL=unix:///var/run/docker.sock');
    expect(smoke?.run).toContain('-e VERITY_DATA_VOLUME=verity-data');
    expect(smoke?.run).toContain('-e VERITY_PROJECT_RELAY_IMAGE="$VERITY_CI_RELAY_IMAGE"');
    expect(smoke?.run).toContain(
      '-e VERITY_AGENT_GATEWAY_CONTROL_SOCKET=/tmp/verity-agent-gateway-control.sock',
    );
    expect(smoke?.run).toContain(
      '-e VERITY_AGENT_GATEWAY_UNSEAL_KEY="$VERITY_CI_GATEWAY_UNSEAL_KEY"',
    );
    expect(smoke?.run).toContain('-e VERITY_AGENT_GATEWAY_URL=https://verity-agent-gateway:9443');
    expect(smoke?.run).toContain('-e VERITY_CLAUDE_EGRESS_GATEWAY_URL=https://verity:9443');
    expect(smoke?.run).toContain('-e VERITY_CLAUDE_CONNECTOR_PORT=47821');
  });
});

/**
 * The detector decides which jobs are allowed to skip, and `ci-checks` trusts its
 * verdict — a wrong `false` is a job that never ran and a gate that went green
 * anyway. It is also plain bash inside a YAML string, so nothing type-checks it.
 * Run the real step against a stubbed `git` rather than asserting on its text.
 */
describe('changed-area detector', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
    jobs: { changes: WorkflowJob };
  };
  const detect = workflow.jobs.changes.steps.find((step) => step.id === 'detect');
  const areas = [
    'lint',
    'typecheck',
    'test',
    'installer',
    'mobile',
    'mobile_app',
    'server_image',
    'agent_seed_drift',
  ] as const;

  // The step's own list, not a copy of it: a test that restated these paths would
  // keep passing while the workflow drifted, and the assertions below are only
  // meaningful against whatever the shell actually treats as inert.
  const releaseManaged = (/\n +([^\n(]+)\) ;;\n/.exec(detect?.run ?? '')?.[1] ?? '').split('|');

  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  // Every suite's source with prose removed, read once. A path named in a comment
  // is not a dependency, and two of the tests below would otherwise report the
  // comments explaining them as violations of themselves.
  const suiteSources: [string, string][] = tracked
    .filter((file) => /\.test\.(ts|tsx|mjs|cjs|js)$/.test(file))
    .filter((file) => existsSync(file))
    .map((file) => [
      file,
      readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, ''),
    ]);

  // Bounded on both sides, so `deploy/Dockerfile` is not answered for by
  // `deploy/Dockerfile.bak` and `docs/a.md` not by `docs/a.md.tmpl`.
  const mentions = (code: string, file: string): boolean =>
    new RegExp(`(^|[^\\w./-])${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w./-]|$)`).test(
      code,
    );

  // One argument per file. A single string with `\n` in it does not survive
  // `printf '%s'` under double quotes — bash passes the two characters through and
  // `mapfile` reads the whole list back as one path.
  const list = (files: string[]): string =>
    files.length ? `printf '%s\\n' ${files.map((file) => `'${file}'`).join(' ')}` : 'true';

  /** Runs the real step with `git` answering `changed`, and reads its outputs. */
  const run = async (
    event: { name: string; before?: string; baseRef?: string; baseSha?: string },
    changed: string[],
    options: {
      beforeReachable?: boolean;
      headHasParent?: boolean;
      deleted?: string[];
      added?: string[];
      renamedFrom?: string[];
      baseVerdict?: string | null;
    } = {},
  ): Promise<Record<string, string>> => {
    const {
      beforeReachable = true,
      headHasParent = true,
      deleted = [],
      // Which of `changed` are additions or removals rather than edits. Empty by
      // default, so every case below states an edit unless it says otherwise —
      // the reading that makes the arm table, not the inventory guard, the thing
      // under test.
      added = [],
      // Paths git would report only with rename detection OFF: the source halves of
      // moves whose destinations are in `changed`. Modelled rather than merged into
      // `changed` by the caller, because what needs pinning is that the step asks
      // for them — a diff without `--no-renames` sees the destination alone.
      renamedFrom = [],
      // What the base commit's own CI run reports. `null` is an API that would
      // not answer at all, which is not a verdict and must not be read as one.
      baseVerdict = 'completed/success',
    } = options;
    const kept = changed.filter((file) => !deleted.includes(file));
    const dir = await mkdtemp(join(tmpdir(), 'ci-detect-'));
    try {
      await writeFile(
        join(dir, 'gh'),
        baseVerdict === null
          ? '#!/usr/bin/env bash\necho "gh: api unreachable" >&2\nexit 1\n'
          : `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(baseVerdict)}\n`,
        { mode: 0o755 },
      );
      await writeFile(
        join(dir, 'git'),
        '#!/usr/bin/env bash\n' +
          'case "$1" in\n' +
          `  cat-file) exit ${beforeReachable ? '0' : '1'} ;;\n` +
          // Whatever the step falls back to must still resolve to a commit, or the
          // fallback would look indistinguishable from having no base at all.
          `  rev-parse) ${headHasParent ? "printf '%s\\n' 0000000000000000000000000000000000000001" : 'exit 1'} ;;\n` +
          // `--diff-filter=d` is the same diff without the deletions, which is how
          // the step tells an edit from a removal — `--name-only` alone shows both
          // the same way.
          // `--diff-filter=AD` is the inventory guard's question — which paths
          // appeared or disappeared, as opposed to which were edited. Checked
          // first, though the two patterns cannot both match: `=d` is the filter
          // argument, and `=AD` does not start with one.
          '  diff)\n' +
          '    if [[ "$*" == *--diff-filter=AD* ]]; then\n' +
          `      ${list([...added, ...deleted])}\n` +
          '    elif [[ "$*" == *--diff-filter=d* ]]; then\n' +
          `      ${list(kept)}\n` +
          // The arm table's own diff. Rename detection is git's default, so the
          // source half of a move is visible only when the step asks for it — the
          // stub answers accordingly rather than handing back the same list either
          // way, which is what makes a dropped `--no-renames` a failing test.
          '    elif [[ "$*" == *--no-renames* ]]; then\n' +
          `      ${list([...changed, ...renamedFrom])}\n` +
          '    else\n' +
          `      ${list(changed)}\n` +
          '    fi ;;\n' +
          '  *) exit 0 ;;\n' +
          'esac\n',
        { mode: 0o755 },
      );
      const script = (detect?.run as string)
        .replaceAll('${{ github.event_name }}', event.name)
        .replaceAll('${{ github.event.before }}', event.before ?? '')
        .replaceAll('${{ github.event.pull_request.base.sha }}', event.baseSha ?? '')
        .replaceAll('${{ github.base_ref }}', event.baseRef ?? 'main');
      await writeFile(join(dir, 'detect.sh'), script);

      const output = join(dir, 'github-output');
      await writeFile(output, '');
      execFileSync('bash', [join(dir, 'detect.sh')], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: 'heey-global/verity',
        },
        stdio: 'pipe',
      });
      return Object.fromEntries(
        readFileSync(output, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('=') as [string, string]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const all = (value: 'true' | 'false'): Record<string, string> =>
    Object.fromEntries(areas.map((area) => [area, value]));

  /**
   * Read from the text, unlike everything else here, because the stub cannot see
   * it: `git` is answered by a script that prints paths, so a diff which aborts
   * against the real thing returns a clean list under test. What breaks it is
   * ancestry, and the only place ancestry is decided is the fetch's depth — the
   * step's own comment carries the account of why, and is the copy to keep
   * current.
   */
  it('fetches the pull request base deep enough to have a merge base', () => {
    expect(detect, 'the changes job has no `detect` step to read').toBeDefined();
    // Comments dropped before anything is graded, or the step's own prose about
    // the flag this forbids would read as a use of it — trailing ones too, since
    // a note after a command sits on the command's own line. Stripped BEFORE
    // continuations are folded, not after: a comment ending in `\` would
    // otherwise swallow the command below it and carry it out of the list.
    // Matched on `git … fetch` anywhere in the line rather than a `git fetch`
    // prefix: `if ! git fetch …` and `git -C "$dir" fetch …` are the same
    // invocation and the same hazard.
    const fetches = (detect?.run ?? '')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      // Only where the `#` opens a comment. Truncating at one inside a quoted
      // argument would take a flag off the end of the line with it and let the
      // check below pass on a command it never saw in full, so a `#` with an
      // unclosed quote before it is left alone.
      .map((line) =>
        line.replace(/\s+#.*$/, (comment, offset: number) => {
          const before = line.slice(0, offset);
          const balanced = (quote: string): boolean => (before.split(quote).length - 1) % 2 === 0;
          return balanced("'") && balanced('"') ? '' : comment;
        }),
      )
      .join('\n')
      .replace(/\\\n\s*/g, ' ')
      .split('\n')
      .filter((line) => /\bgit\b[^\n]*\bfetch\b/.test(line));

    expect(fetches, 'the detector no longer fetches the base branch at all').not.toHaveLength(0);
    // Every fetch, not just the base's: shallowness is a property of the
    // repository, so any fetch in this step grafts the history the diff below
    // reads. `--deepen` included — it extends a shallow history, it does not end
    // one, and the boundary is what breaks the merge base.
    for (const command of fetches) {
      expect(
        command,
        'a shallow fetch leaves no ancestry for `...` to find a merge base in',
      ).not.toMatch(/--depth|--deepen|--shallow-since|--shallow-exclude|fetch\.depth/);
    }

    // Depth is only half of it: the diff is against `origin/<base_ref>`, and if
    // nothing fetches that ref it resolves to whatever a previous job left in this
    // checkout.s workspace. Scoped to one fetch rather than
    // asserted of all, so an unrelated fetch added later is not a failure. Either
    // spelling counts — passing the ref through `env:` is the hardening this test
    // should not stand in the way of.
    expect(
      fetches.some((command) => /\$\{\{\s*github\.base_ref\s*\}\}|\$\{?BASE_REF/.test(command)),
      'no fetch in the detector names the base branch',
    ).toBe(true);

    // The premise the whole fix rests on, asserted where it can drift: the fetch
    // above is only free — and only sufficient — because the checkout already
    // brought the base's history down, and because `fetch-depth: 0` is what makes
    // checkout fetch with `--unshallow` and so repair a workspace an older run
    // grafted. Set it back to the default depth of 1 and the fetch cannot.
    //
    // Every checkout in the job, not the first: a second one added later would
    // leave this guarding a step that is no longer the one `detect` reads.
    const checkouts = workflow.jobs.changes.steps.filter((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );

    expect(checkouts, 'the changes job no longer checks anything out').not.toHaveLength(0);
    for (const checkout of checkouts) {
      // Stringified because YAML hands back the number and the step map is typed
      // as strings; `undefined` reads as its own name rather than passing.
      expect(String(checkout.with?.['fetch-depth']), 'the detector checks out a shallow tree').toBe(
        '0',
      );
    }
  });

  /**
   * The native patch runner rewrites an installed dependency against byte-exact
   * anchors, and `mobile-app` is the only job with a full mobile install to check
   * them against. Run rather than pattern-matched: `case` takes the first arm that
   * matches, so an arm added ahead of these can shadow them while a test reading
   * the intended arm's body still passes.
   */
  it('routes the native patch runner and its inputs to the mobile-app job', async () => {
    for (const file of [
      'package-lock.json',
      'apps/mobile/package.json',
      'scripts/patch-mobile-native-deps.mjs',
      'scripts/patch-mobile-native-deps.test.ts',
    ]) {
      const outputs = await run({ name: 'pull_request', baseRef: 'main' }, [file]);
      expect(
        outputs.mobile_app,
        `changing ${file} alone can break the backported native patches, but runs ` +
          'no job that applies them',
      ).toBe('true');
      // And the suite that guards the EAS hook chain, which reads two of these
      // files. First match wins in that `case`, so an arm added ahead of the ones
      // these land in would leave the routing intact and the checking dead.
      expect(
        outputs.test,
        `changing ${file} alone can break the backported native patches, but runs ` +
          'no suite that checks them',
      ).toBe('true');
    }
  }, 30_000);

  it('keeps the patch runner reaching everything the scripts arm reaches', async () => {
    // Its own arm sits ahead of the broad `scripts/*` one, so it has to be a
    // superset: any area it omits is silently dropped for these two files.
    //
    // The baseline is read out of that arm's own body rather than probed with some
    // other script's path, which would only report whatever arm *that* file lands
    // in — the same first-match problem this test exists to catch.
    const broadArm = /\n +[^\n]*\|scripts\/\*\)\n([\s\S]*?);;/.exec(detect?.run ?? '')?.[1];
    const executable = (broadArm ?? '').replace(/^\s*#.*$/gm, '');
    const broad = [...executable.matchAll(/^(\s*)(\w+)=true\s*$/gm)].map(([, , area]) => area);
    expect(
      broad.length,
      'the broad scripts/* arm no longer sets every expected shared area, or extraction broke',
    ).toBeGreaterThan(1);

    for (const file of [
      'scripts/patch-mobile-native-deps.mjs',
      'scripts/patch-mobile-native-deps.test.ts',
    ]) {
      const outputs = await run({ name: 'pull_request', baseRef: 'main' }, [file]);
      for (const area of broad) {
        expect(
          outputs[area],
          `${file} used to run ${area} under scripts/*, and no longer does`,
        ).toBe('true');
      }
    }
  }, 30_000);

  it('reads the release-managed paths out of the step it is testing', () => {
    // Guards the extraction above: an arm that stopped matching would silently
    // turn every release-commit assertion below into a test of an empty list.
    // Deliberately shape-only, naming none of the paths — the scan below reads
    // this file too, and a literal here would be a hit on itself.
    expect(releaseManaged.length).toBeGreaterThan(1);
    for (const path of releaseManaged) expect(path).toMatch(/^[\w.][\w./-]*\.\w+$/);
  });

  /**
   * The safety argument for skipping a release commit is exactly this: nothing any
   * skipped job runs reads those files, so the previous commit's green run still
   * describes this tree. Asserted rather than reasoned about, because the day
   * something starts reading `version.txt` is the day the skip becomes a lie.
   *
   * The skip drops every job, not just the test one, so the scan covers every
   * executable input those jobs have — the suites, the scripts they shell out to,
   * the Dockerfiles the image job builds — and not only `*.test.ts`. The
   * formatter is the one consumer this cannot see, because its input is a glob
   * rather than a path it names; that half is asserted separately below.
   */
  it('skips only files that nothing a skipped job runs reads', () => {
    const testFiles = execFileSync(
      'git',
      [
        'ls-files',
        '*.ts',
        '*.tsx',
        '*.mjs',
        '*.cjs',
        '*.js',
        '*.sh',
        'Dockerfile*',
        '*.Dockerfile',
        'deploy/bin/*',
        'scripts/*',
        // Workflow YAML is scanned by the test below instead, which can tell the
        // jobs the skip drops from the ones it never touches — a distinction this
        // list has no way to draw, and one that matters because ci.yml carries the
        // arm the managed paths were read out of.
        ':!:.github/workflows/*',
      ],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .filter((file) => existsSync(file));

    // Reading a managed path only matters if a skipped job would run the reader.
    // `scripts/update-toolkit-ledger.mjs` reads the manifest to version the toolkit
    // ledger, and only release.yml runs it — the single test that names it asserts
    // that workflow's text and never executes the script. The half of that which
    // can be checked is: if ci.yml ever invokes it, directly or through one of the
    // npm scripts ci.yml runs, the exemption stops applying and this fails.
    const ciText = readFileSync('.github/workflows/ci.yml', 'utf8');
    const npmScripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    ).scripts;
    const ciRuns =
      ciText +
      Object.entries(npmScripts)
        .filter(([name]) => ciText.includes(`npm run ${name}`))
        .map(([, body]) => body)
        .join('\n');
    const exempt = ['scripts/update-toolkit-ledger.mjs'];
    for (const file of exempt) {
      expect(ciRuns, `${file} is exempt only for as long as no CI job runs it`).not.toContain(file);
    }

    for (const file of testFiles) {
      if (exempt.includes(file)) continue;
      const shell = /\.sh$|Dockerfile|^deploy\/bin\//.test(file);
      const code = readFileSync(file, 'utf8')
        // Prose is not a read. Without this, a comment explaining the rule — the
        // one above this test, for a start — reports itself as a violation. `#`
        // only where it starts a comment: in TypeScript it opens a private field.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '')
        .replace(shell ? /^[ \t]*#.*$/gm : /(?!)/g, '');
      for (const managed of releaseManaged) {
        // Delimited, so `version` does not answer for `version.txt`: a quote on
        // both sides, or a `/` on the left for a path built from a root.
        const read = new RegExp(
          `['"\`/]${managed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`,
        ).test(code);
        expect(
          read,
          `${file} reads ${managed}, which the detector treats as inert — either stop ` +
            'reading it there or drop it from the release-managed arm in ci.yml',
        ).toBe(false);
      }
    }
  });

  /**
   * The other half of that scan. A job does not only read the files it runs: a
   * `run:` block is shell in its own right and can read a managed path without a
   * script to carry it, and so can a composite action a job steps into.
   *
   * Which jobs matter is the whole question, and the answer is exactly "the ones
   * the skip drops". `changes` is not one — it is the detector, it carries the
   * allowlist, and it runs on every event including the release commit. Neither
   * is `ci-checks`, which is `if: always()`. Everything else is gated, so
   * everything else is scanned. release.yml and mobile-ota.yml are outside this
   * workflow and the detector does not gate them; they read these files by
   * design, which is what makes them release tooling rather than a violation.
   */
  it('keeps the release-managed paths out of the jobs the skip drops', () => {
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      jobs: Record<string, unknown>;
    };
    // Named rather than derived: a job that stops being unconditional should
    // fail this list loudly instead of quietly scanning one surface less.
    const unconditional = ['changes', 'public-snapshot', 'ci-checks'];
    for (const name of unconditional) {
      expect(Object.keys(ci.jobs), `${name} is no longer a job in ci.yml`).toContain(name);
    }

    const surface: [string, string][] = Object.entries(ci.jobs)
      .filter(([name]) => !unconditional.includes(name))
      .map(([name, job]) => [`ci.yml job ${name}`, JSON.stringify(job)]);
    // Composite actions are the other place a gated job's shell lives.
    for (const action of execFileSync('git', ['ls-files', '.github/actions'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)) {
      surface.push([action, readFileSync(action, 'utf8')]);
    }
    expect(surface.length).toBeGreaterThan(1);

    for (const [where, raw] of surface) {
      const text = raw.replace(/^[ \t]*#.*$/gm, '');
      for (const managed of releaseManaged) {
        // Bounded on both sides so `apps/mobile/version.txt` — a different file,
        // read by the mobile release path on purpose — does not answer for the
        // root one. Quotes are not required here: shell in a `run:` block reads a
        // path bare as often as not.
        const read = new RegExp(
          `(^|[^\\w./-])${managed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w./-]|$)`,
        ).test(text);
        expect(
          read,
          `${where} reads ${managed}, which the detector treats as inert — either stop ` +
            'reading it there or drop it from the release-managed arm in ci.yml',
        ).toBe(false);
      }
    }
  });

  /**
   * The lint job ends in `npm run format`, which is `prettier --check .` — it takes
   * a directory, so no file names it and the scan above cannot see the read. It did
   * check `.release-please-manifest.json` until this landed, which is a release
   * commit's own output: a formatter disagreeing with release-please would have
   * failed a job the skip drops, and the break would surface on the next unrelated
   * pull request instead.
   */
  it('keeps the formatter out of the files the skip treats as inert', () => {
    // Matched with gitignore semantics rather than by looking for the literal
    // path among the entries: `.prettierignore` is patterns, and `**/CHANGELOG.md`
    // and `docs/` each already cover files no line names. Comparing strings would
    // demand a redundant entry per release-managed path — and still not answer the
    // question, which is whether Prettier reads the file.
    //
    // It is the weaker check of the two, deliberately. A bare `version.txt`
    // matches at any depth, so the next package's version file passes here
    // without anyone adding an entry for it. That is the right answer to the
    // question the skip actually asks, and it is not a per-path review.
    const ignored = ignore().add(readFileSync('.prettierignore', 'utf8'));

    for (const managed of releaseManaged) {
      expect(
        ignored.ignores(managed),
        `prettier --check . reads ${managed}, which the detector treats as inert — either ` +
          'add it to .prettierignore or drop it from the release-managed arm in ci.yml',
      ).toBe(true);
    }
  });

  it('skips every job on a release-please commit', async () => {
    expect(await run({ name: 'push', before: 'abc' }, releaseManaged)).toEqual(all('false'));
  });

  it('falls back to HEAD^ when the pushed-from commit is not reachable', async () => {
    // The all-zero sha of a first push, and any `before` that was never fetched.
    expect(
      await run({ name: 'push', before: '0'.repeat(40) }, releaseManaged, {
        beforeReachable: false,
      }),
    ).toEqual(all('false'));
  });

  it('runs everything when there is no base at all, not even a parent', async () => {
    // Nothing to compare against is the one state that says nothing about the
    // tree, so it has to fall through to the unconditional branch.
    expect(
      await run({ name: 'push', before: '' }, releaseManaged, {
        beforeReachable: false,
        headHasParent: false,
      }),
    ).toEqual(all('true'));
  });

  it('runs everything when those paths were deleted rather than written', async () => {
    // `git diff --name-only` reports a removal exactly like an edit, so on paths
    // alone a commit deleting the changelog reads as release-please's output. It
    // is not one, and nothing about the previous green run describes that tree.
    expect(
      await run({ name: 'push', before: 'abc' }, releaseManaged, {
        deleted: [releaseManaged[0] as string],
      }),
    ).toEqual(all('true'));
  });

  /**
   * The one case a stubbed `git` cannot state honestly, so this one drives the
   * real binary over a real repository. Rename detection is on by default and
   * collapses a delete/add pair into the destination alone, so a commit that
   * moves source code onto a release-managed path lists nothing but that path —
   * allowlisted, and with no deletion for the guard above to find. Whether
   * `--no-renames` is on the diffs is the whole difference, and only git can say.
   */
  it('runs everything when source was renamed onto a release-managed path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ci-detect-repo-'));
    try {
      // The global config is cut out rather than overridden: it carries this
      // container's commit signing and hooks path, and neither belongs in a
      // throwaway fixture repository.
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'detector fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'detector fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      };
      const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' });

      git('init', '--quiet', '--initial-branch=main');
      // Identical content on both sides of the move, so git scores the pair R100
      // and the collapse this guards against is certain rather than incidental.
      await writeFile(join(dir, 'source.ts'), 'export const gate = () => true;\n');
      git('add', '.');
      git('commit', '--quiet', '--no-verify', '--message', 'base');
      const before = git('rev-parse', 'HEAD').trim();

      // Git pairs a deletion with an ADDITION, so the destination has to be a
      // release-managed path this commit creates — none of them exist in the
      // fixture, so any will do. Read out of the arm rather than named: the scan
      // above reads this file, and a literal here would be a hit on itself.
      const destination = releaseManaged.find((path) => !path.includes('/'));
      expect(destination, 'no release-managed path this fixture can add at its root').toBeTruthy();
      git('mv', 'source.ts', destination as string);
      git('commit', '--quiet', '--no-verify', '--message', 'move source onto a release path');

      const script = (detect?.run as string)
        .replaceAll('${{ github.event_name }}', 'push')
        .replaceAll('${{ github.event.before }}', before)
        .replaceAll('${{ github.base_ref }}', 'main');
      await writeFile(join(dir, 'detect.sh'), script);
      const output = join(dir, 'github-output');
      await writeFile(output, '');
      // `git` is deliberately the real one here; `gh` is not, and it answers the
      // way that would let the skip through. Without it a regression in the
      // rename guard would abort on the missing binary instead of reporting the
      // verdict this test is about — the same red for the wrong reason.
      await writeFile(join(dir, 'gh'), '#!/usr/bin/env bash\necho completed/success\n', {
        mode: 0o755,
      });
      execFileSync('bash', [join(dir, 'detect.sh')], {
        cwd: dir,
        env: {
          ...env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: 'heey-global/verity',
        },
        stdio: 'pipe',
      });

      expect(
        Object.fromEntries(
          readFileSync(output, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => line.split('=') as [string, string]),
        ),
      ).toEqual(all('true'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The skip does not test the tree, it inherits the base's verdict — so there
   * has to be one, and it has to be green. A base still running has reported
   * nothing yet, which is precisely the state back-to-back merges leave it in;
   * a red base reported a break this tree still carries. Either one inherited
   * would put a green check on a commit that no job looked at.
   */
  it.each([
    ['is still running', 'in_progress/none'],
    ['queued behind another merge', 'queued/none'],
    ['went red', 'completed/failure'],
    ['was cancelled', 'completed/cancelled'],
    ['never ran at all', 'missing/none'],
  ])('runs everything when the base CI run %s', async (_, verdict) => {
    expect(
      await run({ name: 'push', before: 'abc' }, releaseManaged, { baseVerdict: verdict }),
    ).toEqual(all('true'));
  });

  it('runs everything when the base verdict cannot be read', async () => {
    // An outage is not a verdict. Reading an unanswered query as success would
    // make the one failure mode of this check a false green.
    expect(
      await run({ name: 'push', before: 'abc' }, releaseManaged, { baseVerdict: null }),
    ).toEqual(all('true'));
  });

  it('runs everything when a release commit carries anything else', async () => {
    expect(
      await run({ name: 'push', before: 'abc' }, [...releaseManaged, 'packages/server/src/app.ts']),
    ).toEqual(all('true'));
  });

  // Not the pull request path filter: see the note in the step. A pull request
  // diff cannot see what only the merged tree shows, so main stays unconditional.
  it('runs everything on an ordinary push to main', async () => {
    expect(await run({ name: 'push', before: 'abc' }, ['docs/adr/0008-self-update.md'])).toEqual(
      all('true'),
    );
  });

  it('runs everything when the diff is empty, rather than reading it as inert', async () => {
    expect(await run({ name: 'push', before: 'abc' }, [])).toEqual(all('true'));
  });

  it('runs everything on a manual dispatch, which has no base to diff against', async () => {
    expect(await run({ name: 'workflow_dispatch' }, [])).toEqual(all('true'));
  });

  it('still gates a pull request on the changed paths', async () => {
    expect(
      await run({ name: 'pull_request', baseRef: 'main' }, ['packages/server/src/app.ts']),
    ).toEqual({
      ...all('false'),
      lint: 'true',
      typecheck: 'true',
      test: 'true',
      server_image: 'true',
    });
  });

  it('skips every job on a release-please pull request', async () => {
    // This used to be a post-merge shortcut only, on the argument that the
    // allowlist, the two diff guards and the base's verdict did not exist on a
    // pull request. They do now — the detector runs the same three against
    // `pull_request.base.sha`, which is a commit on main with a verdict of its
    // own. What changes is only WHEN the same reasoning is applied: one step
    // earlier, on the PR release-please opens, instead of paying a full Server
    // image build and the Docker chain on the shared dev-server to test a version
    // bump and then skipping the identical commit minutes later.
    expect(
      await run({ name: 'pull_request', baseRef: 'main', baseSha: 'abc' }, releaseManaged),
    ).toEqual(all('false'));
  });

  it('runs everything on a pull request whose base has no green verdict', async () => {
    // The inheritance is the whole mechanism here too: without a completed success
    // to inherit there is nothing to stand on, and the skip must not invent one.
    expect(
      await run({ name: 'pull_request', baseRef: 'main', baseSha: 'abc' }, releaseManaged, {
        baseVerdict: 'completed/failure',
      }),
      // Not everything: without a verdict to inherit the files stop being inert and
      // fall through the ordinary path table, exactly as they did before the skip
      // reached pull requests.
    ).toEqual({ ...all('false'), lint: 'true', typecheck: 'true', test: 'true' });
  });

  it('still runs everything when a pull request touches source beside those paths', async () => {
    expect(
      await run({ name: 'pull_request', baseRef: 'main', baseSha: 'abc' }, [
        ...releaseManaged,
        'packages/server/src/app.ts',
      ]),
    ).toEqual({
      ...all('false'),
      lint: 'true',
      typecheck: 'true',
      test: 'true',
      server_image: 'true',
    });
  });

  /**
   * The table used to fail open: a path no arm named matched nothing, so nothing
   * ran, and the pull request reported green on a suite that never started.
   *
   * Not a hypothetical. Measured against the arms as they were, 43 tracked files
   * that test sources name reached no `test` job — 25 because no arm matched them
   * at all (`deploy/docker-compose.yml`, four of the five workflow YAMLs this very
   * file parses, `deploy/gvisor/versions.env`, `renovate.json`), and 18 because
   * the arm that matched ran only the image build (`.dockerignore`,
   * `deploy/Dockerfile`, the toolkit's published hashes, `agent-seed/bin/git`).
   * The net at the bottom of this block is what keeps that from coming back.
   */
  it('routes the public Compose surface through its clean-install image gate', async () => {
    expect(
      await run({ name: 'pull_request', baseRef: 'main' }, ['deploy/docker-compose.yml']),
    ).toEqual({
      ...all('false'),
      lint: 'true',
      test: 'true',
      server_image: 'true',
    });
    expect(
      await run({ name: 'pull_request', baseRef: 'main' }, [
        'deploy/bin/verity-clean-install-smoke',
      ]),
    ).toEqual({
      ...all('false'),
      lint: 'true',
      test: 'true',
      server_image: 'true',
    });
  });

  // The narrow jobs stay narrow. A catch-all that also turned these on would put
  // a twelve-minute Docker matrix behind a one-line README fix, and each of them
  // covers a set of inputs that genuinely is bounded by path.
  it('leaves the expensive jobs to the arms that name them', async () => {
    const outputs = await run({ name: 'pull_request', baseRef: 'main' }, ['renovate.json']);
    for (const area of ['installer', 'mobile', 'mobile_app', 'server_image', 'agent_seed_drift']) {
      expect(outputs[area], `${area} should not be reachable through the catch-all`).toBe('false');
    }
  });

  it('runs nothing for documentation', async () => {
    expect(
      await run({ name: 'pull_request', baseRef: 'main' }, ['docs/adr/0000-not-a-real-adr.md']),
    ).toEqual(all('false'));
  });

  /** Editing documentation runs nothing, but changing the tracked tree shape runs the suite. */
  it('runs the test job when a path appears or disappears under an inert arm', async () => {
    const doc = 'docs/adr/0000-not-a-real-adr.md';
    const event = { name: 'pull_request', baseRef: 'main' };
    // Only `test`: routing and coverage assertions need the new tree shape, while
    // the expensive jobs still read nothing this document can change.
    expect(await run(event, [doc], { added: [doc] })).toEqual({ ...all('false'), test: 'true' });
    expect(await run(event, [doc], { deleted: [doc] })).toEqual({ ...all('false'), test: 'true' });
    // The case `--no-renames` is on the diff for. With rename detection the move
    // would report the destination alone; the source leaving is the half that makes
    // the inventory stale, and both halves land under the arm that runs nothing.
    const moved = 'docs/adr/0000-moved.md';
    expect(await run(event, [doc, moved], { deleted: [doc], added: [moved] })).toEqual({
      ...all('false'),
      test: 'true',
    });
  });

  /**
   * A move is two facts, and rename detection reports one of them. Git's default
   * collapses `packages/server/src/x.ts` → `docs/x.md` to the destination alone, so
   * the arm table would read a server source file leaving the tree as a
   * documentation edit and never run the job that covers it. Asserted on
   * `server_image` rather than `test`, because the inventory guard sets `test` for
   * any appearance or disappearance — only a job the guard cannot reach proves the
   * source half arrived at the arms.
   */
  it('runs the source arm when a file is renamed out of it', async () => {
    const outputs = await run({ name: 'pull_request', baseRef: 'main' }, ['docs/x.md'], {
      deleted: ['packages/server/src/x.ts'],
      added: ['docs/x.md'],
      renamedFrom: ['packages/server/src/x.ts'],
    });
    expect(outputs.server_image).toBe('true');
    expect(outputs.test).toBe('true');
  });

  /**
   * The per-file net above already covers `app.config.ts`, but only as one entry in a
   * list it derives — a reordering that let an earlier arm answer for `apps/mobile/*`
   * would keep that green while this arm went dead. Pinned as exact outputs, on an
   * EDIT, so it is the arm being measured rather than the inventory guard.
   *
   * The second half is the reason the arm names one file instead of the directory:
   * an ordinary mobile source edit must NOT pull in the whole suite. Satisfying the
   * mention rule with `apps/mobile/*` would pass the first expectation and fail this
   * one, which is exactly the trade being pinned.
   */
  it('runs the mobile jobs and the suite for open client source', async () => {
    expect(
      await run({ name: 'pull_request', baseRef: 'main' }, ['apps/mobile/app.config.ts']),
    ).toEqual({
      ...all('false'),
      lint: 'true',
      typecheck: 'true',
      test: 'true',
      mobile_app: 'true',
    });
    // Deliberately a path the repository does not track. The net below requires
    // every TRACKED file a suite names to reach the test job, so naming a real
    // screen here would demand the very `test=true` this case exists to deny.
    expect(
      await run({ name: 'pull_request', baseRef: 'main' }, [
        'apps/mobile/app/untracked-screen.tsx',
      ]),
    ).toEqual({
      ...all('false'),
      lint: 'true',
      typecheck: 'true',
      mobile_app: 'true',
    });
  });

  /**
   * The one arm that still deliberately runs nothing, so the one that has to be
   * proven rather than argued. Every other unnamed path now reaches the catch-all;
   * a file under this one reaches nothing, which is only sound while nothing any
   * job runs reads it.
   *
   * Any mention counts, not just a read call. After comments are stripped, a
   * documentation path appearing in executable test code is close enough to a
   * dependency to be worth failing on, and narrowing the arm is cheap.
   */
  it('keeps the documentation arm free of anything the suite touches', () => {
    // Two lines, unlike the release allowlist above: `docs/*)` then a bare `;;`.
    const inert = (/\n +([^\n(]*docs[^\n(]*)\)\n +;;\n/.exec(detect?.run ?? '')?.[1] ?? '').split(
      '|',
    );
    expect(inert, 'the inert arm is no longer where this test looks for it').toContain('docs/*');

    // The arm's other premise. `lint` runs the formatter over a glob rather than
    // over paths it names, so no scan of the suites can see that consumer — the
    // only thing keeping it away from this directory is `.prettierignore`, and
    // dropping the entry there would make the arm skip a check that now applies.
    const ignored = readFileSync('.prettierignore', 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    for (const pattern of inert) {
      expect(
        ignored.some((line) => pattern.startsWith(line)),
        `${pattern} runs no jobs, but .prettierignore no longer excludes it from the formatter`,
      ).toBe(true);
    }

    // Executable website assets live below docs for static hosting and have an
    // explicit active arm before the inert prose fallback.
    const activeDocumentation = [
      'docs/website/Dockerfile',
      'docs/website/nginx.conf',
      'docs/website/site/install.sh',
    ];
    const documentation = tracked.filter(
      (file) =>
        !activeDocumentation.includes(file) &&
        inert.some((pattern) =>
          new RegExp(
            `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
          ).test(file),
        ),
    );
    expect(documentation.length).toBeGreaterThan(10);

    for (const [suite, code] of suiteSources) {
      for (const file of documentation) {
        expect(
          mentions(code, file),
          `${suite} names ${file}, which the table treats as inert — either stop ` +
            'reading it there, or narrow the documentation arm in ci.yml',
        ).toBe(false);
      }
    }
  });

  /**
   * The net. Every tracked file that any suite names has to reach the `test` job,
   * whichever arm it lands in — that is the property the holes above violated, and
   * asserting it per file is what makes a new hole a failing test instead of a
   * quiet green.
   *
   * Deliberately loose on what counts as "names": a bare mention in non-comment
   * code, not a proven read. A fixture path that only gets written costs one job
   * on one pull request; a genuine read that no job runs costs a false green.
   */
  it('runs the test job for every tracked file a suite names', async () => {
    const named = tracked.filter(
      (file) =>
        !suiteSources.some(([suite]) => suite === file) &&
        suiteSources.some(([, code]) => mentions(code, file)),
    );
    // A rewrite that broke the extraction would otherwise pass on an empty list.
    expect(named.length).toBeGreaterThan(20);

    for (const file of named) {
      const outputs = await run({ name: 'pull_request', baseRef: 'main' }, [file]);
      expect(
        outputs.test,
        `a suite reads ${file}, but changing it alone runs no tests — give its arm ` +
          '`test=true` in ci.yml, or stop reading it',
      ).toBe('true');
    }
  }, 120_000);
});
