import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const hash = (/** @type {string | Uint8Array} */ bytes) =>
  createHash('sha256').update(bytes).digest('hex');

/** The paused UI state is an absent, explicitly visible project, not a runtime state. */
export const contentProjects = [
  { id: 'recovery-project', name: 'project', state: 'active', archived: false, hidden: false },
  { id: 'recovery-sleeping', name: 'sleeping', state: 'sleeping', archived: false, hidden: false },
  { id: 'recovery-paused', name: 'paused', state: 'absent', archived: false, hidden: false },
  { id: 'recovery-retained', name: 'retained', state: 'absent', archived: true, hidden: true },
];

/** @typedef {{files: {path:string, sha256:string}[], git:{path:string, head:string}[], sessions:{session_id:string, project_id:string, worktree:string}[], projects:{id:string,archived:boolean,hidden:boolean}[], attachments:{hash:string,media_type:string,sha256:string}[], revisions:{id:string,document_id:string,body_markdown:string}[], originals:{revision_id:string,filename:string,sha256:string}[]}} ExpectedContent */

/** Seed deterministic expectations before capture, independently of snapshot manifests.
 * @param {string} root
 * @param {Pick<import('pg').Pool, 'query'>} database
 * @returns {Promise<ExpectedContent>}
 */
export async function seedRestoreContent(root, database) {
  /** @type {ExpectedContent} */
  const expected = {
    files: [],
    git: [],
    sessions: [],
    projects: [],
    attachments: [],
    revisions: [],
    originals: [],
  };
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Recovery acceptance',
    GIT_COMMITTER_NAME: 'Recovery acceptance',
    GIT_AUTHOR_EMAIL: 'recovery@example.invalid',
    GIT_COMMITTER_EMAIL: 'recovery@example.invalid',
  };
  /** @param {string} path @param {string | Buffer} bytes */
  const file = async (path, bytes) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
    expected.files.push({ path, sha256: hash(bytes) });
  };
  for (const project of contentProjects) {
    const workspace = `workspaces/${project.name}`;
    await file(`${workspace}/tracked`, `Git history for ${project.id}`);
    await exec('git', ['init', join(root, workspace)], { env });
    await exec('git', ['-C', join(root, workspace), 'add', '.'], { env });
    await exec('git', ['-C', join(root, workspace), 'commit', '-m', 'Recovery fixture'], { env });
    const head = (
      await exec('git', ['-C', join(root, workspace), 'rev-parse', 'HEAD'], { env })
    ).stdout.trim();
    expected.git.push({ path: workspace, head });
    await file(`${workspace}/.env`, `synthetic private data for ${project.id}`);
    await database.query(
      "INSERT INTO projects(id,owner,repo,clone_dir,container_name,state,kind,archived,hidden_at,overview_visible) VALUES ($1,'fixture',$2,$2,$3,$4,'local',$5,$6,true)",
      [
        project.id,
        project.name,
        `old-${project.name}`,
        project.state,
        project.archived,
        project.hidden ? '2025-01-01T00:00:00Z' : null,
      ],
    );
    expected.projects.push({ id: project.id, archived: project.archived, hidden: project.hidden });
    for (const suffix of ['session', 'second']) {
      const worktree = `sessions/${project.name}/${suffix}`;
      const sessionId =
        project.name === 'project' && suffix === 'session'
          ? 'recovery-session'
          : `${project.id}-${suffix}`;
      await mkdir(dirname(join(root, worktree)), { recursive: true });
      await exec(
        'git',
        ['-C', join(root, workspace), 'worktree', 'add', '-b', suffix, join(root, worktree)],
        { env },
      );
      expected.git.push({ path: worktree, head });
      await file(`${worktree}/uncommitted`, `Uncommitted ${sessionId}`);
      await database.query(
        "INSERT INTO sessions(session_id,worktree,model,project_id) VALUES ($1,$2,'fixture',$3)",
        [sessionId, join(root, worktree), project.id],
      );
      expected.sessions.push({ session_id: sessionId, project_id: project.id, worktree });
      const bytes = Buffer.from([0, 255, 137, ...Buffer.from(sessionId)]);
      const digest = hash(bytes);
      await database.query(
        "INSERT INTO attachments(hash,media_type,bytes) VALUES ($1,'image/png',$2)",
        [digest, bytes],
      );
      await database.query(
        "INSERT INTO events(session_id,type,payload) VALUES ($1,'prompt',$2::jsonb)",
        [
          sessionId,
          JSON.stringify({
            t: 'prompt',
            text: `Durable ${sessionId}`,
            attachments: [{ kind: 'image', mediaType: 'image/png', id: digest }],
          }),
        ],
      );
      expected.attachments.push({ hash: digest, media_type: 'image/png', sha256: digest });
    }
    await file(`knowledge/${project.id}/overview.md`, `Overview ${project.id}`);
    await file(
      `knowledge/${project.id}/sources/documents/original.bin`,
      Buffer.from([0, 255, ...Buffer.from(project.id)]),
    );
    await file(`knowledge/${project.id}/insights/conclusion.md`, `Conclusion ${project.id}`);
    await file(
      `knowledge/${project.id}/.text/sources/documents/original.bin.md`,
      `Extracted ${project.id}`,
    );
    const folder = `${project.id}-sources`;
    const document = `${project.id}-document`;
    await database.query('INSERT INTO knowledge_folders(id,name) VALUES ($1,$2)', [
      folder,
      `${project.name} recovery sources`,
    ]);
    await database.query(
      "INSERT INTO knowledge_documents(id,folder_id,title) VALUES ($1,$2,'Versioned recovery source')",
      [document, folder],
    );
    for (const version of [1, 2]) {
      const revision = `${document}-v${version}`;
      const body = `Revision ${version} for ${project.id}`;
      await database.query(
        "INSERT INTO knowledge_document_revisions(id,document_id,title,body_markdown,author_identity,project_id,session_id) VALUES ($1,$2,'Versioned recovery source',$3,'recovery-fixture',$4,$5)",
        [revision, document, body, project.id, expected.sessions.at(-1)?.session_id],
      );
      expected.revisions.push({ id: revision, document_id: document, body_markdown: body });
      const bytes = Buffer.from([0, 255, version, ...Buffer.from(document)]);
      const digest = hash(bytes);
      await database.query(
        "INSERT INTO knowledge_source_revisions(revision_id,filename,media_type,bytes,sha256,processing_state,processing_note,locators,previews) VALUES ($1,'original.bin','application/octet-stream',$2,$3,'ready','fixture','[]','[]')",
        [revision, bytes, digest],
      );
      expected.originals.push({ revision_id: revision, filename: 'original.bin', sha256: digest });
    }
    await database.query('UPDATE knowledge_documents SET current_revision_id=$1 WHERE id=$2', [
      `${document}-v2`,
      document,
    ]);
  }
  await file('knowledge/shared/sources/documents/general.bin', Buffer.from([0, 1, 255, 42]));
  await file('knowledge/shared/insights/general.md', 'Shared recovery knowledge');
  return expected;
}

/** Verify every seeded worktree and file using expectations created before capture.
 * @param {string} root @param {ExpectedContent} expected
 */
export async function assertRestoredFiles(root, expected) {
  for (const file of expected.files)
    assert.equal(
      hash(await readFile(join(root, file.path))),
      file.sha256,
      `Restored file ${file.path}`,
    );
  for (const repository of expected.git) {
    const options = ['-c', 'safe.directory=*', '-C', join(root, repository.path)];
    assert.equal(
      (await exec('git', [...options, 'rev-parse', 'HEAD'])).stdout.trim(),
      repository.head,
      `Restored Git ${repository.path}`,
    );
    await exec('git', [...options, 'status', '--porcelain']);
  }
}

/** @param {Pick<import('pg').Pool, 'query'>} database @param {string} liveRoot @param {ExpectedContent} expected @param {{runtimeProjectId?:string}} options */
export async function assertRestoredDatabaseContent(database, liveRoot, expected, options = {}) {
  const runtimeId = options.runtimeProjectId ?? null;
  if (runtimeId !== null)
    assert.deepEqual(
      (await database.query('SELECT id,state,kind FROM projects WHERE id=$1', [runtimeId])).rows,
      [{ id: runtimeId, state: 'active', kind: 'control_plane' }],
    );
  assert.deepEqual(
    (
      await database.query(
        'SELECT id,archived,(hidden_at IS NOT NULL) AS hidden FROM projects WHERE ($1::text IS NULL OR id <> $1) ORDER BY id',
        [runtimeId],
      )
    ).rows,
    [...expected.projects].sort((a, b) => a.id.localeCompare(b.id)),
  );
  const states = /** @type {{n:number}[]} */ (
    (
      await database.query(
        "SELECT count(*)::int AS n FROM projects WHERE state <> 'absent' AND ($1::text IS NULL OR id <> $1)",
        [runtimeId],
      )
    ).rows
  );
  assert.equal(states[0]?.n, 0);
  assert.deepEqual(
    (
      await database.query(
        'SELECT session_id,project_id,worktree FROM sessions ORDER BY session_id',
      )
    ).rows,
    expected.sessions
      .map((row) => ({ ...row, worktree: join(liveRoot, row.worktree) }))
      .sort((a, b) => a.session_id.localeCompare(b.session_id)),
  );
  const attachments = /** @type {{hash:string,media_type:string,bytes:Buffer}[]} */ (
    (await database.query('SELECT hash,media_type,bytes FROM attachments ORDER BY hash')).rows
  );
  assert.deepEqual(
    attachments.map((row) => ({
      hash: row.hash,
      media_type: row.media_type,
      sha256: hash(row.bytes),
    })),
    [...expected.attachments].sort((a, b) => a.hash.localeCompare(b.hash)),
  );
  const prompts = /** @type {{session_id:string,payload:unknown}[]} */ (
    (
      await database.query(
        "SELECT session_id,payload FROM events WHERE type='prompt' ORDER BY session_id",
      )
    ).rows
  );
  assert.deepEqual(
    prompts.map((row) => ({ session_id: row.session_id, payload: row.payload })),
    expected.sessions
      .map((session, index) => ({
        session_id: session.session_id,
        payload: {
          t: 'prompt',
          text: `Durable ${session.session_id}`,
          attachments: [
            { kind: 'image', mediaType: 'image/png', id: expected.attachments[index]?.hash },
          ],
        },
      }))
      .sort((a, b) => a.session_id.localeCompare(b.session_id)),
  );
  assert.deepEqual(
    (
      await database.query(
        'SELECT id,document_id,body_markdown FROM knowledge_document_revisions ORDER BY id',
      )
    ).rows,
    [...expected.revisions].sort((a, b) => a.id.localeCompare(b.id)),
  );
  const originals =
    /** @type {{revision_id:string,filename:string,sha256:string,bytes:Buffer}[]} */ (
      (
        await database.query(
          'SELECT revision_id,filename,sha256,bytes FROM knowledge_source_revisions ORDER BY revision_id',
        )
      ).rows
    );
  assert.deepEqual(
    originals.map((row) => ({
      revision_id: row.revision_id,
      filename: row.filename,
      sha256: hash(row.bytes),
    })),
    [...expected.originals].sort((a, b) => a.revision_id.localeCompare(b.revision_id)),
  );
  for (const row of originals) assert.equal(row.sha256, hash(row.bytes));
  assert.deepEqual(
    (await database.query('SELECT id,current_revision_id FROM knowledge_documents ORDER BY id'))
      .rows,
    expected.projects
      .map((project) => ({
        id: `${project.id}-document`,
        current_revision_id: `${project.id}-document-v2`,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}
