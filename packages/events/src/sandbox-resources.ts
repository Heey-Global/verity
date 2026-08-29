/**
 * The "this container has a hard ceiling" directive. Every Verity project
 * sandbox is cgroup-limited (`VERITY_SANDBOX_MEMORY` and `VERITY_SANDBOX_CPUS`
 * in `deploy/docker-compose.yml`), and sessions
 * routinely push Node and test-runner concurrency past it: a
 * `--max-old-space-size=6144` heap cap inside a 4 GiB cgroup, a `--maxWorkers=3`
 * that overrides the value the repository deliberately checked in. Every number
 * in this comment describes one sandbox as it was observed, not the configured
 * default: the defaults are overridable per deployment, so restating them here
 * would only create a second place to go stale. The prompt itself names none.
 * V8 only
 * collects hard as it approaches its own cap, so a cap above the cgroup makes
 * the kernel OOM kill arrive *first* — the flag meant to prevent the crash
 * causes it.
 *
 * The sibling `VERITY_SANDBOX_PIDS_LIMIT` is deliberately absent from the text:
 * hitting it yields `EAGAIN` on fork rather than a kill, and none of the advice
 * below would help.
 *
 * The text names neither a ceiling nor a safe fraction of one. Those defaults are
 * overridable per deployment, so "4 GiB" told to a sandbox capped at 2 would
 * license the heap cap this exists to forbid; and the container is shared, so two
 * sessions each taking a "safe" two thirds is 133% of the cgroup — the failure
 * this prevents, reached by both of them obeying it. It points at the cgroup
 * files instead, which are container-scoped rather than the host's.
 *
 * Measurements behind the claims above, taken from a project sandbox on
 * 2026-08-19 and re-checked by nothing since — read them as an observation of
 * that day, not a guarantee: `/proc/self/cgroup` read `0::/` with `memory.max`
 * the sandbox's limit rather than the host's 16 GiB; Node 24.19.0 reported
 * `heap_size_limit` 2240 MiB against that 4096 MiB cgroup and a 15907 MiB host,
 * i.e. libuv finds `memory.max` and V8 sizes its default from it; and
 * `memory.oom.group` was 0, so the kernel kills one process rather than the
 * container — which is why a sandbox accumulates `oom_kill` events while staying
 * up. The victim is the worst `oom_score`, which is RSS-derived; the prompt says
 * "largest process" as the actionable simplification, and what survives it is
 * that the victim is chosen by size, not by blame.
 *
 * Two consequences for the text. Because the default heap is already
 * cgroup-sized, `--max-old-space-size=6144` is not a session compensating for a
 * host-sized default but one overriding a correct value — the stronger argument,
 * and the one the fragment makes. And the fallback asks libuv before it gives up:
 * `node -p 'process.constrainedMemory()'` returns what libuv found (quoted
 * because bash eats the bare parentheses; measured here as the
 * sandbox's 4 GiB exactly, 0 when it found nothing), and libuv looks in more
 * places than the one path the text can afford to name — cgroup v1 in
 * particular. It is not a superset: libuv reads the leaf cgroup, so a limit set
 * on a parent and hidden by a namespace is invisible to both, which is why the
 * text claims only that Node *sometimes* finds one this path does not.
 * That turns the branch that used to be pure conservatism into a second
 * measurement, and it is what keeps the fragment honest on a host where nothing
 * limits the container at all: only when both readings come back empty does it
 * fall through to advice that costs something.
 *
 * cgroup v1 is routed to that fallback rather than given paths of its own: naming
 * `memory/memory.limit_in_bytes` immediately owes v1's huge "no limit" sentinel
 * and v1 spellings for `memory.stat` and `cpu.max` further down — a few hundred
 * characters on every turn of every session, to serve a host Verity does not run.
 * libuv reads v1's `memory.limit_in_bytes` too, so the fallback's first step is
 * expected to answer there — expected, not measured: everything above was
 * observed on v2, and no v1 host was available to check. The text therefore
 * leans on the give-up branch rather than on that expectation, and adds the one
 * v1 detail that would corrupt an answer instead of merely withholding it: with
 * no limit set, v1's file holds a near-`UINT64_MAX` sentinel rather than a
 * spelling of "unlimited", so an unguarded reading would hand the session an
 * exabyte "ceiling" and bullet 1's `ceiling - anon` would license any heap cap
 * at all. Hence "non-zero and not absurd", which costs one clause and is correct
 * whether or not libuv normalises the sentinel itself.
 * The routing is only safe because the fallback instructs rather than shrugs, and
 * because what it instructs is reachable without the files it just declared
 * unreadable: it does not send the session to the sizing rule in the first
 * bullet, which subtracts `anon` in `memory.stat` from a ceiling this branch does
 * not have. It sizes from below instead — the smallest cap the run finishes
 * under, raised only on an abort — which needs no ceiling and cannot overshoot
 * one it cannot see. That it permits a cap at all is deliberate, and follows from
 * the prompt's own harm model rather than from preference: V8's abort takes the
 * process that overran and names it, while the kernel's kill takes whatever is
 * largest, which may be a neighbouring session or the container's init. Where the
 * ceiling is invisible Node's default may be host-sized, so forbidding a
 * conservative cap there would leave the worse of the two failures as the only
 * one available.
 *
 * This belongs in the runtime prompt rather than a repository's `AGENTS.md` for
 * the reason `LANGUAGE_SYSTEM_PROMPT` (`./language.ts`) gives: the constraint is
 * a property of every Verity sandbox regardless of repository, and a checked-in
 * doc competes with the per-turn runtime prompt. It is also one of the few
 * directives whose failure mode is *cross-session*, which is why it is re-sent on
 * resumed turns too rather than only when a context is created. That premise is
 * not hypothetical: sessions share one project container (many `.verity-sessions/
 * agent-*` worktrees against a single cgroup), and the incident behind this
 * fragment was one session's `--max-old-space-size=6144` and another's
 * `--maxWorkers=3` in that same 4 GiB.
 *
 * Kept short: it rides on every context init and every resumed turn.
 */
export const SANDBOX_RESOURCES_SYSTEM_PROMPT = `# Sandbox resource limits (Verity)

This session runs in a container under a hard memory limit and a CPU quota, and other agent sessions may share it. Exceeding it is not recoverable: the kernel OOM killer kills the largest process in the container — as easily a neighbour's work as the turn that overcommitted, and the container itself when the victim is its init process. Before setting a heap cap or changing concurrency, read the ceiling from \`/sys/fs/cgroup/memory.max\`. If it is missing or reads \`max\` — cgroup v1, a limit set on a parent, or genuinely no limit — ask Node, which sometimes finds a limit this path does not: \`node -p 'process.constrainedMemory()'\` reports what it found, in bytes, and 0 (or nothing, before Node 22) when it found none. Use that ceiling if it is non-zero and not absurd — an exabyte-scale figure is a no-limit sentinel, not a limit — and leave Node's default heap alone, since it is already sized from it. If it is empty, 0, or that sentinel, nothing readable bounds this container: keep memory-heavy work small and its concurrency minimal, and size any heap cap from below — the smallest the run can finish under, raised only when it aborts, since an abort you caused is local and names what overran, while the kernel's kill is neither and may land on another session.

- Never set \`NODE_OPTIONS=--max-old-space-size=<MiB>\`, or any equivalent heap cap, at or above that ceiling: V8 collects hard only as it nears its cap, so a cap the cgroup cannot honour invites the OOM kill it was meant to prevent — and Node will usually have sized its default heap from that same ceiling already, so raising it trades a value the cgroup can honour for one it cannot. If you must set one, size it against the room actually left — the ceiling minus \`anon\` in \`/sys/fs/cgroup/memory.stat\`, since \`memory.current\` counts reclaimable cache and sits near the limit after any build — and stay well below even that: headroom for the other sessions, and for the RSS the kernel counts but this flag does not bound. Mind the units: the flag takes MiB, the cgroup files report bytes.
- When a run exhausts memory, scope it down — fewer files, one package, one test file — or lower its concurrency. Never raise the heap instead.
- Never raise parallelism (\`maxWorkers\`, \`-j\`, \`--parallel\`) above what the repository checked in — treat it as an upper bound, not a target: it was tuned for CI or a laptop, not for this cgroup. Where it configured none, do not trust the tool's default either: those derive from the host's core count, not this container's quota in \`/sys/fs/cgroup/cpu.max\` (a quota and a period in microseconds, not a worker count: quota divided by period is the core budget, rounded down, and a leading \`max\` means no quota is set, so the CPU ceiling is out of view here too). Lowering is always allowed, and under memory pressure usually right.`;
