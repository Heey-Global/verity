import { z } from 'zod';
import {
  brokeredSecretsProtocolVersionSchema,
  positiveVersionSchema,
  secretContractIdSchema,
  sha256HexSchema,
} from './common.js';
import { executionProfileRefSchema, secretAliasRefSchema } from './catalog.js';

/**
 * The attested native relays a brokered-secret tool call can arrive on — the ones where
 * the call rides the same channel the turn runs on, so the server knows the model made it.
 *
 * A label here is a recognized protocol name, not a shipped capability: runtime support
 * takes an independently registered flag (W3/W4 §4.2), and only `codex-mcp` currently has
 * one.
 *
 * `claude-native` sat here on that same footing and no longer does — the asymmetry is the
 * transport, not the binding. It named a relay on Claude's native stream-json transport,
 * which ADR 0012 retired, and Claude's ACP transport deliberately carries no native secret
 * tools. Reserving a name for a transport that no longer exists reserves nothing; it only
 * invites a switch arm for a value nothing can produce. An attested Claude relay, should
 * one ever be built, would be built on ACP and would want a name that says so.
 *
 * `opencode-mcp` is the one label kept that nothing produces. It named a relay on
 * OpenCode's own `opencode serve` HTTP protocol, and ADR 0012 Amendment 4 retired that
 * transport too — but unlike `claude-native` it is a name a relay could still be built
 * under: OpenCode's ACP transport advertises `mcpCapabilities.http`, so the MCP server
 * the label refers to is reachable there, and only the Verity-side decision to admit
 * OpenCode to the gateway is missing (`ACP_WORKER_BACKENDS`). Should that relay be built,
 * this is the name it wants and the schema already accepts it.
 */
export const toolChannelSchema = z.enum(['codex-mcp', 'opencode-mcp']);
export type ToolChannel = z.infer<typeof toolChannelSchema>;

export const toolInvocationContextSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    toolCallId: secretContractIdSchema,
    projectId: secretContractIdSchema,
    sessionId: secretContractIdSchema,
    turnId: secretContractIdSchema,
    channel: toolChannelSchema,
  })
  .strict();
export type ToolInvocationContext = z.infer<typeof toolInvocationContextSchema>;

const trustedSecretUseSchema = z
  .object({ alias: secretAliasRefSchema, target: z.string().min(1).max(128) })
  .strict();

const toolParameterScalarSchema = z.union([
  z.string().max(16_384),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const toolParametersSchema = z
  .record(z.string().min(1).max(128), toolParameterScalarSchema)
  .superRefine((parameters, ctx) => {
    if (Object.keys(parameters).length > 64) {
      ctx.addIssue({ code: 'custom', message: 'parameters may contain at most 64 entries' });
    }
  });

export const trustedSecretRunRequestSchema = z
  .object({
    kind: z.literal('trusted'),
    aliases: z.array(trustedSecretUseSchema).min(1).max(16),
    command: z.array(z.string().max(16_384)).min(1).max(256),
    snapshotId: sha256HexSchema,
    profile: executionProfileRefSchema,
  })
  .strict();
export type TrustedSecretRunRequest = z.infer<typeof trustedSecretRunRequestSchema>;

export const restrictedSecretRunRequestSchema = z
  .object({
    kind: z.literal('restricted'),
    profile: executionProfileRefSchema,
    parameters: toolParametersSchema,
    snapshotId: sha256HexSchema,
  })
  .strict();
export type RestrictedSecretRunRequest = z.infer<typeof restrictedSecretRunRequestSchema>;

export const actionSecretRunRequestSchema = z
  .object({
    kind: z.literal('action'),
    profile: executionProfileRefSchema,
    parameters: toolParametersSchema,
  })
  .strict();
export type ActionSecretRunRequest = z.infer<typeof actionSecretRunRequestSchema>;

export const secretRunRequestSchema = z.discriminatedUnion('kind', [
  trustedSecretRunRequestSchema,
  restrictedSecretRunRequestSchema,
  actionSecretRunRequestSchema,
]);
export type SecretRunRequest = z.infer<typeof secretRunRequestSchema>;

/** Trusted gateway envelope. The model supplies `request`; Verity stamps `context`. */
export const secretToolInvocationSchema = z
  .object({ context: toolInvocationContextSchema, request: secretRunRequestSchema })
  .strict();
export type SecretToolInvocation = z.infer<typeof secretToolInvocationSchema>;

const brokeredSecretAliasSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

/**
 * Printable ASCII, no control characters and nothing outside it.
 *
 * Every field held to this is rendered verbatim on the approval card, and the
 * card is the only thing standing between the agent and a signed assertion. A
 * newline breaks the card's sentence into what looks like separate statements;
 * a bidi control such as U+202E reverses the display order of everything after
 * it, so the audience read aloud from the screen is not the audience being
 * signed. The agent picks these strings, so the only safe reading is that it
 * will pick the worst one that validates.
 *
 * ASCII is not a hardship here: these are JWT header and claim values — an
 * audience like `appstoreconnect-v1`, an OAuth scope list, a service account
 * email — which the APIs themselves specify in ASCII.
 */
const CARD_SAFE_TEXT = /^[\x20-\x7e]+$/;
const cardSafeText = (max: number) =>
  z.string().min(1).max(max).regex(CARD_SAFE_TEXT, {
    message:
      'must be printable ASCII: this value is shown verbatim on the approval card, where a control or bidi character can misrepresent what is being signed',
  });

/**
 * A JWT header or claim value the agent cannot supply itself.
 *
 * App Store Connect wants its key id and issuer id alongside the signing key,
 * and all three live in Doppler — which the agent cannot read. `alias` resolves
 * one server-side exactly like the signing key; `literal` is for the values that
 * really are public (`aud`, a scope string). Both spellings are visible on the
 * approval card, and an `alias` value is redacted from the response like every
 * other resolved secret.
 */
export const brokeredJwtValueSchema = z.union([
  z
    .object({ alias: brokeredSecretAliasSchema })
    .strict()
    .describe("Resolve this claim from the project's Doppler config, server-side."),
  z
    .object({ literal: cardSafeText(256) })
    .strict()
    .describe('A value that is genuinely public, spelled out here.'),
]);
export type BrokeredJwtValue = z.infer<typeof brokeredJwtValueSchema>;

/** `authorization: <scheme> <value>` or `x-api-key: <value>` — the secret IS the credential. */
const brokeredStaticAuthSchema = z
  .object({
    kind: z.literal('static').optional(),
    header: z.enum(['authorization', 'x-api-key']),
    scheme: z.enum(['Bearer', 'Basic']).nullable(),
  })
  .strict();

/**
 * Lifetime used when the caller names none. Exported because the standing-grant
 * target hashes this field: without a shared default, an omitted lifetime and an
 * explicit `600` would describe the same assertion under two different targets,
 * and a grant kept for one would not answer the other.
 */
export const BROKERED_JWT_DEFAULT_LIFETIME_SECONDS = 600;

/**
 * `authorization: Bearer <JWT>`, where Verity mints and signs the JWT server-side
 * with the private key named by `secretAlias`.
 *
 * This exists because a whole class of APIs — App Store Connect, Google service
 * accounts, Snowflake — authenticates with a short-lived assertion rather than a
 * static token. Without it the only route is to inject the private key into the
 * Sandbox and have some CLI sign there, which is strictly worse: the key leaves
 * the server for a credential that Verity can mint without it ever doing so.
 */
const brokeredJwtAuthSchema = z
  .object({
    kind: z.literal('jwt'),
    algorithm: z
      .enum(['ES256', 'RS256'])
      .describe(
        'Must match the key named by `secretAlias`: ES256 for an EC P-256 key (App Store Connect .p8), RS256 for an RSA key (Google service account).',
      ),
    keyId: brokeredJwtValueSchema
      .optional()
      .describe('JWT header `kid`. App Store Connect calls this the Key ID.'),
    issuer: brokeredJwtValueSchema.describe(
      'Claim `iss`. App Store Connect calls this the Issuer ID; Google uses the service account email.',
    ),
    audience: cardSafeText(256).describe(
      'Claim `aud` — `appstoreconnect-v1` for App Store Connect.',
    ),
    subject: brokeredJwtValueSchema.optional().describe('Claim `sub`, when the API wants one.'),
    scope: cardSafeText(1024).optional().describe('Claim `scope`, when the API wants one.'),
    expiresInSeconds: z
      .number()
      .int()
      .min(60)
      .max(1200)
      .default(BROKERED_JWT_DEFAULT_LIFETIME_SECONDS)
      .describe('Lifetime of the minted assertion. App Store Connect rejects more than 1200.'),
  })
  .strict();

/** Model-supplied HTTP request. Verity adds project/turn identity and resolves the named secret. */
export const brokeredHttpRequestSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    url: z
      .url()
      .max(4096)
      .describe(
        'Full HTTPS URL including query string. Its host is what approval is asked for, and a kept grant covers that host only.',
      ),
    secretAlias: brokeredSecretAliasSchema.describe(
      'The secret\'s name in the project\'s Doppler config — never its value, and never a variable name you invented. Verity resolves it server-side; you never see it. With `auth.kind: "jwt"` this names the PRIVATE KEY that signs the assertion.',
    ),
    auth: z
      .union([brokeredStaticAuthSchema, brokeredJwtAuthSchema])
      .describe(
        'How the secret authenticates the request. Default (`static`): the secret IS the credential — `authorization` requires a scheme (`Bearer`/`Basic`), `x-api-key` requires `scheme: null`. ' +
          'With `kind: "jwt"` the secret is a private key and Verity signs a short-lived JWT with it, sending `authorization: Bearer <JWT>`. The key never leaves the server.',
      ),
    body: z.json().optional().describe('JSON body. GET and DELETE must omit it.'),
  })
  .strict()
  .superRefine((request, ctx) => {
    const authority = request.url.slice('https://'.length).split('/', 1)[0] ?? '';
    if (
      !request.url.startsWith('https://') ||
      request.url.includes('#') ||
      authority.includes('@') ||
      authority.includes(':')
    ) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'URL must be public HTTPS' });
    }
    if ((request.method === 'GET' || request.method === 'DELETE') && request.body !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: `${request.method} forbids a body` });
    }
    if (
      request.auth.kind !== 'jwt' &&
      (request.auth.header === 'authorization') !== (request.auth.scheme !== null)
    ) {
      ctx.addIssue({ code: 'custom', path: ['auth'], message: 'invalid auth scheme' });
    }
  });
export type BrokeredHttpRequest = z.infer<typeof brokeredHttpRequestSchema>;
export type BrokeredJwtAuth = z.infer<typeof brokeredJwtAuthSchema>;

/**
 * Every alias one request resolves, in a stable order: the signing key first, then
 * each JWT claim taken from Doppler. Callers need this for two things that must not
 * drift apart — resolving the values, and redacting all of them from the response.
 */
export function brokeredHttpRequestAliases(request: BrokeredHttpRequest): readonly string[] {
  const aliases = [request.secretAlias];
  if (request.auth.kind === 'jwt') {
    for (const value of [request.auth.keyId, request.auth.issuer, request.auth.subject]) {
      if (value !== undefined && 'alias' in value && !aliases.includes(value.alias)) {
        aliases.push(value.alias);
      }
    }
  }
  return aliases;
}

const trustedCliEnvNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(128)
  .refine(
    (name) =>
      !/^(?:LD_|MALLOC_)/u.test(name) &&
      !new Set([
        'GCONV_PATH',
        'GETCONF_DIR',
        'GLIBC_TUNABLES',
        'HOME',
        'HOSTALIASES',
        'LANG',
        'LOGNAME',
        'LOCALDOMAIN',
        'LOCPATH',
        'NLSPATH',
        'NODE_OPTIONS',
        'NODE_PATH',
        'PATH',
        'PERL5LIB',
        'PERL5OPT',
        'PYTHONPATH',
        'PYTHONSTARTUP',
        'RUBYLIB',
        'RUBYOPT',
        'BASH_ENV',
        'ENV',
        'JAVA_TOOL_OPTIONS',
        'JDK_JAVA_OPTIONS',
        '_JAVA_OPTIONS',
        'RES_OPTIONS',
        'TMPDIR',
        'TZDIR',
        'USER',
      ]).has(name),
    { message: 'environment variable name is unsafe for privileged launch' },
  );

/**
 * Where a trusted CLI run receives its secret.
 *
 * `env` puts the value in the variable named by `env`.
 *
 * `file` writes the value to a file Verity owns and puts that file's PATH in the
 * same variable. Without this, every tool that wants its secret as a file —
 * `example-cli` reading EXAMPLE_CONFIG, `example-cli up --secret=file:…` — is
 * unreachable: there is no shell to redirect with, and writing the file from a
 * script in the worktree is refused outright, because the executable must be
 * root-owned and immutable. Agents faced with that dead end reach for a wrapper,
 * which is exactly what the ownership rule exists to prevent. Verity writing the
 * file removes the reason to try.
 *
 * The path is fixed at `/run/verity-runner/secrets/<env>`, so an argument that
 * must name it (`--secret=file:/run/verity-runner/secrets/EXAMPLE_TOKEN`) can be
 * written without Verity substituting anything into argv.
 */
const trustedCliInjectionSchema = z.enum(['env', 'file']);

/** One secret and where the command receives it. */
export const trustedCliSecretSchema = z
  .object({
    secretAlias: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .describe(
        "The secret's name in the project's Doppler config. This is a lookup key, not the variable the program reads — those are often different, and `env` is what the program reads.",
      ),
    env: trustedCliEnvNameSchema.describe(
      'The environment variable the program reads. With `injection: "file"` it holds the path to the secret file rather than the value.',
    ),
    /** Absent means `env`: every caller written before file injection existed. */
    injection: trustedCliInjectionSchema
      .optional()
      .describe(
        'Default `env`: the variable holds the value. Use `file` when the program wants a file — Verity writes it to /run/verity-runner/secrets/<env> and puts that path in the variable. Do not write such a file yourself: no shell runs here, and a script you wrote is not a valid executable for this tool.',
      ),
  })
  .strict();
export type TrustedCliSecret = z.infer<typeof trustedCliSecretSchema>;

/** One run may carry this many secrets. Real multi-credential CLIs need three or
 * four; the cap exists so a single approval card stays readable. */
export const MAX_TRUSTED_CLI_SECRETS = 8;

/** A mutable worktree script whose exact bytes are part of the approval. */
export const trustedCliEntryScriptSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => path.startsWith('/'), { message: 'entry-script path must be absolute' })
      .describe('Absolute worktree path passed to the root-owned interpreter.'),
    projectPath: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (path) =>
          !path.startsWith('/') &&
          path
            .split('/')
            .every((component) => component !== '' && component !== '.' && component !== '..'),
        { message: 'project path must be normalized and relative' },
      )
      .describe('Project-relative entry path used to bind grants across session worktrees.'),
    sha256: sha256HexSchema.describe(
      'SHA-256 of the entry script bytes. Verity verifies it again immediately before launch.',
    ),
    loading: z
      .enum(['isolated', 'dynamic'])
      .default('dynamic')
      .describe(
        '`isolated` requires a system interpreter under /bin or /usr, denies reads from mutable worktree files, and permits reusable approval. `dynamic` keeps worktree loading available and therefore always requires one-time approval.',
      ),
  })
  .strict();
export type TrustedCliEntryScript = z.infer<typeof trustedCliEntryScriptSchema>;

/**
 * Model-supplied trusted CLI request (ADR 0011 D4). Verity resolves each named
 * project secret and injects it into the requested environment variable — as the
 * value, or as the path to a file holding it. The executable and every argument
 * remain separate tokens: shell strings are intentionally outside this contract.
 *
 * Several secrets per run is not a convenience. A CLI that authenticates with a
 * key id, an issuer id and a private key needs all three in one process, and no
 * sequence of single-secret runs composes into that. The alternative agents reach
 * for — one combined JSON alias, split at runtime — duplicates the credential in
 * the secret store and needs a splitter that the root-owned-executable rule
 * refuses anyway.
 */
export const trustedCliRequestSchema = z
  .object({
    secrets: z
      .array(trustedCliSecretSchema)
      .min(1)
      .max(MAX_TRUSTED_CLI_SECRETS)
      .describe(
        'Every secret this one command needs, each with the environment variable that carries it. Two entries may not name the same variable.',
      ),
    command: z
      .array(
        z
          .string()
          .min(1)
          .max(16_384)
          .refine(
            (token) =>
              [...token].every((character) => {
                const codePoint = character.codePointAt(0)!;
                return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
              }),
            { message: 'command tokens must not contain control characters' },
          ),
      )
      .min(1)
      .max(256)
      .refine((command) => command[0]?.startsWith('/') === true, {
        message: 'command executable must be absolute',
      })
      .describe(
        'Executable and arguments as separate tokens — ["/usr/bin/example-cli", "get", "items"], never one string. ' +
          'No shell runs, so "$VAR", quotes, pipes, redirects and globs reach the program literally; to pass the ' +
          'secret write the variable name the program itself expands, or use `injection: "file"`. ' +
          'The executable must be root-owned and not group- or world-writable, which rules out anything you wrote ' +
          'in the worktree — including via /bin/sh, `env` or `timeout`, whose own argument is checked the same way.',
      ),
    entryScript: trustedCliEntryScriptSchema
      .optional()
      .describe(
        'For a worktree script invoked by a root-owned interpreter, name the exact script, SHA-256, and loading mode approved by the user. Use `isolated` only when the script needs no mutable worktree reads; it is the sole reusable form. Use `dynamic` when it imports, sources, or reads worktree files; it always requires one-time approval. Omit for ordinary installed CLIs and inline/eval/stdin invocations.',
      ),
  })
  .strict()
  .superRefine((request, ctx) => {
    // Two entries sharing a variable would leave which value wins to object-key
    // order, and under `injection: "file"` they would collide on one path in
    // TRUSTED_CLI_SECRET_DIR — where the broker writes with `wx` and the second
    // write fails mid-run. Reject it here, where the message can still say why.
    const seen = new Set<string>();
    for (const [index, secret] of request.secrets.entries()) {
      if (seen.has(secret.env)) {
        ctx.addIssue({
          code: 'custom',
          path: ['secrets', index, 'env'],
          message: `duplicate environment variable ${secret.env}`,
        });
      }
      seen.add(secret.env);
    }
  });
export type TrustedCliRequest = z.infer<typeof trustedCliRequestSchema>;

/**
 * The model-facing descriptions of the two brokered tools, next to the schemas they
 * describe. Every channel that declares these tools — currently the
 * loopback MCP gateway an ACP session reaches — presents the same text, because the text
 * is what the model plans against: a channel whose wording drifted would teach a
 * different tool than the one Verity approves and executes.
 */
export const BROKERED_HTTP_TOOL_DESCRIPTION =
  'Make an HTTPS request using a named Doppler secret. Prefer this over `verity_secret_run` whenever the target speaks HTTP — including APIs that would otherwise require a local CLI — because the secret then never enters the Sandbox at all. ' +
  'Verity shows the exact destination, request, and secret name for approval. The approved host receives the secret; you receive the HTTP status and the response body with the secret value redacted. ' +
  'Non-2xx statuses are returned as results, not errors. ' +
  'When the API authenticates with a signed assertion rather than a static token — App Store Connect, a Google service account — use `auth.kind: "jwt"`: `secretAlias` then names the private key and Verity mints the JWT server-side. ' +
  'Claims the agent cannot know, such as an App Store Connect key id or issuer id, are named as `{"alias": "..."}` and resolved server-side too.';

export const TRUSTED_CLI_TOOL_DESCRIPTION =
  'Run one trusted CLI command with named Doppler secrets injected into environment variables — or into files whose paths those variables hold, via `injection: "file"`. ' +
  'This is the only way to give a program a project secret: reading it yourself through Bash or the Doppler CLI is not available to you. ' +
  'List every secret the command needs in `secrets`; a CLI that wants a key id, an issuer id and a private key gets all three from one call. Do not ask for a combined JSON alias and do not try to split one. ' +
  'There is no implicit shell. The executable and each argument are separate tokens, and the executable must be an installed root-owned program. A worktree entry script is allowed only when `entryScript` names its absolute path, SHA-256, and loading mode; Verity shows and verifies them. Use `loading: "isolated"` only when the script needs no mutable worktree files; Verity denies those reads and may reuse approval. Use `loading: "dynamic"` for imports, sourced files, and other worktree reads; it always requires one-time approval. Inline eval, stdin, and modules are also one-time only. ' +
  'With `injection: "file"` Verity writes the secret to /run/verity-runner/secrets/<env>; because nothing expands `$VAR`, the argument has to spell that path out in full, in whichever form the tool takes. ' +
  'Verity shows the exact command, every environment variable, and every secret name for approval. The command can read or disclose the secrets; output redaction is hygiene only.';

export const secretCatalogToolRequestSchema = z
  .object({
    protocolVersion: brokeredSecretsProtocolVersionSchema,
    detail: z.enum(['list', 'describe']),
    aliasName: secretContractIdSchema.optional(),
    knownCatalogVersion: positiveVersionSchema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.detail === 'describe' && request.aliasName === undefined) {
      ctx.addIssue({ code: 'custom', path: ['aliasName'], message: 'describe requires aliasName' });
    }
    if (request.detail === 'list' && request.aliasName !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['aliasName'], message: 'list forbids aliasName' });
    }
  });
export type SecretCatalogToolRequest = z.infer<typeof secretCatalogToolRequestSchema>;
