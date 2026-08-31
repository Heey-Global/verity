import { describe, expect, it } from 'vitest';
import { SANDBOX_RESOURCES_SYSTEM_PROMPT } from './sandbox-resources.js';

/**
 * The sentence containing `needle`, so an assertion about one step of the
 * unreadable-ceiling fallback cannot be satisfied by a different step of it.
 * Selecting the whole paragraph was not enough: it holds three branches, and
 * `/default/i` matched the "leave Node's default alone" branch while claiming to
 * guard the one after it.
 *
 * The split is naive on purpose — an abbreviation (`e.g.`, `i.e.`) or a
 * backticked path ending in a dot before a space would re-partition the
 * paragraph and point these assertions at the wrong clause. It fails loudly when
 * that happens rather than silently passing: the empty-string fallback matches
 * no positive assertion, and every needle used here carries at least one, so the
 * lone negative assertion cannot pass vacuously on its own. A sentence tokeniser
 * to serve one paragraph of controlled prose is the worse trade.
 */
const sentenceWith = (needle: string) =>
  SANDBOX_RESOURCES_SYSTEM_PROMPT.split(/(?<=\.)\s+/).find((s) => s.includes(needle)) ?? '';

/** The bullet carrying the parallelism rule. */
const parallelismBullet = () =>
  SANDBOX_RESOURCES_SYSTEM_PROMPT.split('\n').find((l) => l.includes('maxWorkers')) ?? '';

/**
 * These assert what the directive must not stop saying, not how it says it:
 * transcribing whole phrases would make every copy edit a two-file change that
 * could not fail for a reason worth failing over. Three clauses are exceptions
 * and are pinned close to verbatim — the MiB/bytes note, `quota divided by
 * period`, and the unset-quota case — because there the exact wording is the
 * correctness: each one exists to stop a specific unit or format mistake, and a
 * paraphrase that loses the unit loses the clause's whole purpose.
 */
describe('SANDBOX_RESOURCES_SYSTEM_PROMPT', () => {
  it('names the heap flag it forbids, in the units that flag actually takes', () => {
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).toContain('--max-old-space-size');
    // The flag is MiB, `memory.max` is bytes. Telling a session to derive one from
    // the other without saying so yields a cap ~1e6 times too large — not a milder
    // version of the mistake this prevents, the same one, reached by obeying it.
    // Anchored on the clause rather than the words: a bare /MiB/ is satisfied by
    // the `<MiB>` placeholder and a bare /bytes/ by any cgroup path, so deleting
    // the unit sentence outright would have left both green.
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).toMatch(/takes MiB/);
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).toMatch(/report(s)? bytes/);
  });

  it('hardcodes no ceiling and sources it from the cgroup instead', () => {
    // VERITY_SANDBOX_MEMORY is overridable per deployment, so a prompt naming
    // "4 GiB" would, in a sandbox capped at 2, license the cap it then forbids.
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).toContain('/sys/fs/cgroup/memory.max');
    // Prose spellings (`4g`, `4 GB`, `4Gi`, `4 gigabytes`), longest arms first so
    // `4Gi` is not consumed as `4G`. A heuristic, not a proof: `four gigabytes`
    // slips through, and a worked `--max-old-space-size=3072 MiB` example would
    // fail here despite naming no ceiling. That trade is deliberate — a number in
    // this text is what a session copies verbatim into a shell.
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).not.toMatch(
      /\d+\s*(gigabytes?|megabytes?|gib|mib|kib|gb|mb|kb|gi|mi|ki|g|m|k)\b/i,
    );
    // And the flag's own spelling, which carries no unit and so escapes the above.
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).not.toMatch(/max-old-space-size=\s*\d/);
  });

  it('names no fraction of the limit as a safe heap size', () => {
    // Two sessions each taking a "safe" two thirds is 133% of a shared cgroup.
    // `half` is word-bounded; unbounded it matches `behalf` and `halfway`.
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).not.toMatch(
      /(two thirds|a third|\bhalf\b|a quarter|three quarters|\d+\s*%|percent|0\.\d+ of)/i,
    );
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).toMatch(/headroom/i);
    // The deployment-independent quantifier that replaces a fraction. `anon`,
    // not `memory.current`: the latter counts reclaimable page cache and sits at
    // the ceiling after any build, which would make the room look like zero.
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).toContain('memory.stat');
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).toMatch(/\banon\b/);
  });

  it('leaves no gap when the cgroup files give no answer', () => {
    // The branch that fires when the file cannot answer has to name that condition...
    expect(sentenceWith('constrainedMemory')).toMatch(/missing|absent|out of view/i);
    // ...and name cgroup v1 explicitly, because v1 is routed here deliberately
    // rather than given paths of its own: this branch carries a whole cgroup
    // generation, and a session on v1 will not otherwise recognise itself in a
    // sentence about a file that is merely missing.
    expect(sentenceWith('constrainedMemory')).toMatch(/cgroup v1/i);
    // It must issue an instruction, and must address Node's default in the same
    // breath: "set no heap cap at all" reads as safe and is not. The reason is
    // narrow, though — Node does size its default from the cgroup when it can
    // find it (measured, see the module comment). It is this branch specifically,
    // where the file libuv reads is the file the session could not read, that
    // cannot assume the default is fine.
    // Anchored on the sizing rule, not on the word `cap`: the paragraph already
    // says "before setting a heap cap" further up, so `/cap/i` would stay green
    // with the whole instruction deleted.
    expect(sentenceWith('from below')).toMatch(/keep [^.]*\bsmall\b|smallest/i);
    // The give-up branch has to fire on both spellings of "libuv found nothing":
    // 0, and the `undefined` older Node returns.
    expect(sentenceWith('from below')).toMatch(/empty|undefined|nothing/i);
    // The non-zero branch is the one that must leave the default alone; it is a
    // different sentence from the one that gives up, and each is asserted where
    // it lives.
    expect(sentenceWith('non-zero')).toMatch(/default/i);
    // And non-zero is not enough on its own. cgroup v1 spells "no limit" as a
    // near-UINT64_MAX sentinel rather than an absence, so a reading that trusts
    // any non-zero value can come back with an exabyte, and bullet 1's
    // `ceiling - anon` would then license any heap cap at all — the failure this
    // fragment exists to prevent, reached by following it. Whether libuv
    // normalises that sentinel was not measured (no v1 host to hand), which is
    // exactly why the guard has to be in the text rather than assumed.
    expect(sentenceWith('non-zero')).toMatch(/sentinel/i);
    expect(sentenceWith('from below')).toMatch(/sentinel/i);
    // Scoped to this paragraph: as a whole-prompt negative it would fail on an
    // unrelated future sentence like "Node sets no heap cap by default".
    expect(sentenceWith('from below')).not.toMatch(/no heap cap/i);
    // And before any of that, a second reading. libuv looks where the one path
    // this text can afford to name does not — cgroup v1 among them — so asking it
    // turns the branch from conservatism into a measurement, and leaves the
    // costly advice for the case where both readings come back empty. Measured
    // in a sandbox: `process.constrainedMemory()` returned the cgroup limit
    // exactly, and returns 0 when libuv found nothing.
    // Quoted: bash treats the bare parentheses as metacharacters and the command
    // dies before Node runs, which would take the whole branch with it.
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).toContain("node -p 'process.constrainedMemory()'");
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).not.toMatch(/-p process\.constrainedMemory/);
    // And what it instructs has to be reachable from this branch. The sizing
    // rule in bullet 1 subtracts `anon` in `memory.stat` from a ceiling that is
    // precisely what this branch does not have, so the fallback sends the
    // session to scope its work down instead of inventing a number — a cap
    // guessed too low is the same failure wearing the other face.
  });

  it('keeps every prohibition, and the alternative each one leaves open', () => {
    // The `Never` clauses are the load-bearing half of the fragment and were the
    // half nothing covered: assertions on `--max-old-space-size`, `maxWorkers` and
    // the cgroup paths all survive deleting the sentences that forbid anything.
    // Counted rather than quoted, so rewording stays free and dropping one does
    // not — a floor rather than an exact count, since a fourth prohibition is a
    // reason to read the diff, not to fail the build. A prohibition also has to
    // leave somewhere to go — bullet 2 is that somewhere, and it had no coverage
    // at all.
    expect(
      (SANDBOX_RESOURCES_SYSTEM_PROMPT.match(/\bnever\b/gi) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).toMatch(/scope it down|fewer files|one test file/i);
  });

  it('caps parallelism upwards only, and keeps lowering it permitted', () => {
    // The asymmetry is the point: `--maxWorkers=1` is the most direct remedy for
    // the OOM this prevents, and most repositories configure no parallelism at
    // all — so "do not touch what it configured" would forbid the fix.
    expect(parallelismBullet()).toMatch(/lower/i);
    expect(parallelismBullet()).toContain('/sys/fs/cgroup/cpu.max');
    // Same class of trap as MiB-versus-bytes: `cpu.max` reads `200000 100000`,
    // which is a quota and a period in microseconds and not, as it invites, two
    // worker counts. Naming the file without naming its format hands a session
    // the next unit mistake.
    expect(parallelismBullet()).toMatch(/microseconds/i);
    // Two microsecond counts are not a worker count; the conversion has to be
    // stated or the format note just relocates the mistake.
    expect(parallelismBullet()).toMatch(/quota divided by period/i);
    // Fractional quotas exist (VERITY_SANDBOX_CPUS=1.5), and `--maxWorkers=1.5`
    // is not a thing.
    expect(parallelismBullet()).toMatch(/rounded down|round down|floor/i);
    // And `cpu.max` has the unset case `memory.max` has — it reads `max 100000`
    // when no quota is set — so this bullet owes it the same answer the memory
    // paragraph gives, rather than leaving the session to read `max` as a core count.
    // Not `/\bmax\b/`: `.` is a word boundary, so `cpu.max` above satisfies it
    // and the unset case could be deleted without failing.
    expect(parallelismBullet()).toMatch(/means no quota|no quota is set/i);
    expect(parallelismBullet()).toMatch(/out of view/i);
  });

  it('keeps the shared-container premise the headroom rule rests on', () => {
    // Without it, "leave headroom" is unmotivated arithmetic — the reason two
    // thirds is unsafe is the other session also taking two thirds.
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT).toMatch(/other (agent )?sessions/i);
  });

  it('stays inside its budget', () => {
    // Charged on context init and on every resumed turn, so it gets a ceiling
    // rather than growing by accretion. A tripwire, not a target: raise it only
    // for a clause that makes the directive more correct, and take prose that is
    // merely better out of the text that is already here. Margin is a few
    // hundred characters — enough that a clarifying clause does not trip it, not
    // enough to absorb a new paragraph. A ceiling that fires on the next copy
    // edit teaches people to raise it without reading it, which is the opposite
    // of a tripwire. conductor.test.ts bounds the assembled resume set the same
    // way, independently: which of the two fires first depends on where the
    // growth happened, and neither is derived from the other.
    expect(SANDBOX_RESOURCES_SYSTEM_PROMPT.length).toBeLessThan(3100);
  });
});
