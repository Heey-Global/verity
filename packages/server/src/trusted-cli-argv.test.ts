import { mkdtempSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadTrustedCliArgvPolicy,
  matchesTrustedCliArgvPolicy,
  TRUSTED_CLI_ARGV_POLICY_SUFFIX,
  trustedCliLaunchSpec,
  validateTrustedCliArguments as validateTrustedCliArgumentsRuntime,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

/**
 * Argv fixtures for the trusted CLI integrity rule.
 *
 * These cases were written against a second, independent implementation of the
 * same check and are ported here unchanged in intent: they describe what argv
 * may and may not carry, not how the shipped validator arrives at the answer.
 * Assertions are message-agnostic on purpose — a case belongs here because the
 * call is refused, not because it is refused for a particular reason.
 *
 * A refusal fixture therefore runs every spelling it lists and asserts on the
 * set that got through, rather than stopping at the first. A gap the rule does
 * not cover yet is written the same way, only with the survivors named instead
 * of empty — see {@link expectGap}, which says what such a fixture asserts and
 * what to do when one of them fails.
 */

const IMMUTABLE_FILE = '/usr/lib/os-release';
// `TRUSTED_CLI_SECRET_DIR` in @verity/secret-contracts, which the package index
// does not re-export. Spelled out here so the fixture pins the literal path the
// contract documents rather than whatever the broker computes.
const SECRET_DIR = '/run/verity-runner/secrets';
// GitHub-hosted runners deliberately make /usr/local/bin writable by the runner.
// These argv fixtures exercise operand classification, not that host-image fact.
const IMMUTABLE_EXECUTABLE_PATH = '/usr/bin:/bin';

const validateTrustedCliArguments: typeof validateTrustedCliArgumentsRuntime = (
  command,
  args,
  cwd,
  executablePath = IMMUTABLE_EXECUTABLE_PATH,
  ...rest
) => validateTrustedCliArgumentsRuntime(command, args, cwd, executablePath, ...rest);

type Call = readonly [command: string, args: readonly string[]];

async function withWorktree(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `verity-trusted-${prefix}-`));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function write(root: string, relative: string, body: string, mode = 0o644): Promise<string> {
  const path = join(root, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body, { mode });
  return path;
}

/**
 * The calls the validator let through, spelled back for the failure message.
 *
 * A refusal is not "anything thrown": every refusal the validator raises says
 * so in its message, and swallowing the rest would let a fixture that mistyped
 * a path, or a validator that crashed on its first line, read as a suite full
 * of refusals. Which rule fired is still not asserted — a case belongs here
 * because the call is refused, not because of the reason given.
 */
async function accepted(
  root: string,
  calls: readonly Call[],
  executablePath?: string,
  mutableDataPaths?: readonly string[],
): Promise<string[]> {
  const survivors: string[] = [];
  for (const [command, args] of calls) {
    try {
      await validateTrustedCliArguments(command, args, root, executablePath, mutableDataPaths);
      survivors.push([command, ...args].join(' '));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('trusted CLI ')) throw error;
    }
  }
  return survivors;
}

/** Every call in the list, spelled the way {@link accepted} reports a survivor. */
function spell(calls: readonly Call[]): string[] {
  return calls.map(([command, args]) => [command, ...args].join(' '));
}

/**
 * Records a gap: these calls reach code the rule was meant to cover, and the
 * shipped validator lets them through today. This is a description of the
 * current behaviour, NOT a requirement — the gaps are meant to close.
 *
 * A failure here is therefore expected on the day one is fixed, and the fix is
 * to move that spelling into the refusal fixture above rather than to widen
 * this list. The set is pinned exactly, rather than the whole block being
 * marked expected-to-fail, so a change that closes one spelling and leaves the
 * others still shows up — an expected-failure marker would stay green.
 */
async function expectGap(root: string, calls: readonly Call[]): Promise<void> {
  expect(
    await accepted(root, calls),
    'A gap fixture changed. If the validator now refuses one of these spellings, ' +
      'that is the fix landing: move the spelling into the refusal fixture above ' +
      'and delete it here. Do not add spellings to a gap fixture to make it pass.',
  ).toEqual(spell(calls));
}

describe('trusted CLI argv integrity', () => {
  it('matches only complete routes from a generic executable policy', () => {
    const policy = {
      version: 1,
      routes: [
        ['inspect', 'item', { kind: 'identifier' }],
        ['item', { kind: 'identifier' }],
      ],
    };
    expect(matchesTrustedCliArgvPolicy(policy, ['inspect', 'item', 'example-2'])).toBe(true);
    expect(matchesTrustedCliArgvPolicy(policy, ['item', 'example-2'])).toBe(true);
    expect(matchesTrustedCliArgvPolicy(policy, ['item', ''])).toBe(false);
    expect(matchesTrustedCliArgvPolicy(policy, ['item', '../payload'])).toBe(false);
    expect(matchesTrustedCliArgvPolicy(policy, ['item', '/work/payload'])).toBe(false);
    expect(matchesTrustedCliArgvPolicy(policy, ['item', '--config=/work/payload'])).toBe(false);
    expect(matchesTrustedCliArgvPolicy(policy, ['item', 'name=value'])).toBe(false);
    expect(matchesTrustedCliArgvPolicy(policy, ['item', 'https://example.com'])).toBe(false);
    expect(matchesTrustedCliArgvPolicy(policy, ['item', 'a'.repeat(256)])).toBe(false);
    expect(matchesTrustedCliArgvPolicy(policy, ['item', 'example-2', 'extra'])).toBe(false);
    expect(matchesTrustedCliArgvPolicy(policy, ['other', 'example-2'])).toBe(false);
  });

  it('rejects malformed generic executable policies', () => {
    for (const policy of [
      { version: 2, routes: [['item']] },
      { version: 1, routes: [] },
      { version: 1, routes: [['']] },
      { version: 1, routes: [[{ kind: 'path' }]] },
      { version: 1, routes: [[{ kind: 'identifier', extra: true }]] },
      { version: 1, routes: [['item']], extra: true },
    ]) {
      expect(() => matchesTrustedCliArgvPolicy(policy, ['item'])).toThrow(
        /trusted CLI argv policy is invalid/u,
      );
    }
  });

  it('does not trust a mutable executable policy', async () => {
    await withWorktree('argv-policy', async (root) => {
      const command = await write(root, 'tool', '#!/bin/sh\n', 0o755);
      await write(
        root,
        `tool${TRUSTED_CLI_ARGV_POLICY_SUFFIX}`,
        `${JSON.stringify({ version: 1, routes: [['item', { kind: 'identifier' }]] })}\n`,
      );
      await expect(validateTrustedCliArguments(command, ['item', 'example'], root)).rejects.toThrow(
        /trusted CLI executable must be root-owned and immutable/u,
      );
    });
  });

  it('discovers, validates, and applies an immutable adjacent policy', async () => {
    const policyPath = `/usr/bin/true${TRUSTED_CLI_ARGV_POLICY_SUFFIX}`;
    const validated: string[] = [];
    const policy = await loadTrustedCliArgvPolicy('/usr/bin/true', {
      lstat: async (path) => {
        expect(path).toBe(policyPath);
        return { isFile: () => true, size: 128 };
      },
      validateImmutablePath: async (path) => {
        validated.push(path);
      },
      readFile: async (path, encoding) => {
        expect([path, encoding]).toEqual([policyPath, 'utf8']);
        return JSON.stringify({
          version: 1,
          routes: [['item', { kind: 'identifier' }]],
        });
      },
    });
    expect(validated).toEqual([policyPath]);

    await withWorktree('argv-policy-apply', async (root) => {
      await write(root, 'item', 'mutable collision\n');
      await expect(
        validateTrustedCliArguments(
          '/usr/bin/true',
          ['item', 'example-2'],
          root,
          undefined,
          [],
          undefined,
          { loadArgvPolicy: async () => policy },
        ),
      ).resolves.toBeUndefined();
      await expect(
        validateTrustedCliArguments(
          '/usr/bin/true',
          ['item', '../payload'],
          root,
          undefined,
          [],
          undefined,
          { loadArgvPolicy: async () => policy },
        ),
      ).rejects.toThrow(/trusted CLI argv is not allowed by executable policy/u);
    });
  });

  // The executable rule used to cover argv[0] alone, so
  // `/usr/bin/timeout … /work/…/script.sh` slipped through: timeout is
  // root-owned while the payload is a script the agent can rewrite between one
  // approved run and the next.
  it('refuses an agent-owned executable hidden in the arguments', async () => {
    await withWorktree('argv', async (root) => {
      const script = await write(root, 'payload.sh', '#!/bin/sh\necho hi\n', 0o755);
      expect(await accepted(root, [['/usr/bin/timeout', ['240s', script]]])).toEqual([]);
    });
  });

  // The approval card already warns that a trusted process may disclose its
  // secret, so inline code the operator read before approving stays legitimate.
  // What must not pass is a path: it shows a name, never the bytes behind it.
  it('allows inline code the operator could read in the prompt', async () => {
    await expect(
      validateTrustedCliArguments('/bin/sh', ['-c', 'echo hi'], tmpdir()),
    ).resolves.toBeUndefined();
  });

  it('refuses a mutable script handed to an interpreter, execute bit or not', async () => {
    await withWorktree('interp', async (root) => {
      const script = await write(root, 'payload.sh', 'echo hi\n');
      expect(
        await accepted(root, [
          ['/bin/sh', [script]],
          // An absolute path is not what makes a file mutable: the process
          // starts in the agent's own worktree, so `sh payload.sh` names the
          // same file.
          ['/bin/sh', ['payload.sh']],
        ]),
      ).toEqual([]);
    });
  });

  // Interpreters ship versioned. `python3.12` is the same interpreter as
  // `python`, and a rule that misses the suffix misses the interpreter.
  it('recognises an interpreter carrying a version suffix', async () => {
    await withWorktree('version', async (root) => {
      const script = await write(root, 'payload.py', 'print(1)\n');
      expect(await accepted(root, [['/usr/bin/python3.12', [script]]])).toEqual([]);
    });
  });

  // An interpreter's own script carries no execute bit as a rule. What the
  // integrity rule asks of it is immutability, and requiring the bit on top
  // would reject a root-owned script for being an ordinary 0644 file.
  it('accepts an immutable script that carries no execute bit', async () => {
    await expect(
      validateTrustedCliArguments('/bin/sh', [IMMUTABLE_FILE], tmpdir()),
    ).resolves.toBeUndefined();
  });

  // The same letter means different things to different interpreters — `-e` is
  // errexit to a shell, `-E` is ignore-environment to Python — and a runtime
  // option can name code outright (`node --require`, `perl -I`, `php -d
  // auto_prepend_file=`). The shipped rule does not read them apart: an option
  // in front of an interpreter is refused whatever it means, which covers every
  // spelling at the price of the benign ones.
  it('refuses interpreter options rather than reading each one', async () => {
    await withWorktree('flags', async (root) => {
      const shell = await write(root, 'payload.sh', 'echo hi\n');
      const python = await write(root, 'payload.py', 'print(1)\n');
      expect(
        await accepted(root, [
          ['/bin/sh', ['-e', shell]],
          ['/usr/bin/python3', ['-E', python]],
          ['/usr/bin/python3', ['-m', 'payload']],
          ['/usr/bin/python3', ['-mpkg.sub']],
          ['/usr/bin/perl', ['-Ie', join(root, 'payload.pl')]],
          ['/usr/bin/perl', ['-I', root, '-Mpayload', '-e', '1;']],
          ['/usr/bin/perl', ['-S', 'payload.pl']],
          ['/usr/bin/php', ['-f', join(root, 'payload.php')]],
          ['/usr/bin/php', ['-d', `auto_prepend_file=${python}`, '-r', 'echo 1;']],
          ['/usr/bin/pwsh', ['-File', shell]],
          ['/usr/bin/node', ['--require=./payload.js', '-e', '']],
          ['/usr/bin/node', ['--require', './payload', '-e', '']],
          ['/usr/bin/node', [`--import=file://${shell}`, '-e', '']],
          ['/usr/bin/node', ['--loader', shell, '-e', '']],
          // A long option the table does not know may swallow the next
          // argument, and then the operand is not where a reader would look.
          ['/usr/bin/node', ['--title', IMMUTABLE_FILE, shell]],
        ]),
      ).toEqual([]);
    });
  });

  // A program does not have to belong to a language runtime. A jq filter, a vim
  // script, a makefile and a sed program are all code a flag names, and all of
  // them are ordinary 0644 files.
  it('holds a program a tool sources to the rule', async () => {
    await withWorktree('sourced', async (root) => {
      const filter = await write(root, 'filter.jq', '.\n');
      const session = await write(root, 'session.vim', 'set nocompatible\n');
      const makefile = await write(root, 'payload.mk', 'all:\n\techo hi\n');
      const program = await write(root, 'payload.awk', '{ print }\n');
      const data = await write(root, 'input.json', '{}\n');
      expect(
        await accepted(root, [
          ['/usr/bin/jq', ['-f', filter]],
          ['/usr/bin/vim', ['-S', session, data]],
          ['/usr/bin/make', ['-f', makefile, 'all']],
          ['/usr/bin/make', [`--file=${makefile}`]],
          // `-j` takes its count attached or not at all, so what follows a bare
          // one is the next argument and not its value — the makefile, here.
          ['/usr/bin/make', ['-j', '-f', makefile]],
          ['/bin/sed', [`--file=${program}`, data]],
        ]),
      ).toEqual([]);
      // Behind an immutable makefile the targets are names, not files to hold.
      await expect(
        validateTrustedCliArguments('/usr/bin/make', ['-f', IMMUTABLE_FILE, 'all'], root),
      ).resolves.toBeUndefined();
    });
  });

  // A path does not have to be a whole argument, or the part behind an `=`. It
  // can ride inside one token behind a prefix the option itself defines, and
  // three of those decide what runs: an argument file supplies the rest of argv,
  // and a JVM agent runs its premain before the program's own main.
  it('holds a path carried behind a prefix in the same token to the rule', async () => {
    await withWorktree('carried', async (root) => {
      const argfile = await write(root, 'args.txt', '-jar /work/payload.jar\n');
      const jar = await write(root, 'agent.jar', 'PK\n');
      expect(
        await accepted(root, [
          ['/usr/bin/java', [`@${argfile}`]],
          ['/usr/bin/java', ['@args.txt']],
          ['/usr/bin/java', [`-javaagent:${jar}`, 'Main']],
          ['/usr/bin/java', [`-javaagent:${jar}=quiet`, 'Main']],
          ['/usr/bin/java', [`-agentpath:${jar}`, 'Main']],
          ['/usr/bin/java', [`-Xbootclasspath/a:${root}`, 'Main']],
        ]),
      ).toEqual([]);
      // The same reading must not fire on a value whose colon belongs to a URL
      // scheme: behind it sits `//host`, which looks absolute and exists
      // nowhere, and refusing it would take ordinary HTTPS arguments with it.
      await expect(
        validateTrustedCliArguments(
          '/usr/bin/curl',
          ['-sS', '--url=https://example.invalid/x'],
          root,
        ),
      ).resolves.toBeUndefined();
      // And the reading refuses the file, not the spelling: the same two
      // prefixes pointing at something the agent cannot rewrite still run.
      expect(
        await accepted(root, [
          ['/usr/bin/java', [`@${IMMUTABLE_FILE}`]],
          ['/usr/bin/java', [`-javaagent:${IMMUTABLE_FILE}`, 'Main']],
        ]),
      ).toEqual(
        spell([
          ['/usr/bin/java', [`@${IMMUTABLE_FILE}`]],
          ['/usr/bin/java', [`-javaagent:${IMMUTABLE_FILE}`, 'Main']],
        ]),
      );
    });
  });

  // The environment spelling of the same jar. `env JAVA_TOOL_OPTIONS=-javaagent:<jar>`
  // loads it without the path ever appearing where argv inspection reaches.
  it('holds the jvm option variables to the rule', async () => {
    await withWorktree('jvmenv', async (root) => {
      const jar = await write(root, 'agent.jar', 'PK\n');
      expect(
        await accepted(
          root,
          ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS'].map(
            (name) => ['/usr/bin/env', [`${name}=-javaagent:${jar}`, 'true']] as const,
          ),
        ),
      ).toEqual([]);
    });
  });

  // A TypeScript runtime runs source that carries no execute bit and rarely
  // needs one, whether a subcommand spells the run out or not.
  it('holds the source a javascript runtime runs to the rule', async () => {
    await withWorktree('source', async (root) => {
      const payload = await write(root, 'payload.ts', 'console.log(1)\n');
      // A name without a suffix is a program too — the runtime reads the file,
      // not the name.
      const plain = await write(root, 'payload', 'console.log(1)\n');
      expect(
        await accepted(root, [
          ['/usr/bin/deno', [payload]],
          ['/usr/bin/deno', ['run', '--allow-all', payload]],
          ['/usr/bin/bun', ['run', payload]],
          ['/usr/bin/tsx', [payload]],
          ['/usr/bin/ts-node', [payload]],
          ['/usr/bin/bun', [plain]],
        ]),
      ).toEqual([]);
    });
  });

  // A runtime that runs its own artefacts: `dotnet app.dll` and `java -jar
  // app.jar` execute a file that carries no execute bit, and `go run` compiles
  // the source it names before running it.
  it('holds a runtime artefact to the rule', async () => {
    await withWorktree('runtime', async (root) => {
      const assembly = await write(root, 'payload.dll', 'MZ\n');
      const archive = await write(root, 'payload.jar', 'PK\n');
      const source = await write(root, 'payload.go', 'package main\n');
      expect(
        await accepted(root, [
          ['/usr/bin/dotnet', [assembly]],
          ['/usr/bin/java', ['-jar', archive]],
          ['/usr/bin/go', ['run', source]],
        ]),
      ).toEqual([]);
    });
  });

  // Reading argv[0] alone misses the handoff: timeout is no interpreter, but
  // the shell it wraps is, and from there the execute bit stops meaning
  // anything. A wrapper in front of an interpreter changes nothing.
  it('follows a wrapper that hands the run to an interpreter mid-argv', async () => {
    await withWorktree('wrapper', async (root) => {
      const script = await write(root, 'payload.sh', 'echo hi\n');
      expect(
        await accepted(root, [
          ['/usr/bin/timeout', ['240s', '/bin/sh', script]],
          ['/usr/bin/timeout', ['240s', 'sh', 'payload.sh']],
        ]),
      ).toEqual([]);
    });
  });

  // Aliases are symlinks, and the interpreter behind one runs its argument as
  // code whatever the link is called. Reading the invoked name alone leaves a
  // root-owned `run -> sh` looking like any other command.
  it('recognises an interpreter reached through an alias', async () => {
    await withWorktree('alias', async (root) => {
      const payload = await write(root, 'payload.sh', 'echo 1\n');
      const alias = join(root, 'run');
      await symlink('/bin/sh', alias);
      expect(await accepted(root, [[alias, [payload]]])).toEqual([]);
      // The link is followed to find the interpreter, not to reject whatever it
      // is handed: an immutable script behind the same alias still runs.
      await expect(
        validateTrustedCliArguments(alias, [IMMUTABLE_FILE], root),
      ).resolves.toBeUndefined();
    });
  });

  // A bare name is found along PATH, not in the working directory — which is
  // where an alias to an interpreter hides from a check that only reads the
  // name it was written under. A search path the agent owns is refused before
  // any argument is read, which covers the alias and everything behind it.
  it('refuses a search path the agent can write', async () => {
    await withWorktree('path', async (root) => {
      const bin = join(root, 'bin');
      await mkdir(bin);
      await symlink('/bin/sh', join(bin, 'run'));
      const payload = await write(root, 'payload.sh', 'echo 1\n');
      expect(await accepted(root, [['/usr/bin/timeout', ['240s', 'run', payload]]], bin)).toEqual(
        [],
      );
    });
  });

  // BusyBox is a shell only when its applet argument says so.
  it('reads the busybox applet that turns it into a shell', async () => {
    await withWorktree('busybox', async (root) => {
      const data = await write(root, 'source.txt', 'contents\n');
      expect(await accepted(root, [['/bin/busybox', ['sh', data]]])).toEqual([]);
    });
  });

  // Inline code ends the interpreter's grammar, not the scan. A program passed
  // on behind it is still a program, or one `-c` anywhere in argv would hide
  // the rest of the command line.
  it('keeps holding executables behind inline code to the rule', async () => {
    await withWorktree('handoff', async (root) => {
      const payload = await write(root, 'payload.sh', 'echo hi\n', 0o755);
      expect(
        await accepted(root, [['/bin/sh', ['-c', 'run "$@"', 'sh', 'python', '-c', payload]]]),
      ).toEqual([]);
    });
  });

  // `env PATH=… cmd` is resolved against that PATH at run time, not against the
  // directories the broker vouches for. A bare name behind it can pick up a
  // file the agent wrote, and nothing else in argv says so.
  it('follows a search path that argv itself moves', async () => {
    await withWorktree('lookup', async (root) => {
      const bin = join(root, 'bin');
      await mkdir(bin);
      await write(root, 'bin/tool', '#!/bin/sh\necho hi\n', 0o755);
      expect(
        await accepted(root, [
          ['/usr/bin/env', [`PATH=${bin}`, 'tool', 'run']],
          // A wrapper in front says nothing about where the command it runs
          // will be found: the moved lookup holds for every name behind it.
          ['/usr/bin/env', [`PATH=${bin}`, 'timeout', '1', 'tool']],
          // An entry that is relative means the directory the run starts in,
          // which is the agent's own worktree.
          ['/usr/bin/env', ['PATH=bin', 'tool']],
        ]),
      ).toEqual([]);
      // The path the run starts with is held to the same rule.
      expect(await accepted(root, [['/usr/bin/timeout', ['1', 'tool']]], bin)).toEqual([]);
      // An assignment that moves nothing leaves the command where it was found.
      await expect(
        validateTrustedCliArguments('/usr/bin/env', ['FOO=1', 'true', 'run'], root),
      ).resolves.toBeUndefined();
    });
  });

  // PATH is not the only variable that reaches code. A runtime reads its own
  // options, its module path and its startup file out of the environment, and
  // `env NAME=… cmd` puts any of them on the command line.
  it('refuses a code-loading assignment in front of the command', async () => {
    await withWorktree('variable', async (root) => {
      const payload = await write(root, 'payload.js', 'process.exit(0);\n');
      expect(
        await accepted(root, [
          ['/usr/bin/env', [`NODE_OPTIONS=--require=${payload}`, 'true']],
          ['/usr/bin/env', ['RUBYOPT=-r./payload.js', 'true']],
          ['/usr/bin/env', ['PERL5OPT=-I. -Mstrict', 'true']],
          ['/usr/bin/env', [`NODE_PATH=${root}`, 'true']],
          ['/usr/bin/env', [`PERL5LIB=${root}`, 'true']],
          ['/usr/bin/env', [`PYTHONPATH=/usr/lib:${root}`, 'true']],
          ['/usr/bin/env', [`BASH_ENV=${payload}`, 'true']],
          ['/usr/bin/env', ['PYTHONSTARTUP=./payload.js', 'true']],
          ['/usr/bin/env', [`LD_PRELOAD=${payload}`, 'true']],
        ]),
      ).toEqual([]);
      // A variable that reaches no code at all stays a value the run carries.
      await expect(
        validateTrustedCliArguments('/usr/bin/env', ['LANG=C', 'true'], root),
      ).resolves.toBeUndefined();
    });
  });

  // `env -S` carries a whole command line inside one argument, and `env -C`
  // moves the ground a relative name stands on. Neither is read apart: an
  // option in front of env's command operand is refused outright, which closes
  // both without parsing the string.
  it('refuses the env options that would hide a command line', async () => {
    await withWorktree('split', async (root) => {
      await write(root, 'payload.sh', 'echo hi\n');
      await write(root, 'sub/payload.sh', 'echo hi\n');
      expect(
        await accepted(root, [
          ['/usr/bin/env', ['-S', 'sh payload.sh']],
          ['/usr/bin/env', ['-Ssh payload.sh']],
          ['/usr/bin/env', ['--split-string=sh payload.sh']],
          ['/usr/bin/env', ['-S', `PATH=${join(root, 'bin')} tool run`]],
          ['/usr/bin/env', ['-S', 'sh "payload file.sh"']],
          ['/usr/bin/env', ['-C', 'sub', 'sh', 'payload.sh']],
          ['/usr/bin/env', ['--chdir=sub', 'sh', 'payload.sh']],
          ['/usr/bin/env', ['-P', join(root, 'bin'), 'tool']],
          ['/usr/bin/env', ['-u', 'FOO', 'sh', 'payload.sh']],
        ]),
      ).toEqual([]);
    });
  });

  // A file that is not there yet is a file all the same: the check reads the
  // filesystem and the command reads it again, and in a directory the agent
  // writes, a file can arrive in between. Spelled as a path this is refused —
  // and the spelling is the whole of it, see the fixture below.
  it('refuses a file operand that does not exist yet', async () => {
    await withWorktree('absent', async (root) => {
      expect(
        await accepted(root, [
          ['/usr/bin/make', ['-f', join(root, 'absent.mk'), 'all']],
          ['/usr/bin/make', ['-f', './absent.mk', 'all']],
          ['/usr/bin/java', ['-cp', join(root, 'future'), 'Main']],
          ['/usr/bin/xargs', ['-a', './payload.args', 'sh']],
        ]),
      ).toEqual([]);
    });
  });

  // GAP: the same absent file, spelled without a leading `/`, `./`, `../` or
  // `file:`, is waved through. `make -f payload.mk` and `xargs -a payload.args`
  // name a place in the agent's own worktree, and the agent can put a file
  // there between the approval and the launch — the run then reads it. What
  // decides today is the spelling, not where the name points.
  it('records the gap: an absent file operand spelled as a bare relative name', async () => {
    await withWorktree('absent-bare', async (root) => {
      const calls: Call[] = [
        ['/usr/bin/make', ['-f', 'payload.mk', 'all']],
        ['/usr/bin/xargs', ['-a', 'payload.args', 'sh']],
        ['/usr/bin/java', ['-cp', 'future/lib/*', 'Main']],
      ];
      await expectGap(root, calls);
    });
  });

  // The cost of the rule, pinned so a change to it is visible: an argument that
  // names an existing file the agent owns is refused whatever the command does
  // with it, and so is one that names a directory. Data operands and working
  // directories are not reachable by a trusted CLI call today.
  it('refuses data operands and directories along with code', async () => {
    await withWorktree('data', async (root) => {
      const data = await write(root, 'input.json', '{}\n');
      const config = await write(root, 'EXAMPLE_CONFIG', 'apiVersion: v1\n', 0o600);
      await mkdir(join(root, 'pkg'), { recursive: true });
      expect(
        await accepted(root, [
          ['/usr/local/bin/example-cli', ['--config', config, 'get', 'items']],
          ['/usr/bin/jq', ['-f', IMMUTABLE_FILE, data]],
          ['/bin/sh', [IMMUTABLE_FILE, data]],
          ['/bin/sh', ['-c', 'cat "$1"', 'sh', data]],
          ['/usr/bin/go', ['test', './pkg']],
          ['/bin/tar', ['-C', '/usr/lib', '-cf', '/dev/null', 'os-release']],
        ]),
      ).toEqual([]);
      // A command whose arguments name nothing on disk is unaffected.
      await expect(
        validateTrustedCliArguments(
          '/usr/local/bin/example-cli',
          ['-n', 'system', 'get', 'items'],
          root,
        ),
      ).resolves.toBeUndefined();
    });
  });

  // A socket operand is admitted by node type — a daemon endpoint holds no bytes
  // that could change behind its name — and then held to ownership like every
  // other operand. These are the ones the agent owns, and no spelling of the
  // flag reaches past that: the socket is in its own worktree, so the peer
  // answering the trusted CLI would be the agent's own process, with the run's
  // secret going to it.
  it('refuses a socket the agent owns, whichever way the flag names it', async () => {
    await withWorktree('socket', async (root) => {
      const socketPath = join(root, 'example-daemon.sock');
      const daemon = createServer();
      await new Promise<void>((listening) => daemon.listen(socketPath, listening));
      try {
        expect(
          await accepted(root, [
            ['/usr/bin/example-cli', [`--socket=${socketPath}`, 'status']],
            ['/usr/bin/example-cli', ['--socket', socketPath, 'status']],
            ['/usr/bin/example-cli', ['--socket', './example-daemon.sock', 'status']],
            // The interpreter position, where a special file is refused for
            // being one whoever owns it.
            ['/bin/sh', [socketPath]],
          ]),
        ).toEqual([]);
      } finally {
        daemon.close();
      }
    });
  });
});

describe('trusted CLI materialized secret exception', () => {
  const secretPath = `${SECRET_DIR}/EXAMPLE_TOKEN`;

  // The launch spec puts the path in the variable, and the validator is handed
  // that same path as the one mutable file it may accept. Both halves have to
  // name the same file or the exception covers nothing.
  it('names the file the launch spec injects', () => {
    const spec = trustedCliLaunchSpec(
      {
        kind: 'trusted-cli',
        command: '/usr/bin/example-cli',
        args: ['up', `--secret=file:${secretPath}`],
        cwd: '/work/project',
        secrets: [{ name: 'EXAMPLE_TOKEN', value: 'example-secret', injection: 'file' }],
      },
      { agentUid: 1000, agentGid: 1000, env: { PATH: '/usr/bin' } },
    );
    expect(spec.spawnOptions.env?.EXAMPLE_TOKEN).toBe(secretPath);
    expect(JSON.stringify(spec)).not.toContain('example-secret');
  });

  // Several secrets in one launch: each lands under its own variable, and a
  // file-injected one still carries the path rather than the value.
  it('injects every secret of a multi-credential launch', () => {
    const spec = trustedCliLaunchSpec(
      {
        kind: 'trusted-cli',
        command: '/usr/local/bin/fastlane',
        args: ['deliver'],
        cwd: '/work/project',
        secrets: [
          { name: 'ASC_KEY_FILE', value: '-----BEGIN PRIVATE KEY-----', injection: 'file' },
          { name: 'ASC_KEY_ID', value: 'ABCD1234', injection: 'env' },
          { name: 'ASC_ISSUER_ID', value: '69a6de70-issuer', injection: 'env' },
        ],
      },
      { agentUid: 1000, agentGid: 1000, env: { PATH: '/usr/bin' } },
    );
    expect(spec.spawnOptions.env?.ASC_KEY_FILE).toBe(`${SECRET_DIR}/ASC_KEY_FILE`);
    expect(spec.spawnOptions.env?.ASC_KEY_ID).toBe('ABCD1234');
    expect(spec.spawnOptions.env?.ASC_ISSUER_ID).toBe('69a6de70-issuer');
    expect(JSON.stringify(spec)).not.toContain('BEGIN PRIVATE KEY');
    // Two secrets under one name would leave the winner to object-key order.
    expect(() =>
      trustedCliLaunchSpec(
        {
          kind: 'trusted-cli',
          command: '/usr/local/bin/fastlane',
          args: ['deliver'],
          cwd: '/work/project',
          secrets: [
            { name: 'ASC_KEY', value: 'first', injection: 'env' },
            { name: 'ASC_KEY', value: 'second', injection: 'env' },
          ],
        },
        { agentUid: 1000, agentGid: 1000, env: { PATH: '/usr/bin' } },
      ),
    ).toThrow(/duplicate/u);
    // The unsafe-name rule applies to every entry, not just the first.
    expect(() =>
      trustedCliLaunchSpec(
        {
          kind: 'trusted-cli',
          command: '/usr/local/bin/fastlane',
          args: ['deliver'],
          cwd: '/work/project',
          secrets: [
            { name: 'ASC_KEY_ID', value: 'ABCD1234', injection: 'env' },
            { name: 'LD_PRELOAD', value: '/tmp/evil.so', injection: 'env' },
          ],
        },
        { agentUid: 1000, agentGid: 1000, env: { PATH: '/usr/bin' } },
      ),
    ).toThrow(/unsafe/u);
  });

  // The documented spelling — `example-cli up --secret=file:<path>` — passes
  // before the file exists, which is when the validator runs: the secret is
  // materialized only once the request is accepted.
  it('accepts the documented file: spelling before the secret is written', async () => {
    await withWorktree('secret', async (root) => {
      for (const args of [
        ['up', `--secret=file:${secretPath}`],
        ['up', '--secret', `file:${secretPath}`],
      ]) {
        await expect(
          validateTrustedCliArguments('/usr/bin/example-cli', args, root, undefined, [secretPath]),
        ).resolves.toBeUndefined();
      }
    });
  });

  // The exception is scoped to the launch it was granted for: without file
  // injection there is no mutable path, and the same argument is refused.
  it('does not accept the path when nothing was materialized', async () => {
    await withWorktree('secret-env', async (root) => {
      expect(
        await accepted(
          root,
          [['/usr/bin/example-cli', ['up', `--secret=file:${secretPath}`]]],
          undefined,
          [],
        ),
      ).toEqual([]);
    });
  });

  // The exception is bound to the file, not to a spelling. Most commands take
  // their secret as an ordinary path argument, and one that offers no `file:`
  // form — nor an env fallback like EXAMPLE_CONFIG — would otherwise have no argv
  // that both works and validates, leaving file injection unusable for it.
  it('accepts the same materialized file named as a plain path', async () => {
    await withWorktree('secret-plain', async (root) => {
      const config = `${SECRET_DIR}/EXAMPLE_CONFIG`;
      for (const args of [
        ['--config', config, 'get', 'items'],
        [`--config=${config}`, 'get', 'items'],
      ]) {
        await expect(
          validateTrustedCliArguments('/usr/local/bin/example-cli', args, root, undefined, [
            config,
          ]),
        ).resolves.toBeUndefined();
      }
    });
  });

  // Widening the spelling must not widen the path: a neighbour in the same
  // root-owned directory is a different file, and no grant covers it.
  it('refuses a sibling of the materialized secret', async () => {
    await withWorktree('secret-sibling', async (root) => {
      expect(
        await accepted(
          root,
          [['/usr/local/bin/example-cli', ['--config', `${SECRET_DIR}/OTHER`, 'get', 'items']]],
          undefined,
          [`${SECRET_DIR}/EXAMPLE_CONFIG`],
        ),
      ).toEqual([]);
    });
  });

  // A token can name more than one file. `-javaagent:<jar>=<opts>` carries the
  // jar and the option value separately, so naming the secret in one half must
  // not waive the other: the jar is absent at approval and the agent owns the
  // directory it would appear in.
  it('refuses an absent second path carried in the token that names the secret', async () => {
    await withWorktree('secret-carried', async (root) => {
      const secret = `${SECRET_DIR}/EXAMPLE_TOKEN`;
      const jar = join(root, 'agent.jar');
      expect(
        await accepted(
          root,
          [
            ['/usr/bin/java', [`-javaagent:${jar}=${secret}`, 'Main']],
            ['/usr/bin/java', [`-agentpath:${jar}=${secret}`, 'Main']],
            ['/usr/bin/java', [`-javaagent:${jar}=file:${secret}`, 'Main']],
          ],
          undefined,
          [secret],
        ),
      ).toEqual([]);
    });
  });

  // The same token-wide reading without any secret in play: stopping at the
  // first path that happens to exist let the root-owned half of a token vouch
  // for the mutable half, which is the file that would actually load.
  it('refuses a mutable path carried beside a root-owned one in the same token', async () => {
    await withWorktree('carried-mutable', async (root) => {
      const jar = await write(root, 'agent.jar', 'PK\n');
      const config = await write(root, 'agent.conf', 'load: ./payload\n');
      expect(
        await accepted(root, [
          ['/usr/bin/java', [`-javaagent:${jar}=${IMMUTABLE_FILE}`, 'Main']],
          // The jar is immutable here: what the agent loads sits in its options.
          ['/usr/bin/java', [`-javaagent:${IMMUTABLE_FILE}=config=${config}`, 'Main']],
          ['/usr/bin/java', [`-javaagent:${IMMUTABLE_FILE}=quiet,conf=${config}`, 'Main']],
          [
            '/usr/bin/java',
            [`-javaagent:${IMMUTABLE_FILE}=conf=${join(root, 'absent.conf')}`, 'Main'],
          ],
        ]),
      ).toEqual([]);
    });
  });

  // The cost of reading both halves, pinned: the options a JVM agent takes are
  // the JVM's to parse, so an immutable jar carrying them stays admissible.
  it('allows a root-owned path carrying its own option string', async () => {
    await withWorktree('carried-options', async (root) => {
      await expect(
        validateTrustedCliArguments(
          '/usr/bin/java',
          [`-javaagent:${IMMUTABLE_FILE}=quiet,port=9000`, 'Main'],
          root,
        ),
      ).resolves.toBeUndefined();
    });
  });

  // The exemption has to mean the file open(2) reaches, not the string. A
  // symlinked parent plus `..` spells a path that collapses onto the secret
  // textually and lands in a directory the agent writes.
  it('refuses a path that only resolves to the secret lexically', async () => {
    await withWorktree('secret-symlink', async (root) => {
      await mkdir(join(root, 'deep', 'sub'), { recursive: true });
      await symlink(join(root, 'deep', 'sub'), join(root, 'link'));
      const secret = join(root, 'EXAMPLE_TOKEN');
      // Spelled out rather than joined: `join` collapses `..` itself, which is
      // exactly the reading this fixture exists to refuse.
      const traversed = `${root}/link/../EXAMPLE_TOKEN`;
      expect(
        await accepted(
          root,
          [['/usr/bin/example-cli', ['up', '--secret-file', traversed]]],
          undefined,
          [secret],
        ),
      ).toEqual([]);
      // The control: the same secret, named directly, still passes before it is
      // written — the refusal above is about where the path lands, not the file.
      await expect(
        validateTrustedCliArguments(
          '/usr/bin/example-cli',
          ['up', '--secret-file', secret],
          root,
          undefined,
          [secret],
        ),
      ).resolves.toBeUndefined();
    });
  });

  // The validator runs before the secret is written, so a file already sitting
  // at that path is accepted here — the agent could have planted it. Nothing in
  // argv validation stops that; what does is materialization, which writes with
  // `wx` and fails on an existing file, so the launch never happens.
  //
  // That half is NOT covered here: `materializeTrustedCliSecret` is not exported
  // from the broker, so no test outside it can call the real write. A regression
  // to an overwriting flag would leave this fixture green. Closing that needs an
  // export or a launch-path test, which is a change to the implementation file
  // and therefore out of scope for a fixtures-only change.
  it('accepts a file already sitting at the secret path', async () => {
    await withWorktree('secret-planted', async (root) => {
      const planted = await write(root, 'EXAMPLE_TOKEN', 'planted\n', 0o600);
      await expect(
        validateTrustedCliArguments(
          '/usr/bin/example-cli',
          ['up', `--secret=file:${planted}`],
          root,
          undefined,
          [planted],
        ),
      ).resolves.toBeUndefined();
    });
  });
});
