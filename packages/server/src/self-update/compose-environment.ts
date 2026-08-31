/**
 * Turns one service's Compose-rendered `environment` block into the lines of an
 * env file, and refuses anything an env file could not carry.
 *
 * The rendering itself is Docker Compose's — `docker compose config --format
 * json`, run by the live smoke's shell script — and that is deliberate rather
 * than convenient. The anchor this reads carries `${A:-${B:-literal}}`, so a
 * hand-written reader would have to reimplement Compose interpolation, and the
 * incident the drift stage exists for is precisely a DEFAULT VALUE changing
 * inside one of those. A parser that disagreed with Compose by one nesting level
 * would report drift where the host sees none, or miss the one the host hits.
 *
 * Everything here is therefore about the transport, not about the semantics:
 * Compose can render a value containing a newline and `--env-file` cannot carry
 * one, so a value like that is a refusal rather than a silently truncated
 * variable that would then look like drift.
 *
 * Split out of `self-update-live-smoke.ts` so these refusals have tests. That
 * file is a CLI whose only caller is a DinD job whose only trigger is a push to
 * main, so every refusal below used to be reachable on PRs by inspection alone.
 */

/** A name an env file can carry: what a POSIX shell would accept as a variable. */
const CARRIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Bytes an env file has no way to express inside a value. A newline ends the
 *  line, a carriage return is silently eaten or kept depending on the reader,
 *  and a NUL truncates it. */
const UNCARRIABLE_VALUE = /[\n\r\0]/;

/**
 * @param config   the parsed `docker compose config --format json` document.
 * @param service  the service whose environment block to read.
 * @param overrides `NAME=VALUE` pairs applied on top, as the caller's own facts
 *                  (a deployment id, a database URL) that Compose cannot know.
 * @returns the env file's lines, sorted by name, without a trailing newline.
 * @throws Error naming what was refused and why.
 */
export function composeEnvironmentLines(
  config: unknown,
  service: string,
  overrides: readonly string[],
): string[] {
  const services = (config as { services?: Record<string, unknown> }).services;
  const rendered = services?.[service];
  if (rendered === undefined) throw new Error(`the Compose file defines no ${service} service`);
  const block = (rendered as { environment?: Record<string, string | null> }).environment ?? {};
  const environment = new Map<string, string>();
  for (const [name, value] of Object.entries(block)) {
    // Compose renders a variable with no value and no default as `null`, and
    // passes it to the container only if the host has it. Nothing in the smoke
    // does, so it is absent — which is what the sealed source has to resolve
    // against.
    if (value === null) continue;
    environment.set(name, value);
  }
  for (const override of overrides) {
    const separator = override.indexOf('=');
    // `<= 0` and not `< 0`: an override at index 0 is `=VALUE`, an assignment to
    // the empty name, which reads as a typo rather than as an intent.
    if (separator <= 0) throw new Error(`override is not NAME=VALUE: ${override}`);
    environment.set(override.slice(0, separator), override.slice(separator + 1));
  }
  const lines: string[] = [];
  // One pass over the MERGED map, so an override is held to the same two rules
  // as a value Compose rendered. Sorted so the drift stage's line-by-line
  // comparison of two renderings sees a variable in the same place in both.
  for (const [name, value] of [...environment].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!CARRIABLE_NAME.test(name))
      throw new Error(`${service} declares an environment name a container cannot carry: ${name}`);
    if (UNCARRIABLE_VALUE.test(value))
      throw new Error(
        `${service}'s ${name} carries a newline or NUL, which an env file cannot express`,
      );
    lines.push(`${name}=${value}`);
  }
  return lines;
}
