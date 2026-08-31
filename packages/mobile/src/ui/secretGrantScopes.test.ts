import { describe, expect, it } from 'vitest';
import { secretGrantScopes } from './secretGrantScopes.js';

describe('secretGrantScopes', () => {
  it('does not offer a permanent grant', () => {
    // The server refuses `forever` there (ADR 0014 D3), so offering it would run the
    // call and then report the scope as unsaved — a choice that cannot be honoured.
    expect(secretGrantScopes('verity_http_request')).toEqual(['session', 'project']);
  });

  it('keeps every trusted-CLI action one-time only', () => {
    expect(
      secretGrantScopes('verity_secret_run', {
        command: ['/usr/local/bin/kubectl', 'get', 'pods'],
      }),
    ).toEqual([]);
  });

  it('keeps interpreter inline and module code one-time only', () => {
    expect(
      secretGrantScopes('verity_secret_run', { command: ['/bin/sh', '-c', '. ./payload.sh'] }),
    ).toEqual([]);
    expect(
      secretGrantScopes('verity_secret_run', { command: ['/usr/bin/env', 'python3', '-m', 'app'] }),
    ).toEqual([]);
    expect(
      secretGrantScopes('verity_secret_run', { command: ['/bin/sh', '-ec', '. ./payload.sh'] }),
    ).toEqual([]);
    expect(
      secretGrantScopes('verity_secret_run', {
        command: ['/usr/bin/node', '--eval=require("./payload")'],
      }),
    ).toEqual([]);
    expect(
      secretGrantScopes('verity_secret_run', {
        command: ['/usr/bin/env', '--split-string', 'sh /work/payload.sh'],
      }),
    ).toEqual([]);
    expect(
      secretGrantScopes('verity_secret_run', {
        command: ['/usr/bin/env', 'NODE_OPTIONS=--require=./payload.js', 'node'],
      }),
    ).toEqual([]);
    expect(
      secretGrantScopes('verity_secret_run', {
        command: ['/usr/bin/python3.12', '-m', 'mutable_module'],
      }),
    ).toEqual([]);
  });

  it('offers reusable scopes only for a direct hash-bound entry script', () => {
    const input = {
      secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN' }],
      command: ['/usr/bin/python3', '/work/project/deploy.py', '--apply'],
      entryScript: {
        path: '/work/project/deploy.py',
        projectPath: 'deploy.py',
        sha256: 'a'.repeat(64),
        loading: 'isolated',
      },
    };
    expect(secretGrantScopes('verity_secret_run', input)).toEqual(['session', 'project']);
    expect(
      secretGrantScopes('verity_secret_run', {
        ...input,
        entryScript: { ...input.entryScript, loading: 'dynamic' },
      }),
    ).toEqual([]);
    expect(
      secretGrantScopes('verity_secret_run', {
        ...input,
        command: ['/usr/bin/python3', '-m', 'deploy', '/work/project/deploy.py'],
      }),
    ).toEqual([]);
    expect(
      secretGrantScopes('verity_secret_run', {
        ...input,
        command: ['/opt/custom/python', '/work/project/deploy.py'],
      }),
    ).toEqual([]);
  });

  it('does not offer reusable grants for ordinary tools', () => {
    expect(secretGrantScopes('Bash')).toEqual([]);
  });

  it('offers no standing grant for the control-plane session tools', () => {
    // Asserted rather than left to the fall-through, because these two are the tools where a
    // standing grant would matter most and the fall-through is what makes them safe. The
    // server refuses the scope independently (`allowStandingGrant: false` on both calls), so
    // this is the client half of the same decision: adding a name to `gatewayToolNameSchema`
    // must not silently acquire a "don't ask again" button for a tool that writes a turn into
    // another operator's session.
    expect(secretGrantScopes('verity_session_handoff')).toEqual([]);
    expect(secretGrantScopes('verity_list_sessions')).toEqual([]);
  });

  it('offers no standing grant for the delivery tool either', () => {
    // The allowlist that made the two above un-grantable also flipped this one's
    // `allowStandingGrant` from true to false — it is the only tool on the gateway whose flag
    // the change actually altered, and it had no assertion on this side. Inert server-side,
    // since a grant is only ever consulted for a tool that resolves a secret, but the client
    // half is what stops a "don't ask again" button appearing if that ever changes.
    expect(secretGrantScopes('verity_create_delivery')).toEqual([]);
  });
});
