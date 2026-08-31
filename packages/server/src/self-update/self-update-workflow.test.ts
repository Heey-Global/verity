import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');

describe('self-update workflow image', () => {
  /**
   * The named step's `run:` block, dedented so `bash` can execute it as written.
   *
   * Located by name and then by the `run: |` that follows it, rather than by one
   * regex over both, because the keys in between are not fixed: a step may carry
   * `shell:`, `env:` with entries under it, or a comment, and a pattern that
   * enumerates them silently stops matching when one is added — which reads as
   * "the step vanished" rather than "the test is stale".
   *
   * The search is bounded at the NEXT step, which is the half that matters. An
   * unbounded one does not fail when the named step loses its `run:` block — it
   * quietly returns some later step's script and runs that instead, so every
   * assertion below would be exercising the wrong shell while still reading as a
   * test of this one.
   */
  const step = async (name: string): Promise<string> => {
    const workflow = await readFile(resolve(root, '.github/workflows/self-update.yml'), 'utf8');
    const start = workflow.indexOf(`      - name: ${name}\n`);
    expect(
      start,
      `could not find the ${JSON.stringify(name)} step in self-update.yml`,
    ).toBeGreaterThan(-1);
    const body = workflow.slice(start + `      - name: ${name}\n`.length);
    const scoped = body.slice(0, /^ {6}- (?:name|uses):/m.exec(body)?.index ?? body.length);
    const run = / {8}run: \|\n([\s\S]*?)(?=\n {6}[-#\w]|$)/.exec(scoped)?.[1];
    expect(
      run,
      `the ${JSON.stringify(name)} step has no literal run: block of its own`,
    ).toBeTruthy();
    return (run as string).replace(/^ {10}/gm, '');
  };

  /**
   * Runs a dedented step with `dir` first on PATH, as its working directory, and
   * as `$RUNNER_TEMP`.
   *
   * The working directory matters as much as the PATH now: the step reads
   * `version.txt` from the checkout, and running it in the repository root would
   * make every assertion below depend on whichever release this branch happens to
   * sit on.
   */
  const runIn = async (
    dir: string,
    script: string,
    env: Record<string, string> = {},
  ): Promise<{ code: number; out: string }> => {
    await writeFile(join(dir, 'step.sh'), script);
    return await new Promise((done) => {
      execFile(
        'bash',
        [join(dir, 'step.sh')],
        {
          cwd: dir,
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH ?? ''}`,
            RUNNER_TEMP: dir,
            // The runner's own hand-off file, which a step that exports something
            // for a later one appends to. Unset, `>>"$GITHUB_ENV"` fails the step
            // under `set -u` — on the variable rather than on anything the test is
            // asking about.
            GITHUB_ENV: join(dir, 'github-env'),
            VERITY_SMOKE_PREVIOUS_IMAGE: 'verity-server:previous',
            GITHUB_ACTOR: 'github-actions',
            VERITY_GHCR_TOKEN: 'stub-workflow-token',
            ...env,
          },
        },
        (error, stdout, stderr) =>
          done({
            code: error === null ? 0 : ((error as { code?: number }).code ?? 1),
            out: `${stdout}${stderr}`,
          }),
      );
    });
  };

  it('keeps the expensive live cutover off pull requests and ordinary pushes', async () => {
    const workflow = await readFile(resolve(root, '.github/workflows/self-update.yml'), 'utf8');
    const triggers = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('\npermissions:'));

    expect(triggers).toContain('workflow_call:');
    expect(triggers).toContain('workflow_dispatch:');
    expect(triggers).not.toContain('push:');
    expect(triggers).not.toContain('pull_request:');
  });

  /**
   * The export above is only worth having if it reaches the script. Asserted as
   * an ordered argument list rather than as "the name appears somewhere": the
   * smoke reads these positionally, and a tag passed in the image's place would
   * seal the deployment from a Compose file it then compares against itself.
   */
  it('hands the smoke the previous release as both an image and a tag', async () => {
    const workflow = await readFile(resolve(root, '.github/workflows/self-update.yml'), 'utf8');
    const start = workflow.indexOf('      - name: Run the live self-update smoke\n');
    expect(start).toBeGreaterThan(-1);
    const invocation = workflow.slice(start);

    expect(
      invocation.slice(0, /^ {6}- (?:name|uses):/m.exec(invocation.slice(1))?.index ?? undefined),
    ).toContain(
      'deploy/bin/verity-self-update-live-smoke \\\n' +
        '            "$VERITY_SMOKE_IMAGE" \\\n' +
        '            "$VERITY_SMOKE_PREVIOUS_IMAGE" \\\n' +
        '            "$VERITY_SMOKE_PREVIOUS_TAG"',
    );
  });

  it('bakes a valid released version into the live-smoke Server image', async () => {
    const workflow = await readFile(resolve(root, '.github/workflows/self-update.yml'), 'utf8');
    const smoke = await readFile(resolve(root, 'deploy/bin/verity-self-update-live-smoke'), 'utf8');
    const version = /^ {6}VERITY_SMOKE_SERVER_VERSION: (\S+)$/m.exec(workflow)?.[1];

    expect(version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    expect(workflow).toContain('--build-arg "VERITY_SERVER_VERSION=$VERITY_SMOKE_SERVER_VERSION"');
    expect(smoke).toContain(
      'createAgentSeedProvenanceClient(\n' +
        '       process.env.VERITY_SMOKE_SERVER_VERSION,\n' +
        '       process.env.VERITY_SMOKE_SERVER_IMAGE,',
    );
    expect(smoke).toContain(
      'expect_agent_seed "$server" "$VERITY_SMOKE_SERVER_VERSION" "$target_digest" \\\n' +
        '  "matched $VERITY_SMOKE_SERVER_VERSION $target_digest"',
    );
  });

  it('supplies the complete production bootstrap inputs during restart re-adoption', async () => {
    const smoke = await readFile(
      resolve(root, 'packages/server/src/self-update-live-smoke.ts'),
      'utf8',
    );
    const start = smoke.indexOf('  const bootstrapEnvironment = {');
    const end = smoke.indexOf('\n  };', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const environment = smoke.slice(start, end);
    expect(environment).toContain("required('VERITY_SMOKE_DATABASE_URL')");
    expect(environment).toContain('VERITY_MANAGED_ROOT: managedRoot');
    expect(environment).toContain("required('VERITY_SMOKE_DOCKER_SOCKET')");
    expect(environment).toContain("VERITY_PAIRING_STATE_HOST_PATH: '/etc/verity'");
  });

  // The newest tag is not the newest published image, and this step needs the
  // latter. Neither `git describe` nor a walk over `git tag` can express that
  // difference — git has no idea which of its tags reached a registry — so
  // neither comes back as a "simplification" of the resolution the tests below
  // exercise. `git tag --merged HEAD^ --sort=-version:refname` is named because
  // it is the exact spelling that blocked the 13.2.14 release.
  it('does not pick the previous image from the local tag set', async () => {
    // Comments stripped, because the step explains at length what it stopped
    // doing and naming the old command there is the point.
    const executed = (await step('Fetch the previously released Server image'))
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    expect(executed).not.toContain('git describe');
    expect(executed).not.toContain('git tag');
    expect(executed).toContain('/tags/list');
  });

  /**
   * This step gates every backend publish: `release.yml`'s `self-update-gate`
   * waits on this workflow's verdict, and `publish-server` hangs off that gate.
   * A release whose predecessor has no published image therefore cannot publish
   * one either, which makes the NEXT release's predecessor unpublished as well —
   * v13.1.1 and v13.1.2 both went out imageless that way.
   *
   * The step that broke was one `docker pull` of one `git describe` result: valid
   * shell, so asserting on the text of its replacement would not have caught it
   * and would not catch the next one. Run the step instead, with `git` and
   * `docker` stubbed, so the selection and the fail-closed edges are exercised
   * rather than spelled out twice.
   */
  describe('selecting the previous Server image', () => {
    /** What ghcr.io answered for `…/verity-server:v13.2.13` on 2026-08-16. */
    const CONTAINERD_ABSENT =
      'Error response from daemon: failed to resolve reference ' +
      '"ghcr.io/heey-global/verity/verity-server:v13.2.13": not found';

    /**
     * Runs the step against a stubbed ghcr.io that publishes `catalogue`, a
     * stubbed `docker`, and a `git` that answers the two blob reads the step makes
     * and refuses everything else — so any reach for the local ref set shows up as
     * a failure rather than as an answer.
     *
     * `underTest` is what the commit under test records as its version and
     * `parentVersion` is what its parent recorded, so the two together decide
     * whether that version is a release this commit is creating or one it is
     * merely sitting on.
     */
    const runStep = async (
      catalogue: string[],
      options: {
        underTest?: string;
        parentVersion?: string | null;
        pages?: unknown[];
        indent?: number;
        tokenBody?: string;
        tokenFails?: boolean;
        catalogueFails?: boolean;
        catalogueMissing?: boolean;
        bootstrapVersion?: string;
        pullFails?: { tag: string; error: string };
      } = {},
    ): Promise<{
      code: number;
      out: string;
      docker: string[];
      git: string[];
      exported: string[];
    }> => {
      const {
        underTest = '13.2.14',
        parentVersion = null,
        pages = [catalogue],
        indent = 0,
        tokenBody = '{"token":"stub-registry-token"}',
      } = options;
      const dir = await mkdtemp(join(tmpdir(), 'self-update-step-'));
      const dockerCalls = join(dir, 'docker-calls');
      const gitCalls = join(dir, 'git-calls');
      try {
        await writeFile(
          join(dir, 'git'),
          `#!/usr/bin/env bash\n` +
            `printf '%s\\n' "$*" >>${JSON.stringify(gitCalls)}\n` +
            `if [[ "$1" == show && "$2" != *'^:'* ]]; then\n` +
            `  printf '%s\\n' "$STUB_VERSION"\n` +
            `  exit 0\n` +
            `fi\n` +
            `if [[ "$1" == show && -n "\${STUB_PARENT_VERSION:-}" ]]; then\n` +
            `  printf '%s\\n' "$STUB_PARENT_VERSION"\n` +
            `  exit 0\n` +
            `fi\n` +
            // A parent blob that is not there, or anything at all about the local
            // ref set — which this step must not consult.
            `exit 128\n`,
          { mode: 0o755 },
        );
        await writeFile(
          join(dir, 'docker'),
          `#!/usr/bin/env bash\n` +
            `printf '%s\\n' "$*" >>${JSON.stringify(dockerCalls)}\n` +
            `if [[ "$1" == pull ]]; then\n` +
            `  tag="\${2##*:}"\n` +
            `  if [[ -n "\${STUB_PULL_FAILS:-}" && "$tag" == "$STUB_PULL_FAILS" ]]; then\n` +
            `    printf '%s\\n' "$STUB_PULL_ERROR" >&2\n` +
            `    exit 1\n` +
            `  fi\n` +
            `  echo "Downloaded $2"\n` +
            `  exit 0\n` +
            `fi\n` +
            `if [[ "$1" == save ]]; then : > "$3"; fi\n` +
            `exit 0\n`,
          { mode: 0o755 },
        );
        // Reads the URL and honours `--output` and `--dump-header`, because the
        // step's paging, its parsing and its fail-closed edges are all decided
        // from those three.
        //
        // `indent` is what makes the "is this a parser or a pattern" question
        // testable: `JSON.stringify(x, null, 2)` is the SAME response as the
        // compact form, and a step that only recognises one of them is one
        // registry-side formatting change away from blocking a release.
        //
        // Bodies are served from fixture FILES rather than inlined into the stub:
        // a pretty-printed one contains newlines, and a shell string is not a way
        // to carry those. Serving the bytes verbatim is also the only way this
        // proves anything about a parser.
        await writeFile(join(dir, 'token.json'), tokenBody);
        await Promise.all(
          pages.map(async (tags, index) =>
            writeFile(
              join(dir, `page-${index}.json`),
              JSON.stringify({ name: 'heey-global/verity/verity-server', tags }, null, indent),
            ),
          ),
        );
        await writeFile(
          join(dir, 'curl'),
          `#!/usr/bin/env bash\n` +
            `set -u\n` +
            `url="\${!#}"\n` +
            `headers=''\n` +
            `output='/dev/stdout'\n` +
            `prev=''\n` +
            `for arg in "$@"; do\n` +
            `  [[ "$prev" == '--dump-header' ]] && headers="$arg"\n` +
            `  [[ "$prev" == '--output' ]] && output="$arg"\n` +
            `  prev="$arg"\n` +
            `done\n` +
            `if [[ "$url" == *'/token?'* ]]; then\n` +
            `  if [[ -n "\${STUB_TOKEN_FAILS:-}" ]]; then\n` +
            `    echo 'curl: (22) The requested URL returned error: 401' >&2\n` +
            `    exit 22\n` +
            `  fi\n` +
            `  cat ${JSON.stringify(join(dir, 'token.json'))} >"$output"\n` +
            `  exit 0\n` +
            `fi\n` +
            `if [[ -n "\${STUB_CATALOGUE_FAILS:-}" ]]; then\n` +
            `  printf 'HTTP/2 401\\r\\n\\r\\n' >"$headers"\n` +
            `  printf '{"errors":[{"code":"UNAUTHORIZED"}]}' >"$output"\n` +
            `  exit 0\n` +
            `fi\n` +
            `if [[ -n "\${STUB_CATALOGUE_MISSING:-}" ]]; then\n` +
            `  printf 'HTTP/2 404\\r\\n\\r\\n' >"$headers"\n` +
            `  printf '{"errors":[{"code":"NAME_UNKNOWN"}]}' >"$output"\n` +
            `  exit 0\n` +
            `fi\n` +
            pages
              .map((_tags, index) => {
                const marker = index === 0 ? "''" : `'page=${index}'`;
                const last = index === pages.length - 1;
                const link = last
                  ? ''
                  : `link: </v2/heey-global/verity/verity-server/tags/list?n=1000&page=${index + 1}>; rel="next"`;
                return (
                  `if [[ "$url" == *${marker}* ]]; then\n` +
                  `  [[ -n "$headers" ]] && printf 'HTTP/2 200\\r\\n${link}\\r\\n\\r\\n' >"$headers"\n` +
                  `  cat ${JSON.stringify(join(dir, `page-${index}.json`))} >"$output"\n` +
                  `  exit 0\n` +
                  `fi\n`
                );
              })
              // Later pages are matched first; page 0's marker matches every URL.
              .reverse()
              .join(''),
          { mode: 0o755 },
        );

        const result = await runIn(dir, await step('Fetch the previously released Server image'), {
          STUB_VERSION: underTest,
          ...(parentVersion === null ? {} : { STUB_PARENT_VERSION: parentVersion }),
          ...(options.tokenFails === true ? { STUB_TOKEN_FAILS: '1' } : {}),
          ...(options.catalogueFails === true ? { STUB_CATALOGUE_FAILS: '1' } : {}),
          ...(options.catalogueMissing === true ? { STUB_CATALOGUE_MISSING: '1' } : {}),
          VERITY_BOOTSTRAP_VERSION: options.bootstrapVersion ?? '',
          ...(options.pullFails === undefined
            ? {}
            : { STUB_PULL_FAILS: options.pullFails.tag, STUB_PULL_ERROR: options.pullFails.error }),
        });
        const read = async (file: string): Promise<string[]> =>
          (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);
        return {
          ...result,
          docker: await read(dockerCalls),
          git: await read(gitCalls),
          exported: await read(join(dir, 'github-env')),
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };

    /**
     * The 13.2.14 outage, in one case.
     *
     * v13.2.13 was tagged by release-please at d45ba8b9 and its release run then
     * failed, so `ghcr.io/…/verity-server:v13.2.13` has never existed — while the
     * git tag is real, is merged into `HEAD^`, and sorts first. The step must
     * therefore choose v13.2.12, and it must do so without the local tag set
     * having any say in it: git is asked exactly one question here, and it is
     * about a file's contents.
     */
    it('ignores a release that was tagged but never published', async () => {
      const { code, out, git } = await runStep(['v13.2.10', 'v13.2.11', 'v13.2.12'], {
        underTest: '13.2.14',
        parentVersion: '13.2.13',
      });

      expect(code, out).toBe(0);
      expect(out).toContain('Testing candidate against v13.2.12');
      // Two blob reads and nothing else. `git tag`, `git describe` and `git
      // rev-list` are all one line away and all read the state this bug lived in.
      expect(git).toEqual(['show HEAD:version.txt', 'show HEAD^:version.txt']);
    });

    /**
     * The half of "the previous release" the image cannot carry.
     *
     * What a host seals its deployment spec from is that release's
     * `deploy/docker-compose.yml`, not its Server image — so the smoke's drift
     * stage needs the TAG to read it back, and this step is the only place that
     * knows which tag was chosen. Two production outages shipped through the gap
     * this closes, so the export is asserted on the resolved value rather than on
     * the presence of the line: an export of the wrong tag compares a release
     * against itself and passes everything.
     */
    it('exports the resolved tag, not only the image it pulled', async () => {
      const { code, out, exported } = await runStep(['v13.2.10', 'v13.2.11', 'v13.2.12'], {
        underTest: '13.2.14',
        parentVersion: '13.2.13',
      });

      expect(code, out).toBe(0);
      expect(exported).toContain('VERITY_SMOKE_PREVIOUS_TAG=v13.2.12');
    });

    /**
     * The one that turns "widen the regex" into a worse bug than the one it fixes.
     *
     * On a containerd-image-store daemon the sentence below is what an absent tag,
     * an absent repository AND a repository the credentials cannot see all produce
     * — so a skip keyed on it would read an expired ghcr login as "nothing is
     * published", walk down to some arbitrarily old release and pass the gate.
     * The catalogue has already said this tag exists, so the only correct reading
     * of a failed pull is that something is wrong.
     */
    it('aborts on the containerd wording instead of skipping a published release', async () => {
      const { code, out } = await runStep(['v13.2.11', 'v13.2.12'], {
        underTest: '13.2.14',
        parentVersion: '13.2.13',
        pullFails: { tag: 'v13.2.12', error: CONTAINERD_ABSENT },
      });

      expect(code).toBe(1);
      expect(out).toContain('failed to resolve reference');
      expect(out).not.toContain('Testing candidate against');
    });

    // A registry that refuses to answer is not a registry that answered "no": an
    // outage that reads as an absence would silently retarget the cutover at some
    // arbitrarily old release, or at nothing.
    it.each([
      ['refuses to issue a pull token', { tokenFails: true }],
      ['refuses the tag catalogue', { catalogueFails: true }],
    ])('fails closed when ghcr.io %s', async (_, failure) => {
      const { code, out } = await runStep(['v13.2.11', 'v13.2.12'], {
        underTest: '13.2.14',
        parentVersion: '13.2.13',
        ...failure,
      });

      expect(code).not.toBe(0);
      expect(out).toContain(
        'tokenFails' in failure && failure.tokenFails === true
          ? 'The requested URL returned error: 401'
          : 'tag catalogue returned HTTP 401',
      );
      // And it has to fail AS a refusal. "Nothing is published" is the reading an
      // unchecked HTTP call degrades into — an empty body parses to an empty
      // catalogue perfectly happily — and it is a lie about the registry that
      // sends whoever reads it looking for a missing release rather than a broken
      // credential. Non-zero is not enough here; the reason has to survive.
      expect(out).not.toContain('publishes no Server image');
      expect(out).not.toContain('Testing candidate against');
    });

    it('bootstraps only when the authenticated registry says the package does not exist', async () => {
      const { code, out, docker, exported } = await runStep([], {
        underTest: '16.4.0',
        parentVersion: '16.3.1',
        catalogueMissing: true,
        bootstrapVersion: '16.4.0',
      });

      expect(code, out).toBe(0);
      expect(out).toContain('testing v16.4.0 as the first-release bootstrap');
      expect(exported).toContain('VERITY_SMOKE_BOOTSTRAP=true');
      expect(exported).toContain('VERITY_SMOKE_PREVIOUS_TAG=v16.4.0');
      expect(docker).toEqual([]);
    });

    it('rejects a missing package without exact one-time bootstrap authorization', async () => {
      for (const bootstrapVersion of ['', '16.3.1', '16.4.1']) {
        const { code, out, exported } = await runStep([], {
          underTest: '16.4.0',
          parentVersion: '16.3.1',
          catalogueMissing: true,
          bootstrapVersion,
        });

        expect(code).toBe(1);
        expect(out).toContain('has no explicit bootstrap authorization');
        expect(exported).not.toContain('VERITY_SMOKE_BOOTSTRAP=true');
      }
    });

    // Same reasoning one level in: a 200 that carries no token is not a token.
    it.each([
      ['an errors array', '{"errors":[{"code":"UNAUTHORIZED"}]}'],
      ['an empty token', '{"token":""}'],
      ['a token that is not a string', '{"token":null}'],
      ['a body that is not JSON at all', '<html>502 Bad Gateway</html>'],
    ])('fails closed when the token call answers with %s', async (_, tokenBody) => {
      const { code, out } = await runStep(['v13.2.12'], {
        underTest: '13.2.14',
        parentVersion: '13.2.13',
        tokenBody,
      });

      expect(code).toBe(1);
      expect(out).toContain('issued no usable pull token');
      expect(out).not.toContain('Testing candidate against');
    });

    /**
     * Both bodies are read by a JSON parser, not by a pattern, and this is the
     * case that tells the two apart.
     *
     * `{ "token": "…" }` and `{"token":"…"}` are the same response — whitespace is
     * not a wire format, and neither is field order. A step that recognises a
     * token by the literal `"token":"` reads the formatted one as "there is no
     * token" and blocks the release, on a night when nothing about the registry's
     * API changed. Same for the catalogue: a pretty-printed `tags` array is still
     * the tag list.
     */
    it('reads a pretty-printed registry response the same as a compact one', async () => {
      const { code, out } = await runStep(['v13.2.11', 'v13.2.12'], {
        underTest: '13.2.14',
        parentVersion: '13.2.13',
        indent: 2,
        tokenBody: JSON.stringify({ token: 'stub-registry-token' }, null, 2),
      });

      expect(code, out).toBe(0);
      expect(out).toContain('Testing candidate against v13.2.12');
    });

    // The OCI spec's own "no tags" spelling is `null`, and it has to keep working
    // — an empty repository is a legible answer, just not a usable one here.
    it('reads a null tag list as an empty catalogue rather than a malformed one', async () => {
      const { code, out } = await runStep([], {
        underTest: '13.2.14',
        parentVersion: '13.2.13',
        pages: [null],
      });

      expect(code).toBe(1);
      expect(out).toContain('publishes no Server image at or below');
      expect(out).not.toContain('not a tag list');
    });

    /**
     * A `tags` that is well-formed JSON but not a list is a registry that answered
     * something ELSE, and it has to be told apart from a repository with nothing
     * in it. The string case is the one that decides it: `for…of` over a string
     * iterates characters perfectly happily, so without the shape check the step
     * concludes "nothing is published" from a response that never said that.
     */
    it.each([
      ['a string', 'v13.2.12'],
      ['an object', { latest: 'v13.2.12' }],
    ])('fails closed when the catalogue answers %s instead of a list', async (_, tags) => {
      const { code, out } = await runStep([], {
        underTest: '13.2.14',
        parentVersion: '13.2.13',
        pages: [tags],
      });

      expect(code).toBe(1);
      expect(out).toContain('not a tag list');
      expect(out).not.toContain('publishes no Server image');
    });

    it('fails when the registry publishes no Server image at all', async () => {
      const { code, out } = await runStep([], { underTest: '13.2.14' });

      expect(code).toBe(1);
      expect(out).toContain('publishes no Server image at or below 13.2.14');
    });

    /**
     * The bound, in both directions.
     *
     * On a release commit `version.txt` names the release this very run gates, and
     * picking it would test the candidate against itself. On every other commit
     * the same file names the release a deployment is actually running, which is
     * the one worth cutting over from. The difference is legible without touching
     * a single ref: whether HEAD is what changed the file.
     */
    it('excludes the release the commit under test is creating', async () => {
      const { code, out } = await runStep(['v13.2.12', 'v13.2.13'], {
        underTest: '13.2.13',
        parentVersion: '13.2.12',
      });

      expect(code, out).toBe(0);
      expect(out).toContain('Testing candidate against v13.2.12');
    });

    it('keeps the release a non-release commit is sitting on', async () => {
      const { code, out } = await runStep(['v13.2.12', 'v13.2.13'], {
        underTest: '13.2.13',
        parentVersion: '13.2.13',
      });

      expect(code, out).toBe(0);
      expect(out).toContain('Testing candidate against v13.2.13');
    });

    // An unreadable parent leaves the bound exclusive, because picking the version
    // under test is the only outcome here that cannot be recovered from.
    it('treats an unreadable parent as a release commit', async () => {
      const { code, out } = await runStep(['v13.2.12', 'v13.2.13'], {
        underTest: '13.2.13',
        parentVersion: null,
      });

      expect(code, out).toBe(0);
      expect(out).toContain('Testing candidate against v13.2.12');
    });

    /**
     * `finalize-maintenance-backend` dispatches this workflow on a maintenance
     * ref, where the newest thing the registry publishes is far ahead of the
     * branch. Cutting over FROM it would be a downgrade dressed up as a smoke
     * test, so the version under test — not the registry's newest — is the bound.
     */
    it('never picks a release newer than the version under test', async () => {
      const { code, out } = await runStep(['v13.1.8', 'v13.1.9', 'v13.2.12', 'v13.3.0'], {
        underTest: '13.1.9',
        parentVersion: '13.1.8',
      });

      expect(code, out).toBe(0);
      expect(out).toContain('Testing candidate against v13.1.8');
    });

    /**
     * ghcr.io hands the catalogue back oldest-first, so a read that stops at the
     * first page loses precisely the releases this step is looking for — and loses
     * them without an error. The stub only serves the newest page behind a `next`
     * link, so a step that ignores the link picks v13.1.0 or fails outright.
     */
    it('follows the catalogue past its first page', async () => {
      const { code, out } = await runStep([], {
        underTest: '13.2.14',
        parentVersion: '13.2.13',
        pages: [
          ['v13.0.0', 'v13.1.0'],
          ['v13.2.11', 'v13.2.12'],
        ],
      });

      expect(code, out).toBe(0);
      expect(out).toContain('Testing candidate against v13.2.12');
    });

    it('selects from a catalogue larger than a pipe buffer', async () => {
      const catalogue = Array.from({ length: 12_000 }, (_, patch) => `v13.2.${patch}`);
      const { code, out } = await runStep(catalogue, {
        underTest: '13.2.12000',
        parentVersion: '13.2.11999',
      });

      expect(code, out).toBe(0);
      expect(out).toContain('Testing candidate against v13.2.11999');
    });

    // The condition that produced the outage is worth naming while the job is
    // still alive: a release with a tag and no image cannot self-update onto
    // anything, and nothing else in CI says so.
    it('warns when the release this commit carries has no published image', async () => {
      const { code, out } = await runStep(['v13.2.11', 'v13.2.12'], {
        underTest: '13.2.13',
        parentVersion: '13.2.13',
      });

      expect(code, out).toBe(0);
      expect(out).toContain(
        '::warning::v13.2.13 is the release this commit carries, but ghcr.io has no Server image for it.',
      );
      expect(out).toContain('Testing candidate against v13.2.12');
    });

    /**
     * This step runs before the isolated daemon exists, so its `docker pull` lands in
     * whichever daemon the runner's own socket names. That used to be a VM's, and the
     * step dropped BOTH references it held — the pulled `ghcr.io/…:vN` and the smoke
     * alias — because either one left behind keeps the layers and frees nothing, and
     * v13.1.1 and v13.1.3 had both died of ENOSPC while building.
     *
     * On a self-hosted runner that daemon is the production host's, and the same two
     * removals are two different acts. The alias is this job's own name, created four
     * lines earlier, and nobody else can be holding it. `ghcr.io/…:vN` is a real
     * released image on the box running the live deployment — plausibly the one it is
     * serving — and `docker image rm` on an image's last reference is a delete, not
     * an untag. Docker does refuse while a container holds it, but a job that must
     * not delete production images should not be resting on Docker noticing.
     *
     * So the disk argument loses: the host has room, and keeping the pull warms the
     * next run. What survives is the ORDER — the alias only goes once the tar holds
     * it — and that is what stays asserted.
     */
    it('frees only the alias it created, and never the released image it pulled', async () => {
      const { code, out, docker } = await runStep(['v13.1.0', 'v13.1.2'], {
        underTest: '13.1.3',
        parentVersion: '13.1.2',
      });
      const removed = docker.filter((call) => call.startsWith('image rm'));

      expect(code, out).toBe(0);
      expect(removed).toHaveLength(1);
      expect(removed[0]).toContain('verity-server:previous');
      // The whole point of the change: a released image on the production daemon is
      // not this job's to remove, however much disk it would free.
      expect(removed[0]).not.toContain('ghcr.io/heey-global/verity/verity-server:v13.1.2');
      // After the save, or there is nothing left to write into the tar.
      expect(docker.findIndex((call) => call.startsWith('save'))).toBeLessThan(
        docker.findIndex((call) => call.startsWith('image rm')),
      );
    });
  });

  /**
   * The janitor issues a FORCE REMOVE against the daemon that carries the live
   * Verity deployment, so what it selects is the whole safety argument — and an
   * assertion on the step's text cannot exercise a selection. These drive the real
   * shell against representative `docker ps` output instead.
   *
   * Two independent guards have to hold, and each is tested with the other one
   * satisfied, or a step with only one of them would pass both cases:
   *
   *   - the NAME must be the full run-scoped shape this workflow builds,
   *     `verity-self-update-dind-<run_id>-<attempt>`. Prefix matching would accept
   *     anything else that ever adopts the prefix, on a production host;
   *   - the AGE must be measured in days or more. The job's own budget is 90
   *     minutes, so anything finer can name a live sibling's daemon, and removing
   *     that fails a release.
   */
  describe('reclaiming leaked isolated-daemon state', () => {
    /** Runs the janitor with `docker ps`/`volume ls` answering `listed`. */
    const runJanitor = async (
      listed: { containers?: string[]; volumes?: string[] } = {},
    ): Promise<{ code: number; out: string; removed: string[] }> => {
      const { containers = [], volumes = [] } = listed;
      const dir = await mkdtemp(join(tmpdir(), 'self-update-janitor-'));
      const calls = join(dir, 'docker-calls');
      try {
        const emit = (lines: string[]): string =>
          lines.length === 0 ? 'true' : `printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')}`;
        await writeFile(
          join(dir, 'docker'),
          `#!/usr/bin/env bash\n` +
            `printf '%s\\n' "$*" >>${JSON.stringify(calls)}\n` +
            `case "$*" in\n` +
            `  *'ps --all'*) ${emit(containers)}; exit 0;;\n` +
            `  *'volume ls'*) ${emit(volumes)}; exit 0;;\n` +
            `esac\n` +
            `exit 0\n`,
          { mode: 0o755 },
        );
        const result = await runIn(dir, await step('Reclaim leaked isolated-daemon state'));
        const logged = (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
        return {
          ...result,
          removed: logged.filter((call) => /rm --force|volume rm/.test(call)),
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };

    it('removes a day-old daemon container and the volume it was holding', async () => {
      const { code, out, removed } = await runJanitor({
        containers: ['verity-self-update-dind-42-1 3 days ago'],
        // Dangling only once the container above is gone, which is the whole
        // reason the container sweep runs first and in this same step.
        volumes: ['verity-self-update-dind-42-1-data'],
      });

      expect(code, out).toBe(0);
      expect(removed).toHaveLength(2);
      expect(removed[0]).toContain('rm --force');
      expect(removed[0]).toContain('verity-self-update-dind-42-1');
      expect(removed[1]).toContain('volume rm verity-self-update-dind-42-1-data');
    });

    it('leaves a concurrent run’s daemon alone however leaked it looks', async () => {
      const { code, out, removed } = await runJanitor({
        containers: [
          'verity-self-update-dind-77-1 5 minutes ago',
          'verity-self-update-dind-78-2 About an hour ago',
          'verity-self-update-dind-79-1 23 hours ago',
        ],
      });

      expect(code, out).toBe(0);
      expect(removed).toEqual([]);
    });

    /**
     * Everything a wrong answer from the daemon-side filter could hand back. Each
     * of these is a day old, so the age gate is satisfied and only the name is
     * deciding — and each is force-removed by a prefix match. `verity-data` is the
     * live deployment's own volume; the rest are the shapes a future step or an
     * unrelated container could plausibly take.
     */
    it.each([
      ['the live deployment’s own state', 'verity-data'],
      ['a sibling workflow’s container', 'verity-self-update-cache'],
      ['a non-numeric run field', 'verity-self-update-dind-main-1'],
      ['a missing attempt field', 'verity-self-update-dind-42'],
      ['a suffixed lookalike', 'verity-self-update-dind-42-1-scratch'],
    ])('refuses to remove %s', async (_, name) => {
      const { code, out, removed } = await runJanitor({ containers: [`${name} 3 days ago`] });

      expect(code, out).toBe(0);
      expect(removed).toEqual([]);
      expect(out).toContain(`Not removing '${name}'`);
    });

    it('applies the same shape to volumes, which name no run of ours either', async () => {
      const { code, out, removed } = await runJanitor({
        volumes: ['verity-data', 'verity-self-update-dind-main-1-data', 'verity-updater-control'],
      });

      expect(code, out).toBe(0);
      expect(removed).toEqual([]);
      expect(out).toContain("Not removing 'verity-data'");
      expect(out).toContain("Not removing 'verity-updater-control'");
    });
  });

  // The tar is Server-image sized and `$RUNNER_TEMP` is on `/`; the daemon it was
  // just loaded into is not. Run the step rather than read it, for the reason
  // above — the bug it guards against would be valid shell either way.
  it('keeps the previous-release tar off `/` once the isolated daemon holds it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-update-load-'));
    try {
      await writeFile(join(dir, 'docker'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
      const tar = join(dir, 'verity-smoke-previous.tar');
      await writeFile(tar, 'a saved image');

      const { code, out } = await runIn(
        dir,
        await step('Load the previous release into the isolated daemon'),
      );

      expect(code, out).toBe(0);
      await expect(readFile(tar, 'utf8')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * This assertion is the inverse of the one it replaces, and the inversion is the
   * point rather than a relaxation.
   *
   * The image build and the harness build have no dependency on one another, so
   * running them concurrently was free wall-clock on a VM that had the machine to
   * itself. It is not free here. The runner lane is capped at 1.5 cores and 3 GiB,
   * but the isolated daemon and its BuildKit are SIBLING containers started through
   * the host socket and inherit no cap at all — so overlapping them does not overlap
   * two bounded workloads. It puts an uncapped image build next to the ceiling
   * `npm ci` plus `tsc -b` is trying to fit inside (measured at ~1.2 GB peak, and
   * already SIGTERMed on these runners once), on the box serving production.
   *
   * Serialising spends a few minutes of a 90-minute budget, on runner time that no
   * longer costs anything. What must NOT be lost with the concurrency is the cache
   * warming: this build is what makes the gated release publisher's build
   * incremental, and it needs the Actions runtime token a shell-invoked Buildx does
   * not otherwise get.
   */
  it('builds the image and harness one after the other, still warming the release cache', async () => {
    const workflow = await readFile(resolve(root, '.github/workflows/self-update.yml'), 'utf8');

    expect(workflow).toContain('docker buildx build');
    expect(workflow).toContain('crazy-max/ghaction-github-runtime@');
    expect(workflow).toContain(
      '--cache-to type=gha,mode=max,scope=verity-server,ignore-error=true',
    );
    expect(workflow).toContain('for attempt in 1 2 3; do');
    expect(workflow).toContain('failed to fetch oauth token: unexpected status from');
    expect(workflow).toContain('deterministic Dockerfile/build failures still fail immediately');

    // Two steps, not one step with two background jobs — and the harness first, so a
    // compile error fails before the expensive build rather than beside it.
    // Anchored on the end of the line, because a bare `indexOf` of the name is a
    // prefix match: it is equally satisfied by a step called
    // "Build the host-side harness LATER", which is exactly what a reordering edit
    // that renames as it goes would leave behind.
    const harness = workflow.indexOf('- name: Build the host-side harness\n');
    const image = workflow.indexOf('- name: Build the Server image into the isolated daemon\n');
    expect(harness).toBeGreaterThan(-1);
    expect(image).toBeGreaterThan(harness);

    // The concurrency this replaced, in the spelling it had. Backgrounding the build
    // again is a one-line change that looks like a pure speed win from the diff.
    expect(workflow).not.toContain('image_pid');
    expect(workflow).not.toContain('harness_pid');
  });

  it('retries only transient registry authorization failures', async () => {
    const script = await step('Build the Server image into the isolated daemon');
    const dir = await mkdtemp(join(tmpdir(), 'verity-build-retry-'));
    const docker = join(dir, 'docker');
    const sleep = join(dir, 'sleep');
    await writeFile(
      docker,
      `#!/usr/bin/env bash
count_file="$RUNNER_TEMP/docker-count"
count=0
[[ ! -f "$count_file" ]] || count="$(<"$count_file")"
count=$((count + 1))
printf '%s' "$count" >"$count_file"
case "$BUILD_CASE" in
  transient-then-success)
    [[ "$count" -ge 3 ]] || { echo 'ERROR: failed to fetch oauth token: unexpected status from POST request to https://auth.docker.io/token: 500 Internal Server Error' >&2; exit 1; } ;;
  transient-exhausted)
    echo 'ERROR: failed to fetch oauth token: unexpected status from POST request to https://auth.docker.io/token: 429 Too Many Requests' >&2; exit 1 ;;
  deterministic)
    echo 'ERROR: compiler reported unexpected EOF while building application' >&2; exit 1 ;;
esac
`,
    );
    await writeFile(sleep, '#!/usr/bin/env bash\nexit 0\n');
    await chmod(docker, 0o755);
    await chmod(sleep, 0o755);

    try {
      const env = {
        VERITY_SMOKE_SERVER_VERSION: '16.4.1',
        VERITY_SMOKE_IMAGE: 'verity-server:candidate',
      };
      const recovered = await runIn(dir, script, { ...env, BUILD_CASE: 'transient-then-success' });
      expect(recovered.code).toBe(0);
      expect(await readFile(join(dir, 'docker-count'), 'utf8')).toBe('3');

      await rm(join(dir, 'docker-count'));
      const exhausted = await runIn(dir, script, { ...env, BUILD_CASE: 'transient-exhausted' });
      expect(exhausted.code).not.toBe(0);
      expect(await readFile(join(dir, 'docker-count'), 'utf8')).toBe('3');

      await rm(join(dir, 'docker-count'));
      const deterministic = await runIn(dir, script, { ...env, BUILD_CASE: 'deterministic' });
      expect(deterministic.code).not.toBe(0);
      expect(await readFile(join(dir, 'docker-count'), 'utf8')).toBe('1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
