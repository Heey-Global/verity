import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';
import type { SecretCipher } from './crypto.js';
import { egressDestinationDb } from './egress-destination-mutation.js';
import { KnowledgeError } from './knowledge.js';
import { normalizeSetting } from './normalize-setting.js';

export interface ProjectSettingsRecord {
  /** Absent on older clients; defaults to enabled. Changing it affects the next recreation. */
  devcontainerEnabled?: boolean;
  projectId: string;
  dopplerTokenRef: string | null;
  dopplerToken: string | null;
  /** Operator-authorized Doppler binding (#320): plaintext project + config. */
  dopplerProject: string | null;
  dopplerConfig: string | null;
  /** Cached scoped read-only minted token (#320). SECRET — encrypted at rest
   *  exactly like {@link ProjectSettingsRecord.dopplerToken}. */
  dopplerMintedToken: string | null;
  /** Doppler identifier (`slug`) of {@link ProjectSettingsRecord.dopplerMintedToken}
   *  (#320 follow-up). PLAINTEXT — an opaque token identifier, not a credential;
   *  used to best-effort revoke the superseded token on rebind. */
  dopplerMintedTokenSlug: string | null;
  defaultBranch: string | null;
  defaultModel: string | null;
  /** Per-project agent memory (ADR 0008). PLAINTEXT free-text, never encrypted;
   *  injected into each session's runtime system prompt at context init. */
  memory: string | null;
  googleDriveFolderId: string | null;
  googleDriveFolderName: string | null;
  googleDriveAccessMode: 'read-only' | 'read-write';
  /** Design module: whether plans include mockups the user approves before the build. */
  designLevel: ProjectDesignLevel;
  /** One line shown under the project's name; null when none was written. */
  description: string | null;
  /** Agents sessions in this project may use; null permits every connected agent. */
  allowedAgents: ProjectAgent[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export const PROJECT_AGENTS = ['claude', 'codex', 'opencode'] as const;
export type ProjectAgent = (typeof PROJECT_AGENTS)[number];

/** An explicit default cannot be persisted outside the project's current agent rule. */
export class ProjectDefaultModelNotAllowedError extends Error {
  constructor(readonly model: string) {
    super(`Project default model ${model} is not allowed.`);
    this.name = 'ProjectDefaultModelNotAllowedError';
  }
}

type ProjectSettingsKey =
  | 'devcontainerEnabled'
  | 'dopplerTokenRef'
  | 'dopplerToken'
  | 'dopplerProject'
  | 'dopplerConfig'
  | 'dopplerMintedToken'
  | 'dopplerMintedTokenSlug'
  | 'defaultBranch'
  | 'defaultModel'
  | 'memory'
  | 'googleDriveFolderId'
  | 'googleDriveFolderName'
  | 'googleDriveAccessMode'
  | 'designLevel'
  | 'description'
  | 'allowedAgents';

/** `off`: no mockups. `on_request`: mockups when the user asks for them.
 *  `required`: every plan that changes the UI includes mockups. */
export type ProjectDesignLevel = 'off' | 'on_request' | 'required';

export type ProjectSettingsPatch = {
  [K in ProjectSettingsKey]?: ProjectSettingsRecord[K] | undefined;
};

/** Soft cap on per-project agent memory (ADR 0008), enforced in the shared store
 *  layer so BOTH write paths (operator UI full-replace and agent broker append)
 *  are bounded — otherwise a large blob would bloat every injected system prompt.
 *  A "few KB" per the ADR; an over-cap write is REJECTED (see
 *  {@link ProjectMemoryTooLargeError}), never silently truncated. */
export const PROJECT_MEMORY_MAX_CHARS = 8_000;

/** Thrown by project settings updates and memory appends
 *  when a memory write would exceed {@link PROJECT_MEMORY_MAX_CHARS}. Callers (the
 *  memory broker route, the settings API) map this to a 4xx rather than persisting
 *  a truncated blob. */
export class ProjectMemoryTooLargeError extends Error {
  constructor(
    readonly length: number,
    readonly max: number,
  ) {
    super(`project memory too large: ${length} characters exceeds the ${max}-character limit`);
    this.name = 'ProjectMemoryTooLargeError';
  }
}

/** Stores the allowed agents in canonical order; an empty or full list is unrestricted. */
function allowedAgentsColumn(value: readonly ProjectAgent[] | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const agents = PROJECT_AGENTS.filter((agent) => value.includes(agent));
  if (agents.length === 0 || agents.length === PROJECT_AGENTS.length) return null;
  return JSON.stringify(agents);
}

export class ProjectSettingsStore {
  constructor(
    private readonly rootDb: Kysely<Database>,
    private readonly cipher: SecretCipher,
    private readonly getProject: (id: string) => Promise<{ id: string } | undefined>,
  ) {}

  private get db(): Kysely<Database> {
    return egressDestinationDb(this.rootDb);
  }

  private encryptSecret(value: string | null): string | null {
    return value === null ? null : this.cipher.encrypt(value);
  }

  private decryptSecret(value: string | null): string | null {
    return value === null ? null : this.cipher.decrypt(value);
  }

  private projectSettingsRowToRecord(
    row: {
      project_id: string;
      devcontainer_enabled: boolean;
      doppler_token_ref: string | null;
      doppler_token: string | null;
      doppler_project: string | null;
      doppler_config: string | null;
      doppler_minted_token: string | null;
      doppler_minted_token_slug: string | null;
      default_branch: string | null;
      default_model: string | null;
      memory: string | null;
      google_drive_folder_id: string | null;
      google_drive_folder_name: string | null;
      google_drive_access_mode: 'read-only' | 'read-write';
      design_level: ProjectDesignLevel;
      description: string | null;
      allowed_agents: ProjectAgent[] | null;
      created_at: Date;
      updated_at: Date;
    },
    decrypt = true,
  ): ProjectSettingsRecord {
    return {
      projectId: row.project_id,
      devcontainerEnabled: row.devcontainer_enabled,
      dopplerTokenRef: row.doppler_token_ref,
      dopplerToken: decrypt ? this.decryptSecret(row.doppler_token) : row.doppler_token,
      dopplerProject: row.doppler_project,
      dopplerConfig: row.doppler_config,
      dopplerMintedToken: decrypt
        ? this.decryptSecret(row.doppler_minted_token)
        : row.doppler_minted_token,
      dopplerMintedTokenSlug: row.doppler_minted_token_slug,
      defaultBranch: row.default_branch,
      defaultModel: row.default_model,
      memory: row.memory,
      googleDriveFolderId: row.google_drive_folder_id,
      googleDriveFolderName: row.google_drive_folder_name,
      googleDriveAccessMode: row.google_drive_access_mode,
      designLevel: row.design_level,
      description: row.description,
      allowedAgents: row.allowed_agents,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private readonly projectSettingsColumns = [
    'devcontainer_enabled',
    'project_id',
    'doppler_token_ref',
    'doppler_token',
    'doppler_project',
    'doppler_config',
    'doppler_minted_token',
    'doppler_minted_token_slug',
    'default_branch',
    'default_model',
    'memory',
    'google_drive_folder_id',
    'google_drive_folder_name',
    'google_drive_access_mode',
    'design_level',
    'description',
    'allowed_agents',
    'created_at',
    'updated_at',
  ] as const;

  async getProjectSettings(projectId: string): Promise<ProjectSettingsRecord | undefined> {
    const row = await this.db
      .selectFrom('project_settings')
      .select(this.projectSettingsColumns)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return row ? this.projectSettingsRowToRecord(row) : undefined;
  }

  /** Like {@link getProjectSettings} but WITHOUT decrypting `doppler_token` —
   *  sealed-safe, for public read paths that strip it. See getVeritySettingsRaw. */
  async getProjectSettingsRaw(projectId: string): Promise<ProjectSettingsRecord | undefined> {
    const row = await this.db
      .selectFrom('project_settings')
      .select(this.projectSettingsColumns)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return row ? this.projectSettingsRowToRecord(row, false) : undefined;
  }

  async updateProjectSettings(
    projectId: string,
    patch: ProjectSettingsPatch,
  ): Promise<ProjectSettingsRecord | undefined> {
    const project = await this.getProject(projectId);
    if (project === undefined) return undefined;

    // Cap the operator UI full-replace write here (the shared store layer) so it is
    // bounded exactly like the broker append path (ADR 0008). Reject rather than
    // truncate operator-authored text.
    const memory = normalizeSetting(patch.memory);
    if (memory !== null && memory.length > PROJECT_MEMORY_MAX_CHARS) {
      throw new ProjectMemoryTooLargeError(memory.length, PROJECT_MEMORY_MAX_CHARS);
    }

    const values = {
      project_id: projectId,
      devcontainer_enabled: patch.devcontainerEnabled ?? true,
      doppler_token_ref: normalizeSetting(patch.dopplerTokenRef),
      doppler_token: this.encryptSecret(normalizeSetting(patch.dopplerToken)),
      doppler_project: normalizeSetting(patch.dopplerProject),
      doppler_config: normalizeSetting(patch.dopplerConfig),
      doppler_minted_token: this.encryptSecret(normalizeSetting(patch.dopplerMintedToken)),
      doppler_minted_token_slug: normalizeSetting(patch.dopplerMintedTokenSlug),
      default_branch: normalizeSetting(patch.defaultBranch),
      default_model: normalizeSetting(patch.defaultModel),
      memory,
      google_drive_folder_id: normalizeSetting(patch.googleDriveFolderId),
      google_drive_folder_name: normalizeSetting(patch.googleDriveFolderName),
      google_drive_access_mode: patch.googleDriveAccessMode ?? 'read-write',
      design_level: patch.designLevel ?? 'on_request',
      description: normalizeSetting(patch.description),
      allowed_agents: allowedAgentsColumn(patch.allowedAgents),
    };
    return this.db.transaction().execute(async (tx) => {
      // Ensure and lock the per-project settings row before applying the patch.
      await tx
        .insertInto('project_settings')
        .values({ project_id: projectId })
        .onConflict((oc) => oc.column('project_id').doNothing())
        .execute();
      const current = await tx
        .selectFrom('project_settings')
        .select(['project_id', 'default_model', 'allowed_agents'])
        .where('project_id', '=', projectId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      const allowedAgents =
        patch.allowedAgents === undefined
          ? current.allowed_agents
          : values.allowed_agents === null
            ? null
            : patch.allowedAgents;
      let defaultModel =
        patch.defaultModel === undefined ? current.default_model : values.default_model;
      if (defaultModel !== null && allowedAgents !== null) {
        const agent: ProjectAgent = defaultModel.startsWith('codex/')
          ? 'codex'
          : defaultModel.includes('/')
            ? 'opencode'
            : 'claude';
        if (!allowedAgents.includes(agent)) {
          if (patch.defaultModel !== undefined)
            throw new ProjectDefaultModelNotAllowedError(defaultModel);
          // The locked row prevents concurrent default and agent patches from leaving a dead default.
          defaultModel = null;
        }
      }

      const row = await tx
        .insertInto('project_settings')
        .values(values)
        .onConflict((oc) =>
          oc.column('project_id').doUpdateSet({
            ...(patch.devcontainerEnabled !== undefined
              ? { devcontainer_enabled: patch.devcontainerEnabled }
              : {}),
            ...(patch.dopplerTokenRef !== undefined
              ? { doppler_token_ref: normalizeSetting(patch.dopplerTokenRef) }
              : {}),
            ...(patch.dopplerToken !== undefined
              ? { doppler_token: this.encryptSecret(normalizeSetting(patch.dopplerToken)) }
              : {}),
            ...(patch.dopplerProject !== undefined
              ? { doppler_project: normalizeSetting(patch.dopplerProject) }
              : {}),
            ...(patch.dopplerConfig !== undefined
              ? { doppler_config: normalizeSetting(patch.dopplerConfig) }
              : {}),
            ...(patch.dopplerMintedToken !== undefined
              ? {
                  doppler_minted_token: this.encryptSecret(
                    normalizeSetting(patch.dopplerMintedToken),
                  ),
                }
              : {}),
            ...(patch.dopplerMintedTokenSlug !== undefined
              ? { doppler_minted_token_slug: normalizeSetting(patch.dopplerMintedTokenSlug) }
              : {}),
            ...(patch.defaultBranch !== undefined
              ? { default_branch: normalizeSetting(patch.defaultBranch) }
              : {}),
            ...(patch.defaultModel !== undefined || defaultModel !== current.default_model
              ? { default_model: defaultModel }
              : {}),
            ...(patch.memory !== undefined ? { memory } : {}),
            ...(patch.googleDriveFolderId !== undefined
              ? { google_drive_folder_id: normalizeSetting(patch.googleDriveFolderId) }
              : {}),
            ...(patch.googleDriveAccessMode !== undefined
              ? { google_drive_access_mode: patch.googleDriveAccessMode }
              : {}),
            ...(patch.designLevel !== undefined ? { design_level: patch.designLevel } : {}),
            ...(patch.description !== undefined
              ? { description: normalizeSetting(patch.description) }
              : {}),
            ...(patch.googleDriveFolderName !== undefined
              ? { google_drive_folder_name: normalizeSetting(patch.googleDriveFolderName) }
              : {}),
            ...(patch.allowedAgents !== undefined
              ? { allowed_agents: allowedAgentsColumn(patch.allowedAgents) }
              : {}),
            updated_at: sql`now()`,
          }),
        )
        .returning(this.projectSettingsColumns)
        .executeTakeFirst();
      if (!row) {
        throw new Error('verity: updateProjectSettings RETURNING yielded no row — dialect bug');
      }
      return this.projectSettingsRowToRecord(row);
    });
  }

  /**
   * Append a note to a project's agent memory (ADR 0008), atomically. Used by the
   * memory broker when a session calls `verity-memory append`. Serializes concurrent
   * appends from sibling sessions of the same project (they share one per-project
   * capability) by locking the settings row FOR UPDATE inside a transaction, so a
   * naive read-modify-write cannot lose an append for a project that already has a
   * settings row. Returns the updated settings (sealed-safe, no decrypt), or
   * `undefined` when the project does not exist. Throws {@link ProjectMemoryTooLargeError}
   * when the append would exceed {@link PROJECT_MEMORY_MAX_CHARS} — the note is
   * rejected, not truncated.
   */
  async appendProjectMemory(
    projectId: string,
    text: string,
  ): Promise<ProjectSettingsRecord | undefined> {
    const project = await this.getProject(projectId);
    if (project === undefined) return undefined;
    const delta = text.trim();
    // A single note larger than the cap can be rejected before touching the DB.
    if (delta.length > PROJECT_MEMORY_MAX_CHARS) {
      throw new ProjectMemoryTooLargeError(delta.length, PROJECT_MEMORY_MAX_CHARS);
    }
    return this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(1447383636, 18)`.execute(tx);
      const overview = await tx
        .selectFrom('project_knowledge_spaces')
        .select('overview_revision_id')
        .where('project_id', '=', projectId)
        .executeTakeFirst();
      if (overview?.overview_revision_id) {
        throw new KnowledgeError(
          'conflict',
          'This project uses an approved Knowledge overview. Update its Wiki page and approve the new revision in Project Settings; legacy memory was not changed.',
        );
      }

      // Ensure the settings row exists FIRST, in this transaction, so the
      // `FOR UPDATE` below always locks a committed row. `project_settings` rows
      // are created lazily, so without this two sibling sessions of a settings-less
      // project (they share one per-project capability) would both `SELECT … FOR
      // UPDATE` zero rows, lock nothing, and the second `INSERT … ON CONFLICT DO
      // UPDATE` would clobber the first append instead of concatenating. The
      // placeholder INSERT serializes them: the second blocks on the first's row
      // and then locks it. Also makes an empty-note no-op return the row (not
      // undefined) for an existing project.
      await tx
        .insertInto('project_settings')
        .values({ project_id: projectId })
        .onConflict((oc) => oc.column('project_id').doNothing())
        .execute();
      const existing = await tx
        .selectFrom('project_settings')
        .select(['memory'])
        .where('project_id', '=', projectId)
        .forUpdate()
        .executeTakeFirst();
      const current = existing?.memory ?? null;
      // Empty note → leave memory untouched (no-op append); otherwise concatenate.
      const next =
        delta.length === 0
          ? current
          : current !== null && current.length > 0
            ? `${current}\n${delta}`
            : delta;
      if (next !== null && next.length > PROJECT_MEMORY_MAX_CHARS) {
        throw new ProjectMemoryTooLargeError(next.length, PROJECT_MEMORY_MAX_CHARS);
      }
      const row = await tx
        .updateTable('project_settings')
        .set({ memory: next, updated_at: sql`now()` })
        .where('project_id', '=', projectId)
        .returning(this.projectSettingsColumns)
        .executeTakeFirst();
      if (!row) {
        throw new Error('verity: appendProjectMemory RETURNING yielded no row — dialect bug');
      }
      return this.projectSettingsRowToRecord(row, false);
    });
  }
}
