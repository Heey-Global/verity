import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BROKERED_SECRETS_PROTOCOL_VERSION,
  brokeredHttpRequestAliases,
  brokeredHttpRequestSchema,
  canonicalJson,
  executionProfileRecordSchema,
  MAX_TRUSTED_CLI_SECRETS,
  runGrantClaimsSchema,
  runGrantRedemptionSchema,
  secretCatalogItemSchema,
  secretCatalogResponseSchema,
  secretCatalogToolRequestSchema,
  secretAuditRecordSchema,
  secretEnvelopeSchema,
  secretRunRequestSchema,
  secretToolInvocationSchema,
  toolChannelSchema,
  trustedCliRequestSchema,
} from './index.js';

const hash = 'a'.repeat(64);
const profile = { id: 'staging-pods-list', version: 3, policyHash: hash };
const alias = { id: 'kubeconfig-staging', version: 2 };

describe('brokered secret catalog contracts', () => {
  it('accepts only structured trusted CLI commands with absolute executables', () => {
    expect(
      trustedCliRequestSchema.parse({
        secrets: [{ secretAlias: 'APP_STORE_CONNECT_PRIVATE_KEY', env: 'ASC_PRIVATE_KEY' }],
        command: ['/usr/local/bin/fastlane', 'deliver', '--skip-binary-upload'],
      }),
    ).toEqual({
      secrets: [{ secretAlias: 'APP_STORE_CONNECT_PRIVATE_KEY', env: 'ASC_PRIVATE_KEY' }],
      command: ['/usr/local/bin/fastlane', 'deliver', '--skip-binary-upload'],
    });
    expect(() =>
      trustedCliRequestSchema.parse({
        secrets: [{ secretAlias: 'APP_STORE_CONNECT_PRIVATE_KEY', env: 'ASC_PRIVATE_KEY' }],
        command: ['fastlane', 'deliver'],
      }),
    ).toThrow(/absolute/u);
    expect(() =>
      trustedCliRequestSchema.parse({
        secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN' }],
        command: ['/usr/bin/python3', '/work/project/commands/deploy.py'],
        entryScript: {
          path: '/work/project/commands/deploy.py',
          projectPath: 'commands/./deploy.py',
          sha256: hash,
        },
      }),
    ).toThrow(/normalized/u);
    expect(() =>
      trustedCliRequestSchema.parse({
        secrets: [{ secretAlias: 'APP_STORE_CONNECT_PRIVATE_KEY', env: 'BAD-NAME' }],
        command: ['/usr/local/bin/fastlane'],
      }),
    ).toThrow();
    expect(() =>
      trustedCliRequestSchema.parse({
        secrets: [{ secretAlias: 'APP_STORE_CONNECT_PRIVATE_KEY', env: 'LD_PRELOAD' }],
        command: ['/usr/local/bin/fastlane'],
      }),
    ).toThrow(/unsafe for privileged launch/u);
    for (const env of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'NODE_OPTIONS', 'PYTHONPATH']) {
      expect(() =>
        trustedCliRequestSchema.parse({
          secrets: [{ secretAlias: 'APP_STORE_CONNECT_PRIVATE_KEY', env }],
          command: ['/usr/local/bin/fastlane'],
        }),
      ).toThrow(/unsafe for privileged launch/u);
    }
    expect(() =>
      trustedCliRequestSchema.parse({
        secrets: [{ secretAlias: 'APP_STORE_CONNECT_PRIVATE_KEY', env: 'ASC_PRIVATE_KEY' }],
        command: ['/usr/local/bin/fastlane', 'deliver\n--skip-screenshots'],
      }),
    ).toThrow(/control characters/u);
  });
  it('carries every secret an App Store Connect JWT needs in one trusted CLI run', () => {
    const request = trustedCliRequestSchema.parse({
      secrets: [
        { secretAlias: 'ASC_API_KEY_P8', env: 'ASC_KEY_FILE', injection: 'file' },
        { secretAlias: 'ASC_API_KEY_ID', env: 'ASC_KEY_ID' },
        { secretAlias: 'ASC_API_ISSUER_ID', env: 'ASC_ISSUER_ID' },
      ],
      command: ['/usr/local/bin/fastlane', 'deliver'],
    });
    expect(request.secrets).toHaveLength(3);
    expect(request.secrets[0]?.injection).toBe('file');
    // At least one secret is still required — an empty array would launch a
    // privileged command for no reason.
    expect(() =>
      trustedCliRequestSchema.parse({ secrets: [], command: ['/usr/bin/env'] }),
    ).toThrow();
    expect(() =>
      trustedCliRequestSchema.parse({
        secrets: Array.from({ length: MAX_TRUSTED_CLI_SECRETS + 1 }, (_, index) => ({
          secretAlias: `ALIAS_${index}`,
          env: `ENV_${index}`,
        })),
        command: ['/usr/bin/env'],
      }),
    ).toThrow();
    // Two secrets under one variable name would silently drop one of them.
    expect(() =>
      trustedCliRequestSchema.parse({
        secrets: [
          { secretAlias: 'ASC_API_KEY_ID', env: 'ASC_KEY' },
          { secretAlias: 'ASC_API_ISSUER_ID', env: 'ASC_KEY' },
        ],
        command: ['/usr/bin/env'],
      }),
    ).toThrow(/duplicate environment variable ASC_KEY/u);
  });
  it('accepts only an absolute, SHA-256-attested entry script', () => {
    expect(
      trustedCliRequestSchema.parse({
        secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN' }],
        command: ['/usr/bin/python3', '/work/project/deploy.py'],
        entryScript: { path: '/work/project/deploy.py', projectPath: 'deploy.py', sha256: hash },
      }).entryScript,
    ).toEqual({
      path: '/work/project/deploy.py',
      projectPath: 'deploy.py',
      sha256: hash,
      loading: 'dynamic',
    });
    expect(() =>
      trustedCliRequestSchema.parse({
        secrets: [{ secretAlias: 'TOKEN', env: 'TOKEN' }],
        command: ['/usr/bin/python3', 'deploy.py'],
        entryScript: { path: 'deploy.py', projectPath: 'deploy.py', sha256: hash },
      }),
    ).toThrow(/absolute/u);
  });
  it('names every alias a JWT-authenticated request resolves, signing key first', () => {
    const request = brokeredHttpRequestSchema.parse({
      url: 'https://api.appstoreconnect.apple.com/v1/apps',
      secretAlias: 'ASC_API_KEY_P8',
      auth: {
        kind: 'jwt',
        algorithm: 'ES256',
        keyId: { alias: 'ASC_API_KEY_ID' },
        issuer: { alias: 'ASC_API_ISSUER_ID' },
        audience: 'appstoreconnect-v1',
      },
    });
    expect(request.auth.kind).toBe('jwt');
    // Claim sources that are genuinely public may be spelled out; ones that are
    // not are named as aliases and resolved server-side, exactly like the key.
    expect(brokeredHttpRequestAliases(request)).toEqual([
      'ASC_API_KEY_P8',
      'ASC_API_KEY_ID',
      'ASC_API_ISSUER_ID',
    ]);
    expect(
      brokeredHttpRequestAliases(
        brokeredHttpRequestSchema.parse({
          url: 'https://oauth2.googleapis.com/token',
          secretAlias: 'GOOGLE_SERVICE_ACCOUNT_KEY',
          auth: {
            kind: 'jwt',
            algorithm: 'RS256',
            issuer: { literal: 'verity@example.iam.gserviceaccount.com' },
            audience: 'https://oauth2.googleapis.com/token',
          },
        }),
      ),
    ).toEqual(['GOOGLE_SERVICE_ACCOUNT_KEY']);
    // A static request keeps its shape without spelling out a discriminator, so
    // every caller written before JWT auth existed still parses.
    const staticRequest = brokeredHttpRequestSchema.parse({
      url: 'https://api.example.com/v1/things',
      secretAlias: 'EXAMPLE_TOKEN',
      auth: { header: 'authorization', scheme: 'Bearer' },
    });
    expect(staticRequest.auth.kind).toBeUndefined();
    expect(brokeredHttpRequestAliases(staticRequest)).toEqual(['EXAMPLE_TOKEN']);
    // The scheme rule must not silently stop applying to static requests now
    // that `auth` is a union.
    expect(() =>
      brokeredHttpRequestSchema.parse({
        url: 'https://api.example.com/v1/things',
        secretAlias: 'EXAMPLE_TOKEN',
        auth: { header: 'x-api-key', scheme: 'Bearer' },
      }),
    ).toThrow();
    // An assertion that outlives the turn it was minted for is a token in all
    // but name; App Store Connect refuses more than 20 minutes anyway.
    expect(() =>
      brokeredHttpRequestSchema.parse({
        url: 'https://api.appstoreconnect.apple.com/v1/apps',
        secretAlias: 'ASC_API_KEY_P8',
        auth: {
          kind: 'jwt',
          algorithm: 'ES256',
          issuer: { alias: 'ASC_API_ISSUER_ID' },
          audience: 'appstoreconnect-v1',
          expiresInSeconds: 86_400,
        },
      }),
    ).toThrow();
    expect(() =>
      brokeredHttpRequestSchema.parse({
        url: 'https://api.appstoreconnect.apple.com/v1/apps',
        secretAlias: 'ASC_API_KEY_P8',
        auth: {
          kind: 'jwt',
          algorithm: 'HS256',
          issuer: { alias: 'ASC_API_ISSUER_ID' },
          audience: 'appstoreconnect-v1',
        },
      }),
    ).toThrow();
  });
  it('keeps every card-rendered JWT field to printable ASCII', () => {
    const jwt = (auth: Record<string, unknown>) =>
      brokeredHttpRequestSchema.parse({
        url: 'https://api.appstoreconnect.apple.com/v1/apps',
        secretAlias: 'ASC_API_KEY_P8',
        auth: {
          kind: 'jwt',
          algorithm: 'ES256',
          issuer: { alias: 'ASC_API_ISSUER_ID' },
          audience: 'appstoreconnect-v1',
          ...auth,
        },
      });
    // The agent chooses these strings and the operator approves the card built
    // from them, so anything that can make the card read differently from what
    // gets signed has to fail at the boundary rather than at the pixel.
    const deceptive = [
      // Splits the card's single sentence into what looks like two statements.
      'appstoreconnect-v1\nAudience internal-admin',
      // Same, without a line break: the card is one line of running text.
      'appstoreconnect-v1\r  Audience internal-admin',
      // U+202E reverses the display order of everything after it, so the card
      // shows an audience nobody typed. Escaped on purpose: the character is
      // invisible in this source file too.
      'appstoreconnect-v1\u202Enimda-lanretni',
      // A zero-width joiner hides the boundary between two words.
      'appstoreconnect\u200D-v1',
      // NUL truncates in anything that later hands the string to C.
      'appstoreconnect-v1\u0000',
      // A non-ASCII lookalike: Cyrillic U+043E reads as Latin o on the card.
      'appst\u043Ereconnect-v1',
    ];
    for (const value of deceptive) {
      expect(() => jwt({ audience: value }), `audience ${JSON.stringify(value)}`).toThrow();
      expect(() => jwt({ scope: value }), `scope ${JSON.stringify(value)}`).toThrow();
      expect(
        () => jwt({ issuer: { literal: value } }),
        `issuer literal ${JSON.stringify(value)}`,
      ).toThrow();
    }
    // The restriction must not cost the real values these fields carry: a Google
    // scope list is space-separated URLs, and an issuer is a service account
    // email. Both are ASCII, and both have to keep parsing.
    const google = jwt({
      audience: 'https://oauth2.googleapis.com/token',
      issuer: { literal: 'verity@example.iam.gserviceaccount.com' },
      scope:
        'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/devstorage.read_only',
    });
    expect(google.auth).toMatchObject({
      audience: 'https://oauth2.googleapis.com/token',
      scope: expect.stringContaining('devstorage.read_only'),
    });
    // An empty audience would render as a blank in the card sentence rather than
    // as an obvious omission.
    expect(() => jwt({ audience: '' })).toThrow();
    expect(() => jwt({ scope: '' })).toThrow();
  });

  it('parses a public catalog without provider source or secret value fields', () => {
    const catalog = secretCatalogResponseSchema.parse({
      protocolVersion: BROKERED_SECRETS_PROTOCOL_VERSION,
      catalogVersion: 4,
      items: [
        {
          alias,
          name: 'kubeconfig_staging',
          description: 'Read staging Kubernetes resources',
          trustMode: 'restricted',
          injection: { kind: 'file', target: 'KUBECONFIG' },
          profile,
          requiresApproval: true,
        },
      ],
    });
    expect(catalog.items[0]).not.toHaveProperty('providerKey');
    expect(catalog.items[0]).not.toHaveProperty('value');
  });

  it('rejects duplicate alias names and unknown fields', () => {
    const item = {
      alias,
      name: 'same_name',
      description: 'First',
      trustMode: 'restricted',
      injection: { kind: 'env', target: 'TOKEN' },
      profile,
      requiresApproval: false,
    } as const;
    expect(() =>
      secretCatalogResponseSchema.parse({
        protocolVersion: 1,
        catalogVersion: 1,
        items: [item, { ...item, alias: { id: 'other', version: 1 } }],
      }),
    ).toThrow(/duplicate secret alias name/);
    expect(() => secretCatalogItemSchema.parse({ ...item, unexpected: true })).toThrow();
    expect(() =>
      secretCatalogItemSchema.parse({
        ...item,
        trustMode: 'trusted',
        requiresApproval: false,
      }),
    ).toThrow();
  });

  it('requires describe to carry exactly one alias name', () => {
    expect(() =>
      secretCatalogToolRequestSchema.parse({ protocolVersion: 1, detail: 'describe' }),
    ).toThrow(/describe requires aliasName/);
    expect(() =>
      secretCatalogToolRequestSchema.parse({
        protocolVersion: 1,
        detail: 'list',
        aliasName: 'not-allowed',
      }),
    ).toThrow(/list forbids aliasName/);
  });
});

describe('model tool boundary contracts', () => {
  it('does not recognise the retired claude-native channel', () => {
    // The label named a relay on Claude's native stream-json transport, which ADR 0012
    // retired; Claude's ACP transport carries no native secret tools. Pinned rather than
    // simply deleted, because re-adding an enum member is a one-word change that reads
    // as harmless — and would hand a value back to every switch over ToolChannel with
    // no transport behind it. The two labels that remain are asserted alongside, so
    // this fails loudly if the removal ever takes a live channel with it.
    expect(toolChannelSchema.safeParse('claude-native').success).toBe(false);
    // Sorted, because declaration order carries no meaning here: pinning it would fail a
    // future channel added anywhere but last, for a reason that has nothing to do with
    // what this test is about.
    expect([...toolChannelSchema.options].sort()).toEqual(['codex-mcp', 'opencode-mcp']);
    // And at the surface a caller actually hits. The enum is reached through the
    // invocation envelope, so a composite that stopped delegating to it — a widened
    // `channel`, a `.catch()`, a passthrough object — would accept the retired label
    // while the assertions above still passed.
    const rejected = secretToolInvocationSchema.safeParse({
      context: {
        protocolVersion: 1,
        toolCallId: 'tool-call-1',
        projectId: 'owner_repo',
        sessionId: 'session-1',
        turnId: 'turn-1',
        channel: 'claude-native',
      },
      request: {
        kind: 'trusted',
        aliases: [{ alias, target: 'EXPO_TOKEN' }],
        command: ['eas', 'build'],
        snapshotId: hash,
        profile,
      },
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues.some((issue) => issue.path.includes('channel'))).toBe(true);
  });

  it('keeps trusted commands inside a gateway-stamped invocation', () => {
    const invocation = secretToolInvocationSchema.parse({
      context: {
        protocolVersion: 1,
        toolCallId: 'tool-call-1',
        projectId: 'owner_repo',
        sessionId: 'session-1',
        turnId: 'turn-1',
        channel: 'codex-mcp',
      },
      request: {
        kind: 'trusted',
        aliases: [{ alias, target: 'EXPO_TOKEN' }],
        command: ['eas', 'build', '--platform', 'ios'],
        snapshotId: hash,
        profile,
      },
    });
    expect(invocation.context.channel).toBe('codex-mcp');
  });

  it('forbids command and free argv fields on restricted calls', () => {
    expect(() =>
      secretToolInvocationSchema.parse({
        context: {
          protocolVersion: 1,
          toolCallId: 'tool-call-1',
          projectId: 'owner_repo',
          sessionId: 'session-1',
          turnId: 'turn-1',
          channel: 'codex-mcp',
        },
        request: {
          kind: 'restricted',
          profile,
          parameters: { namespace: 'preview-123' },
          snapshotId: hash,
          command: ['sh', '-c', 'env'],
        },
      }),
    ).toThrow();
  });

  it('bounds model-controlled parameter counts and string sizes', () => {
    const request = {
      kind: 'action',
      profile,
      parameters: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`p${index}`, true])),
    } as const;
    expect(() => secretRunRequestSchema.parse(request)).toThrow(/at most 64 entries/);
    expect(() =>
      secretRunRequestSchema.parse({
        ...request,
        parameters: { value: 'x'.repeat(16_385) },
      }),
    ).toThrow();
  });
});

describe('versioned execution profile and audit records', () => {
  it('requires immutable executable, policy, input, egress, and result hashes for restricted mode', () => {
    const restricted = executionProfileRecordSchema.parse({
      id: profile.id,
      projectId: 'owner_repo',
      version: profile.version,
      policyHash: hash,
      state: 'active',
      trustMode: 'restricted',
      requiresApproval: true,
      limits: {
        timeoutSeconds: 60,
        cpuMillis: 1000,
        memoryMiB: 256,
        maxProcesses: 8,
        maxOutputBytes: 1_000_000,
      },
      imageDigest: hash,
      executablePath: '/usr/local/bin/kubectl',
      executableDigest: hash,
      parameterSchemaHash: hash,
      snapshotPolicyHash: hash,
      egressPolicyHash: hash,
      resultSchemaHash: hash,
      allowDescendants: false,
    });
    expect(restricted.trustMode).toBe('restricted');
    expect(() =>
      executionProfileRecordSchema.parse({ ...restricted, executablePath: 'bin/kubectl' }),
    ).toThrow();
  });

  it('rejects secret-bearing fields from the safe audit projection', () => {
    const audit = {
      id: 'audit-1',
      projectId: 'owner_repo',
      sessionId: 'session-1',
      toolCallId: 'tool-call-1',
      requestHash: hash,
      aliases: [alias],
      providerBindings: [{ id: 'doppler-owner-repo', version: 2, provider: 'doppler' }],
      profile,
      snapshotId: hash,
      redactorVersion: 'redactor-v1',
      outcome: 'succeeded',
      cleanupState: 'complete',
      recordedAt: '2026-07-17T18:05:00Z',
    } as const;
    expect(secretAuditRecordSchema.parse(audit).outcome).toBe('succeeded');
    expect(() => secretAuditRecordSchema.parse({ ...audit, secretValue: 'nope' })).toThrow();
  });
});

describe('run grant and envelope contracts', () => {
  const grant = {
    protocolVersion: 1,
    grantId: 'grant-1',
    requestHash: hash,
    projectId: 'owner_repo',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
    profile,
    aliases: [alias],
    providerBindings: [{ id: 'doppler-owner-repo', version: 2, provider: 'doppler' }],
    snapshotId: hash,
    audience: 'verity-secret-job-executor',
    issuedAt: '2026-07-17T18:00:00Z',
    expiresAt: '2026-07-17T18:05:00Z',
    nonce: 'nonce-value-with-at-least-32-bytes',
  } as const;

  it('parses immutable, bounded grant claims and rejects duplicate aliases', () => {
    expect(runGrantClaimsSchema.parse(grant).audience).toBe('verity-secret-job-executor');
    expect(() => runGrantClaimsSchema.parse({ ...grant, aliases: [alias, alias] })).toThrow(
      /aliases must be unique/,
    );
    expect(() =>
      runGrantClaimsSchema.parse({
        ...grant,
        providerBindings: [grant.providerBindings[0], grant.providerBindings[0]],
      }),
    ).toThrow(/provider bindings must be unique/);
    expect(() =>
      runGrantClaimsSchema.parse({ ...grant, expiresAt: '2026-07-17T17:59:00Z' }),
    ).toThrow(/expire after issue/);
  });

  it('keeps the invocation channel out of the claims that get stored', () => {
    // These claims are the one part of an invocation that outlives it: `request()` writes
    // them verbatim into `secret_approvals.claims_json`. Narrowing `toolChannelSchema` is
    // only safe because no removed label can already be sitting in that column, and this is
    // what makes that true — the claims copy `projectId`/`sessionId`/`turnId`/`toolCallId`
    // off the context and stop there, so the channel never reaches the store.
    //
    // Asserted with a channel the enum still accepts: rejection has to come from the claims
    // being closed, not from the value being unrecognised.
    const channel = toolChannelSchema.parse('codex-mcp');
    // Baseline first: `.strict()` reports the extra key alongside any other issue, so a
    // fixture that had drifted out of validity would keep the rejection below true while
    // saying nothing about the channel.
    expect(runGrantClaimsSchema.safeParse(grant).success).toBe(true);
    const rejected = runGrantClaimsSchema.safeParse({ ...grant, channel });
    expect(rejected.success).toBe(false);
    // Named as the unrecognised key, so the assertion still means "the channel is what was
    // refused" if the fixture later grows a field that fails for its own reasons. A strict
    // object reports the key in `keys` and leaves `path` at the object itself, so matching
    // on the path would silently never hold.
    expect(
      rejected.error?.issues.some(
        (issue) => issue.code === 'unrecognized_keys' && issue.keys.includes('channel'),
      ),
    ).toBe(true);
  });

  it('binds redemption to the authenticated workload job', () => {
    const redemption = {
      protocolVersion: 1,
      grantId: 'grant-1',
      jobId: 'job-1',
      requestHash: hash,
      workload: {
        executorInstanceId: 'executor-1',
        jobId: 'job-2',
        publicKeyId: 'workload-key-1',
        attestationHash: hash,
      },
    };
    expect(() => runGrantRedemptionSchema.parse(redemption)).toThrow(/job identity mismatch/);
  });

  it('accepts only the negotiated envelope algorithm and rejects plaintext fields', () => {
    const envelope = {
      protocolVersion: 1,
      envelopeId: 'envelope-1',
      grantId: 'grant-1',
      jobId: 'job-1',
      recipientKeyId: 'workload-key-1',
      algorithm: 'x25519-hkdf-sha256-aes-256-gcm',
      ephemeralPublicKey: 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=',
      nonce: 'QUFBQUFBQUFBQUFB',
      aadHash: hash,
      ciphertext: 'Y2lwaGVydGV4dA==',
      expiresAt: '2026-07-17T18:05:00Z',
    } as const;
    expect(secretEnvelopeSchema.parse(envelope).algorithm).toContain('aes-256-gcm');
    expect(() => secretEnvelopeSchema.parse({ ...envelope, plaintext: 'secret' })).toThrow();
    expect(() =>
      secretEnvelopeSchema.parse({ ...envelope, ephemeralPublicKey: 'QUFBQQ==' }),
    ).toThrow(/exactly 32 bytes/);
    expect(() => secretEnvelopeSchema.parse({ ...envelope, nonce: 'bm9uY2U=' })).toThrow(
      /exactly 12 bytes/,
    );
  });

  it('canonicalizes object keys before hashing or signing', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(canonicalJson({ required: 1, optional: undefined })).toBe('{"required":1}');
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
  });

  // A model sees the generated JSON Schema and nothing else. Any rule missing
  // from it is one an agent can only discover by being refused — and a refused
  // agent works around the rule rather than reaching for the feature that
  // replaces it, which is how wrapper scripts kept being written instead of
  // `injection: 'file'`.
  it('documents the rules an agent would otherwise learn from a refusal', () => {
    const cli = z.toJSONSchema(trustedCliRequestSchema, { target: 'draft-7' }) as {
      properties: Record<
        string,
        { description?: string; items?: { properties: Record<string, { description?: string }> } }
      >;
    };
    for (const field of ['secrets', 'command']) {
      expect(cli.properties[field]?.description ?? '').not.toBe('');
    }
    const secret = cli.properties['secrets']?.items?.properties ?? {};
    for (const field of ['secretAlias', 'env', 'injection']) {
      expect(secret[field]?.description ?? '').not.toBe('');
    }
    expect(cli.properties['command']?.description).toMatch(/root-owned/);
    expect(secret['injection']?.description).toMatch(/file/);
    // The confusion this exists to prevent: the alias is a lookup key, `env` is
    // what the program reads, and the two are routinely different names.
    expect(secret['secretAlias']?.description).toMatch(/not the variable/);
    // Nothing tells an agent that one run may carry several secrets except this
    // description — and an agent that believes otherwise invents a combined alias.
    expect(cli.properties['secrets']?.description).toMatch(/Every secret this one command needs/);

    const http = z.toJSONSchema(brokeredHttpRequestSchema, { target: 'draft-7' }) as {
      properties: Record<string, { description?: string }>;
    };
    for (const field of ['url', 'secretAlias', 'auth']) {
      expect(http.properties[field]?.description ?? '').not.toBe('');
    }
    // Signing happens server-side; an agent that misses this injects the private
    // key into a CLI instead, which is the whole thing brokerage exists to avoid.
    expect(http.properties['auth']?.description).toMatch(/never leaves the server/);
    expect(http.properties['secretAlias']?.description).toMatch(/PRIVATE KEY/);
  });
});
