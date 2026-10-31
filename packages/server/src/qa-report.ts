import { constants } from 'node:fs';
import { mkdir, open, lstat, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { projectKnowledgeDir } from './knowledge-folder.js';
import { acquireKnowledgeMutationLock } from './knowledge-mutation-lock.js';

async function pinnedDirectory(path: string) {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Unsafe document root');
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const after = await directory.stat();
  if (after.dev !== before.dev || after.ino !== before.ino) {
    await directory.close();
    throw new Error('Document root changed');
  }
  return directory;
}
/** Only server-generated reports, at server-chosen new names. No arbitrary write path. */
export async function saveQAReport(
  dataRoot: string,
  projectId: string,
  reportId: string,
  report: Record<string, unknown>,
  authorize: () => Promise<void>,
) {
  if (!/^[0-9a-f-]{36}$/.test(reportId)) throw new Error('Invalid report id');
  const root = projectKnowledgeDir(dataRoot, projectId);
  const release = await acquireKnowledgeMutationLock(root);
  try {
    await mkdir(root, { recursive: true });
    const project = await pinnedDirectory(root);
    try {
      const insights = `/proc/self/fd/${project.fd}/insights`;
      await mkdir(insights).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const directory = await pinnedDirectory(insights);
      try {
        await authorize();
        const path = `qa-baseline-${reportId}.md`;
        const temporary = `/proc/self/fd/${directory.fd}/.qa-${randomUUID()}`;
        const file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o644,
        );
        try {
          await file.writeFile(
            '# QA baseline\n\nServer-computed evidence; provider text is untrusted. Workflow outcomes do not prove deployment.\n\n' +
              JSON.stringify(report, null, 2)
                .split('\n')
                .map((line) => '    ' + line)
                .join('\n') +
              '\n',
          );
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await authorize();
          await link(temporary, `/proc/self/fd/${directory.fd}/${path}`);
          await directory.sync();
        } finally {
          await unlink(temporary);
        }
        return { projectId, path: `insights/${path}` };
      } finally {
        await directory.close();
      }
    } finally {
      await project.close();
    }
  } finally {
    release();
  }
}
