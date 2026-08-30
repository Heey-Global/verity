import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { AttachmentUpload } from '@verity/events';
type FileAttachment = AttachmentUpload & {
  kind: 'file';
  fileName: string;
  mediaType: string;
  data: string;
};

/**
 * Result of materializing a turn's `file`-kind attachments to disk.
 *
 * File attachments (PDFs, docs, csv, …) can't be shown to a vision model inline the
 * way images are, and each backend consumes input differently. So — uniformly for
 * every backend — we write the bytes to a real file in the agent's working directory
 * and tell the agent (in the prompt) where to find them; it reads them with its own
 * tools. Images are left untouched: they keep their inline path (Claude image block /
 * Codex `--image`), so {@link imageAttachments} carries only the image-kind uploads
 * for the backend to handle as before.
 */
export interface MaterializedFileAttachments {
  /** Text to append to the turn prompt naming the on-disk files; '' when none. */
  promptSuffix: string;
  /** The image-kind uploads (backend still delivers these inline); undefined if none. */
  imageAttachments: AttachmentUpload[] | undefined;
  /** Remove the materialized files. Safe to call once, after the turn settles. */
  cleanup: () => Promise<void>;
}

/** Reduce a picked file name to a safe basename: strip any path components and
 * replace anything outside a conservative set so an attachment can never escape the
 * scratch dir or inject a path. Empty/degenerate names fall back to `file`. */
function safeFileName(name: string): string {
  const base = basename(name)
    .replace(/[^\w.\- ]+/g, '_')
    .trim();
  return base.length > 0 ? base : 'file';
}

/** Disambiguate a name against ones already used in the same batch, inserting the
 * index before the extension (`report.pdf` → `report-1.pdf`). */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  let i = 1;
  let candidate: string;
  do {
    candidate =
      dot > 0 ? `${name.slice(0, dot)}-${String(i)}${name.slice(dot)}` : `${name}-${String(i)}`;
    i += 1;
  } while (used.has(candidate));
  used.add(candidate);
  return candidate;
}

/**
 * Write every `file`-kind attachment into a fresh scratch dir inside the Runner-visible worktree and build
 * the prompt suffix that points the agent at them. Image-kind attachments pass
 * through untouched in {@link MaterializedFileAttachments.imageAttachments}.
 *
 * The scratch dir is `.verity-attachments-*` (mirrors the codex image-scratch
 * convention) and is removed by {@link MaterializedFileAttachments.cleanup} after
 * the turn — the files only need to exist while the agent runs.
 */
export async function materializeFileAttachments(
  cwd: string,
  attachments: readonly AttachmentUpload[] | undefined,
): Promise<MaterializedFileAttachments> {
  const images = (attachments ?? []).filter((a) => a.kind === 'image');
  const files = (attachments ?? []).filter(
    (a): a is FileAttachment => a.kind === 'file' && typeof a.fileName === 'string',
  );
  const imageAttachments = images.length > 0 ? images : undefined;
  if (files.length === 0) {
    return { promptSuffix: '', imageAttachments, cleanup: () => Promise.resolve() };
  }

  // The Runner sees the worktree bind, not the Server container's /tmp. Keep
  // the fresh, non-followed directory inside that shared boundary so the path
  // placed in the prompt denotes the same bytes in both processes.
  // `.verity-sessions` is the repository's checked-in ignored runtime boundary,
  // so a routine `git add -A` cannot capture user attachments while the Runner
  // still sees them through the worktree mount.
  const cwdHandle = await open(
    cwd,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let parent = cwdHandle;
  try {
    for (const component of ['.verity-sessions', 'attachments']) {
      const base = `/proc/self/fd/${parent.fd}`;
      await mkdir(join(base, component), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const child = await open(
        join(base, component),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (parent !== cwdHandle) await parent.close();
      parent = child;
    }
    const created = await mkdtemp(join(`/proc/self/fd/${parent.fd}`, 'turn-'));
    const dir = join(cwd, '.verity-sessions', 'attachments', basename(created));
    const cleanupPath = join(`/proc/self/fd/${parent.fd}`, basename(created));
    const result = await materializeIntoDirectory(
      created,
      dir,
      files,
      imageAttachments,
      async () => {
        try {
          await rm(cleanupPath, { recursive: true, force: true });
        } finally {
          await parent.close().catch(() => undefined);
          await cwdHandle.close().catch(() => undefined);
        }
      },
    );
    return result;
  } catch (error) {
    if (parent !== cwdHandle) await parent.close().catch(() => undefined);
    await cwdHandle.close().catch(() => undefined);
    throw error;
  }
}

async function materializeIntoDirectory(
  storageDir: string,
  visibleDir: string,
  files: readonly FileAttachment[],
  imageAttachments: AttachmentUpload[] | undefined,
  cleanup: () => Promise<void>,
): Promise<MaterializedFileAttachments> {
  try {
    const used = new Set<string>();
    const lines: string[] = [];
    for (const f of files) {
      const name = uniqueName(safeFileName(f.fileName), used);
      await writeFile(join(storageDir, name), Buffer.from(f.data, 'base64'), { mode: 0o600 });
      lines.push(`- ${join(visibleDir, name)} (${f.mediaType})`);
    }
    const promptSuffix =
      '\n\nThe user attached the following file(s), saved in temporary files in the worktree. ' +
      `Read them as needed:\n${lines.join('\n')}`;
    return {
      promptSuffix,
      imageAttachments,
      cleanup,
    };
  } catch (error) {
    await rm(storageDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
