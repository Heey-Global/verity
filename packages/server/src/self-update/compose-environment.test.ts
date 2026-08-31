import { describe, expect, it } from 'vitest';

import { composeEnvironmentLines } from './compose-environment.js';

/** A `docker compose config --format json` document, cut down to the one key
 *  this reads. Written as a literal rather than produced by Compose because the
 *  point of these cases is what the reader does with a block, not what Compose
 *  renders — the live smoke covers the second. */
function document(environment: Record<string, string | null>): unknown {
  return { services: { 'verity-updater': { image: 'ghcr.io/example@sha256:0', environment } } };
}

describe('composeEnvironmentLines', () => {
  it('renders a service block as sorted NAME=VALUE lines', () => {
    // Sorted, because the drift stage compares two renderings line by line: an
    // order that followed Compose's would report every variable as moved the
    // first time a Compose file grew a key in the middle.
    expect(
      composeEnvironmentLines(
        document({ ZULU: 'last', ALPHA: 'first', MIKE: 'middle' }),
        'verity-updater',
        [],
      ),
    ).toEqual(['ALPHA=first', 'MIKE=middle', 'ZULU=last']);
  });

  it('drops a variable Compose rendered as null', () => {
    // `FOO:` with no value and no default renders as null: Compose passes it to
    // the container only if the HOST has it, and the smoke's host has nothing.
    // Writing `FOO=` instead would hand the container an empty string, which is
    // a different value from absent and would read as drift the first time the
    // sealed source resolved the variable itself.
    expect(
      composeEnvironmentLines(document({ KEPT: 'yes', ABSENT: null }), 'verity-updater', []),
    ).toEqual(['KEPT=yes']);
  });

  it('lets an override replace a rendered value and add an unrendered one', () => {
    expect(
      composeEnvironmentLines(document({ DATABASE_URL: 'postgres://compose' }), 'verity-updater', [
        'DATABASE_URL=postgres://caller',
        'VERITY_MANAGED_DEPLOYMENT_ID=live-smoke-drift',
      ]),
    ).toEqual(['DATABASE_URL=postgres://caller', 'VERITY_MANAGED_DEPLOYMENT_ID=live-smoke-drift']);
  });

  it('lets an override supply the value Compose left null', () => {
    expect(
      composeEnvironmentLines(document({ VERITY_SERVER_IMAGE: null }), 'verity-updater', [
        'VERITY_SERVER_IMAGE=ghcr.io/example@sha256:1',
      ]),
    ).toEqual(['VERITY_SERVER_IMAGE=ghcr.io/example@sha256:1']);
  });

  it('splits an override on its FIRST equals, so a value may contain more', () => {
    // Every real override the shell script passes is a URL or a digest, and both
    // carry `=` in query strings and in `sha256=`-style parameters.
    expect(
      composeEnvironmentLines(document({}), 'verity-updater', [
        'DATABASE_URL=postgres://h/db?opts=a=b',
        'EMPTY=',
      ]),
    ).toEqual(['DATABASE_URL=postgres://h/db?opts=a=b', 'EMPTY=']);
  });

  it('renders a service that declares no environment block at all', () => {
    expect(
      composeEnvironmentLines({ services: { 'verity-updater': {} } }, 'verity-updater', []),
    ).toEqual([]);
  });

  describe('refusals', () => {
    it('refuses a service the Compose document does not define', () => {
      // The stage names its service on the command line, so a renamed service is
      // a silent no-op unless this throws: an empty env file would start the
      // Updater with none of its configuration and blame the container.
      expect(() => composeEnvironmentLines(document({ A: 'b' }), 'verity-server', [])).toThrow(
        'the Compose file defines no verity-server service',
      );
    });

    it('refuses a document with no services at all', () => {
      expect(() => composeEnvironmentLines({}, 'verity-updater', [])).toThrow(
        'the Compose file defines no verity-updater service',
      );
    });

    it('refuses an override that carries no equals', () => {
      expect(() =>
        composeEnvironmentLines(document({}), 'verity-updater', ['VERITY_SERVER_IMAGE']),
      ).toThrow('override is not NAME=VALUE: VERITY_SERVER_IMAGE');
    });

    it('refuses an override that assigns to the empty name', () => {
      // `=value` is `indexOf('=') === 0`, which a `< 0` test would wave through
      // as a variable with no name.
      expect(() => composeEnvironmentLines(document({}), 'verity-updater', ['=orphan'])).toThrow(
        'override is not NAME=VALUE: =orphan',
      );
    });

    it.each([
      ['a hyphen', 'VERITY-SERVER-IMAGE'],
      ['a leading digit', '2FA_SECRET'],
      ['a space', 'VERITY SERVER'],
      ['a dot', 'verity.server'],
      ['nothing at all', ''],
    ])('refuses a rendered name containing %s', (_case, name) => {
      expect(() =>
        composeEnvironmentLines(document({ [name]: 'v' }), 'verity-updater', []),
      ).toThrow(`verity-updater declares an environment name a container cannot carry: ${name}`);
    });

    it('holds an override name to the same rule as a rendered one', () => {
      // Overrides are merged before the check rather than after, so the caller's
      // own arguments cannot slip a name past it.
      expect(() =>
        composeEnvironmentLines(document({}), 'verity-updater', ['not a name=v']),
      ).toThrow('verity-updater declares an environment name a container cannot carry: not a name');
    });

    it.each([
      ['a newline', 'first\nsecond'],
      ['a carriage return', 'first\rsecond'],
      ['a NUL', 'first\0second'],
    ])('refuses a rendered value containing %s', (_case, value) => {
      // `--env-file` reads a line at a time: a newline would silently become a
      // second, malformed variable, and a NUL would truncate the value. Either
      // one reaches the container as something other than what Compose rendered,
      // which the drift stage would then report as a change in the release.
      expect(() =>
        composeEnvironmentLines(document({ VERITY_MOTD: value }), 'verity-updater', []),
      ).toThrow(
        "verity-updater's VERITY_MOTD carries a newline or NUL, which an env file cannot express",
      );
    });

    it('holds an override value to the same rule as a rendered one', () => {
      expect(() =>
        composeEnvironmentLines(document({}), 'verity-updater', ['VERITY_MOTD=first\nsecond']),
      ).toThrow(
        "verity-updater's VERITY_MOTD carries a newline or NUL, which an env file cannot express",
      );
    });

    it('accepts the characters next to the refused ones', () => {
      // The value rule refuses three control characters and nothing else: a tab,
      // a quote, a `$`, and a `#` all survive `--env-file` verbatim, and a rule
      // that refused them would turn a legitimate Compose default into a red
      // stage nobody could fix.
      expect(
        composeEnvironmentLines(
          document({ TABBED: 'a\tb', QUOTED: '"a b"', SHELLY: '$HOME #1', TRAILING: 'a ' }),
          'verity-updater',
          [],
        ),
      ).toEqual(['QUOTED="a b"', 'SHELLY=$HOME #1', 'TABBED=a\tb', 'TRAILING=a ']);
    });
  });
});
