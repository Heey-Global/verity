import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename } from 'node:fs/promises';

export const FILE_HISTORY_DIR = '.verity-file-history';

export async function openFileHistory(directory: string) {
  await mkdir(`${directory}/${FILE_HISTORY_DIR}`, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    },
  );
  return open(
    `${directory}/${FILE_HISTORY_DIR}`,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
}

/** Pending captures are restored exclusively. A completed save must never
 * resurrect a file that was intentionally deleted afterwards. */
export async function recoverFileHistory(directory: string) {
  let history;
  try {
    history = await open(
      `${directory}/${FILE_HISTORY_DIR}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const pinned = `/proc/self/fd/${history.fd}`;
    for (const name of await readdir(pinned)) {
      if (!/^save-[A-Za-z0-9]+$/.test(name)) continue;
      const transaction = await open(
        `${pinned}/${name}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const base = `/proc/self/fd/${transaction.fd}`;
        try {
          const done = await open(`${base}/complete`, constants.O_RDONLY | constants.O_NOFOLLOW);
          await done.close();
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        let metadata;
        try {
          metadata = await open(`${base}/name`, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        let source;
        try {
          if ((await metadata.stat()).size > 1024) throw new Error('invalid file recovery record');
          source = await metadata.readFile('utf8');
        } finally {
          await metadata.close();
        }
        if (
          !source ||
          source === '.' ||
          source === '..' ||
          /[\\/\0]/.test(source) ||
          source === '.git' ||
          source === FILE_HISTORY_DIR
        )
          throw new Error('invalid file recovery name');
        try {
          const originalPath = `${base}/original`;
          if ((await lstat(originalPath)).isDirectory()) {
            // Atomic directory recovery also handles a crash after rollback
            // reserved an empty destination. Nonempty directories and files
            // cannot be replaced by this directory rename.
            await rename(originalPath, `${directory}/${source}`);
          } else {
            const original = await open(
              `${base}/original`,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              if (!(await original.stat()).isFile())
                throw new Error('invalid file recovery original');
              await link(`${base}/original`, `${directory}/${source}`);
            } finally {
              await original.close();
            }
          }
        } catch (error) {
          if (
            !['ENOENT', 'EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw error;
        }
        const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
        const done = await open(
          `${base}/complete`,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await done.sync();
        await done.close();
        await transaction.sync();
      } finally {
        await transaction.close();
      }
    }
  } finally {
    await history.close();
  }
}

/** Keep private versions out of ordinary git add/commit operations. */
export async function excludeFileHistoryFromGit(root: string) {
  let excludePath: string;
  try {
    const result = await promisify(execFile)('git', [
      '-C',
      root,
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'info/exclude',
    ]);
    excludePath = result.stdout.trim();
  } catch {
    // Non-Git worktrees have no index to protect.
    return;
  }
  const file = await open(
    excludePath,
    constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const current = await file.readFile('utf8');
    if (!current.split('\n').includes(`${FILE_HISTORY_DIR}/`)) {
      await file.writeFile(`\n${FILE_HISTORY_DIR}/\n`);
      await file.sync();
    }
  } finally {
    await file.close();
  }
}

async function readSmallText(path: string, limit = 1_000_000) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error('invalid history file');
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error('history file exceeds the editing limit');
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

export async function sessionFileHistory(directory: string, source: string, version?: string) {
  let history;
  try {
    history = await open(
      `${directory}/${FILE_HISTORY_DIR}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !version) return { versions: [] };
    throw error;
  }
  try {
    const pinned = `/proc/self/fd/${history.fd}`;
    const versions: Array<{ id: string; createdAt: string; kind: string }> = [];
    const selected = version?.match(/^(save-[A-Za-z0-9]+)\/(snapshot|original)$/);
    if (version && !selected) throw new Error('invalid history version');
    for (const name of selected ? [selected[1]!] : await readdir(pinned)) {
      if (!/^save-[A-Za-z0-9]+$/.test(name)) continue;
      const transaction = await open(
        `${pinned}/${name}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const base = `/proc/self/fd/${transaction.fd}`;
        let recordedName;
        try {
          recordedName = await readSmallText(`${base}/name`, 1024);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !selected) continue;
          throw error;
        }
        if (recordedName !== source) continue;
        if (selected) return { content: await readSmallText(`${base}/${selected[2]!}`) };
        for (const kind of ['snapshot', 'original']) {
          try {
            const file = await open(`${base}/${kind}`, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const stats = await file.stat();
              if (stats.isFile() && stats.size <= 1_000_000)
                versions.push({
                  id: `${name}/${kind}`,
                  createdAt: stats.mtime.toISOString(),
                  kind,
                });
            } finally {
              await file.close();
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      } finally {
        await transaction.close();
      }
    }
    if (version) throw Object.assign(new Error('version not found'), { code: 'ENOENT' });
    return { versions: versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  } finally {
    await history.close();
  }
}
