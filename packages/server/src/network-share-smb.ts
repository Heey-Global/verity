// SMB3 access to a network share through Samba's `smbclient`. Every session
// demands transport encryption (`--client-protection=encrypt`), so a server
// that cannot encrypt is refused rather than spoken to in the clear. The
// password reaches smbclient through its environment, never its arguments.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const NETWORK_SHARE_MAX_FILE_BYTES = 10_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const STATUS = /\b(NT_STATUS_[A-Z0-9_]+)\b/;

export interface SmbTarget {
  host: string;
  port: number | null;
  share: string;
  username: string;
  password: Buffer;
}

export interface NetworkShareEntry {
  name: string;
  kind: 'folder' | 'file';
  size: number;
}

export interface NetworkShareFileInfo {
  kind: 'folder' | 'file';
  size: number;
  /** A digest of the file's bytes; see {@link contentVersion}. */
  version: string;
}

export type NetworkShareErrorCode =
  | 'unreachable'
  | 'sign_in_failed'
  | 'encryption_unavailable'
  | 'share_not_found'
  | 'not_found'
  | 'already_exists'
  | 'access_denied'
  | 'conflict'
  | 'too_large'
  | 'not_a_file'
  | 'timeout'
  | 'restore_failed'
  | 'failed';

const MESSAGES: Record<NetworkShareErrorCode, string> = {
  unreachable:
    'The Verity server cannot reach the NAS. Check the address and that it is on the same network or VPN.',
  sign_in_failed: 'The NAS rejected the username or password.',
  encryption_unavailable:
    'The NAS does not offer SMB3 encryption. Enable SMB3 and encryption on the NAS.',
  share_not_found: 'The NAS has no shared folder with this name.',
  not_found: 'No such file or folder.',
  already_exists: 'A file with this name already exists.',
  access_denied: 'The NAS account may not do this here.',
  conflict: 'The file changed on the share since it was read. Read it again before writing.',
  too_large: `Files on network shares are limited to ${NETWORK_SHARE_MAX_FILE_BYTES / 1_000_000} MB.`,
  not_a_file: 'This is a folder, not a file.',
  timeout: 'The NAS did not answer in time.',
  restore_failed:
    'The file changed during the write and could not be put back automatically. The previous version is kept next to it under a hidden .verity-….old name.',
  failed: 'The network share operation failed.',
};

export class NetworkShareError extends Error {
  constructor(
    readonly code: NetworkShareErrorCode,
    /** The raw NT status, for logs only; never shown to agents. */
    readonly status?: string,
  ) {
    super(MESSAGES[code]);
    this.name = 'NetworkShareError';
  }
}

function errorFor(status: string): NetworkShareError {
  const code: NetworkShareErrorCode =
    status === 'NT_STATUS_LOGON_FAILURE' ||
    status === 'NT_STATUS_WRONG_PASSWORD' ||
    status === 'NT_STATUS_ACCOUNT_DISABLED'
      ? 'sign_in_failed'
      : status === 'NT_STATUS_BAD_NETWORK_NAME'
        ? 'share_not_found'
        : status === 'NT_STATUS_OBJECT_NAME_NOT_FOUND' ||
            status === 'NT_STATUS_OBJECT_PATH_NOT_FOUND' ||
            status === 'NT_STATUS_NO_SUCH_FILE' ||
            status === 'NT_STATUS_NOT_FOUND'
          ? 'not_found'
          : status === 'NT_STATUS_OBJECT_NAME_COLLISION'
            ? 'already_exists'
            : status === 'NT_STATUS_ACCESS_DENIED' || status === 'NT_STATUS_MEDIA_WRITE_PROTECTED'
              ? 'access_denied'
              : status === 'NT_STATUS_FILE_IS_A_DIRECTORY'
                ? 'not_a_file'
                : status === 'NT_STATUS_HOST_UNREACHABLE' ||
                    status === 'NT_STATUS_CONNECTION_REFUSED' ||
                    status === 'NT_STATUS_IO_TIMEOUT' ||
                    status === 'NT_STATUS_UNSUCCESSFUL' ||
                    status === 'NT_STATUS_NETWORK_UNREACHABLE' ||
                    status === 'NT_STATUS_CONNECTION_RESET' ||
                    status === 'NT_STATUS_CONNECTION_DISCONNECTED' ||
                    status === 'NT_STATUS_INVALID_NETWORK_RESPONSE'
                  ? 'unreachable'
                  : status === 'NT_STATUS_NOT_SUPPORTED' ||
                      status === 'NT_STATUS_ACCESS_DENIED_ENCRYPTION' ||
                      status === 'NT_STATUS_INVALID_PARAMETER_MIX'
                    ? 'encryption_unavailable'
                    : 'failed';
  return new NetworkShareError(code, status);
}

/** The smbclient form of a share path: `\`-separated, quoted. Names never contain `"` or newlines. */
function remote(path: string): string {
  if (/["\r\n]/.test(path)) throw new NetworkShareError('failed');
  return `"\\${path.split('/').filter(Boolean).join('\\')}"`;
}

export interface SmbClientOptions {
  /** The smbclient binary; tests point it at a Samba build of their own. */
  binary?: string;
  /** Extra environment, for library paths of a non-system Samba. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Runs one smbclient process with `commands` on stdin and returns each
 * command's output. smbclient flushes output only as it reads further input,
 * so the commands go in as one batch; a lookup of a name that cannot exist
 * follows each command, and its error line marks where that output ends.
 * With `-E` every message, NT status errors included, is on stderr.
 */
async function runBatch(
  target: SmbTarget,
  commands: readonly string[],
  options: SmbClientOptions,
  configDir: string,
): Promise<string[]> {
  const mark = `.verity-mark-${randomUUID()}`;
  const input = commands
    .map((command, index) => `${command}\nallinfo "\\${mark}-${index}"\n`)
    .join('');
  const args = [
    '--configfile',
    join(configDir, 'smb.conf'),
    `//${target.host}/${target.share}`,
    ...(target.port === null ? [] : ['--port', String(target.port)]),
    '--client-protection=encrypt',
    '-E',
  ];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(options.binary ?? 'smbclient', args, {
      env: {
        PATH: process.env.PATH,
        ...options.env,
        USER: target.username,
        PASSWD: target.password.toString('utf8'),
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let text = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      text += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new NetworkShareError('failed', 'spawn'));
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) reject(new NetworkShareError('timeout'));
      else resolve(text);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${input}quit\n`);
  });
  const outputs: string[] = [];
  let current: string[] = [];
  for (const line of output.split('\n')) {
    if (line.includes(mark)) {
      outputs.push(current.join('\n'));
      current = [];
    } else current.push(line);
  }
  if (outputs.length < commands.length) {
    // The session ended early: no connection, sign-in or encryption. smbclient
    // reports a server without encryption in words, not as an NT status.
    // Only what followed the last completed command explains the end; the
    // markers before it carry their own not-found status.
    const ending = current.join('\n');
    if (/doesn't support SMB3 encryption|encryption required/i.test(ending))
      throw new NetworkShareError('encryption_unavailable');
    const status = STATUS.exec(ending)?.[1];
    throw status ? errorFor(status) : new NetworkShareError('unreachable');
  }
  return outputs;
}

/** The NT status a command's output reports, if any. */
function statusOf(output: string | undefined): NetworkShareError | undefined {
  if (output === undefined) return undefined;
  // A listed file may be named like a status; only smbclient's own messages count.
  const messages = output
    .split('\n')
    .filter((line) => !LS_LINE.test(line))
    .join('\n');
  const status = STATUS.exec(messages)?.[1];
  return status ? errorFor(status) : undefined;
}

function succeeded(output: string | undefined): string {
  const error = statusOf(output);
  if (error) throw error;
  return output ?? '';
}

const LS_LINE = /^ {2}(.+?)\s+([A-Z]*)\s+(\d+)\s+\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/;

export function parseListing(output: string): NetworkShareEntry[] {
  const entries: NetworkShareEntry[] = [];
  for (const line of output.split('\n')) {
    const match = LS_LINE.exec(line);
    if (!match) continue;
    const [, name, attributes, size] = match;
    if (name === '.' || name === '..') continue;
    // Hidden and system entries (#recycle, @eaDir, desktop.ini) are NAS plumbing.
    if (attributes!.includes('H') || attributes!.includes('S')) continue;
    entries.push({
      name: name!,
      kind: attributes!.includes('D') ? 'folder' : 'file',
      size: Number(size),
    });
  }
  return entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
  );
}

export function parseInfo(output: string): { kind: 'folder' | 'file'; size: number } {
  const attributes = Number.parseInt(/^attributes:.*\((\w+)\)/m.exec(output)?.[1] ?? '0', 16);
  const kind = (attributes & 0x10) !== 0 ? 'folder' : 'file';
  const stream = /^stream: \[::\$DATA\], (\d+) bytes/m.exec(output)?.[1];
  // A file without a reported data stream has an unknown size: treat it as
  // too large rather than download something unbounded.
  const size = stream !== undefined ? Number(stream) : kind === 'folder' ? 0 : Infinity;
  return { kind, size };
}

/** Network share operations against one target, each step one encrypted smbclient run. */
export class SmbClient {
  constructor(private readonly options: SmbClientOptions = {}) {}

  private async batches<T>(
    work: (
      run: (target: SmbTarget, commands: readonly string[]) => Promise<string[]>,
      dir: string,
    ) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'verity-smb-'));
    try {
      // A configuration of our own: no system smb.conf may weaken the encryption demand.
      await writeFile(join(dir, 'smb.conf'), '[global]\n  client min protocol = SMB3\n', {
        mode: 0o600,
      });
      return await work((target, commands) => runBatch(target, commands, this.options, dir), dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Connects and lists the share root: proves address, sign-in and encryption. */
  async test(target: SmbTarget): Promise<void> {
    await this.batches(async (run) => {
      succeeded((await run(target, ['ls "\\*"']))[0]);
    });
  }

  async list(target: SmbTarget, path: string): Promise<NetworkShareEntry[]> {
    return this.batches(async (run) => {
      if (path === '') return parseListing(succeeded((await run(target, ['ls "\\*"']))[0]));
      const [info, listing] = await run(target, [
        `allinfo ${remote(path)}`,
        `ls ${remote(`${path}/*`)}`,
      ]);
      if (parseInfo(succeeded(info)).kind !== 'folder') throw new NetworkShareError('not_found');
      return parseListing(succeeded(listing));
    });
  }

  async info(target: SmbTarget, path: string): Promise<{ kind: 'folder' | 'file'; size: number }> {
    return this.batches(async (run) =>
      parseInfo(succeeded((await run(target, [`allinfo ${remote(path)}`]))[0])),
    );
  }

  async read(target: SmbTarget, path: string): Promise<{ content: Buffer; version: string }> {
    return this.batches(async (run, dir) => {
      const info = parseInfo(succeeded((await run(target, [`allinfo ${remote(path)}`]))[0]));
      if (info.kind !== 'file') throw new NetworkShareError('not_a_file');
      if (info.size > NETWORK_SHARE_MAX_FILE_BYTES) throw new NetworkShareError('too_large');
      const local = join(dir, 'download');
      succeeded((await run(target, [`get ${remote(path)} "${local}"`]))[0]);
      if ((await stat(local)).size > NETWORK_SHARE_MAX_FILE_BYTES)
        throw new NetworkShareError('too_large');
      const content = await readFile(local);
      return { content, version: contentVersion(content) };
    });
  }

  /**
   * Creates a file that must not exist yet. The content lands under a temporary
   * name first; the rename that publishes it fails if the name is taken, so an
   * existing file is never replaced. A failed run removes the temporary file.
   */
  async create(target: SmbTarget, path: string, content: Buffer): Promise<NetworkShareFileInfo> {
    if (content.byteLength > NETWORK_SHARE_MAX_FILE_BYTES) throw new NetworkShareError('too_large');
    return this.batches(async (run, dir) => {
      const local = join(dir, 'upload');
      await writeFile(local, content, { mode: 0o600 });
      const temporary = sibling(path, 'tmp');
      // Publish only a complete upload: smbclient carries on after a failed
      // command, so a partial `put` must not reach the rename in one batch.
      const discard = () => run(target, [`del ${remote(temporary)}`]).catch(() => undefined);
      try {
        const [upload] = await run(target, [`put "${local}" ${remote(temporary)}`]);
        const uploadError = statusOf(upload);
        if (uploadError) throw uploadError;
        const [publish] = await run(target, [`rename ${remote(temporary)} ${remote(path)}`]);
        const publishError = statusOf(publish);
        if (publishError) throw publishError;
      } catch (error) {
        await discard();
        throw error;
      }
      return { kind: 'file', size: content.byteLength, version: contentVersion(content) };
    });
  }

  /**
   * Replaces a file whose content is still the one with `expectedVersion`.
   *
   * 1. Upload the new content under a temporary name and move the current file
   *    aside under a second hidden name. Moving is atomic, so whatever another
   *    writer saved before that moment is what was moved.
   * 2. Download the moved file and compare its bytes with the expected version.
   * 3. Only on a match publish the new content; the rename fails rather than
   *    replace a file someone created in the meantime. Otherwise put the moved
   *    file back.
   *
   * Every failure, including a dropped connection, tries to put the original
   * back. If that is impossible because a new file now holds the name, the
   * original stays under its hidden `.old` name and the error says so.
   */
  async update(
    target: SmbTarget,
    path: string,
    content: Buffer,
    expectedVersion: string,
  ): Promise<NetworkShareFileInfo> {
    if (content.byteLength > NETWORK_SHARE_MAX_FILE_BYTES) throw new NetworkShareError('too_large');
    return this.batches(async (run, dir) => {
      const current = parseInfo(succeeded((await run(target, [`allinfo ${remote(path)}`]))[0]));
      if (current.kind !== 'file') throw new NetworkShareError('not_a_file');
      // The original is downloaded for the comparison; keep that bounded too.
      if (current.size > NETWORK_SHARE_MAX_FILE_BYTES) throw new NetworkShareError('too_large');
      const local = join(dir, 'upload');
      const replacedCopy = join(dir, 'replaced');
      await writeFile(local, content, { mode: 0o600 });
      const temporary = sibling(path, 'tmp');
      const previous = sibling(path, 'old');
      /** Puts the original back and drops the upload; reports whether the original is back. */
      const restore = async (): Promise<boolean> => {
        const [back] = await run(target, [
          `rename ${remote(previous)} ${remote(path)}`,
          `del ${remote(temporary)}`,
        ]).catch(() => [undefined]);
        const error = back === undefined ? new NetworkShareError('failed') : statusOf(back);
        // Nothing was moved aside: the original never left its name.
        return error === undefined || error.code === 'not_found';
      };
      let moved: string[];
      try {
        moved = await run(target, [
          `put "${local}" ${remote(temporary)}`,
          `rename ${remote(path)} ${remote(previous)}`,
          `get ${remote(previous)} "${replacedCopy}"`,
        ]);
      } catch (error) {
        if (!(await restore())) throw new NetworkShareError('restore_failed');
        throw error;
      }
      const [upload, moveAside, download] = moved;
      const failure = statusOf(upload) ?? statusOf(moveAside) ?? statusOf(download);
      // A copy that cannot be read, or grew past the limit, proves nothing:
      // never let it pass as some version of the original.
      const copy =
        failure === undefined
          ? await stat(replacedCopy)
              .then((info) =>
                info.size > NETWORK_SHARE_MAX_FILE_BYTES ? undefined : readFile(replacedCopy),
              )
              .catch(() => undefined)
          : undefined;
      const replaced = copy === undefined ? undefined : contentVersion(copy);
      if (failure !== undefined || replaced !== expectedVersion) {
        if (!(await restore())) throw new NetworkShareError('restore_failed');
        throw failure ?? new NetworkShareError('conflict');
      }
      let published: string[];
      try {
        published = await run(target, [`rename ${remote(temporary)} ${remote(path)}`]);
      } catch (error) {
        if (!(await restore())) throw new NetworkShareError('restore_failed');
        throw error;
      }
      const publishError = statusOf(published[0]);
      if (publishError?.code === 'already_exists') {
        // Someone created the file while it was moved aside: theirs stays, and
        // the original stays hidden next to it rather than being lost.
        await run(target, [`del ${remote(temporary)}`]).catch(() => undefined);
        throw new NetworkShareError('restore_failed');
      }
      if (publishError) {
        if (!(await restore())) throw new NetworkShareError('restore_failed');
        throw publishError;
      }
      await run(target, [`del ${remote(previous)}`]).catch(() => undefined);
      return { kind: 'file', size: content.byteLength, version: contentVersion(content) };
    });
  }
}

/** A file's version: a digest of its exact bytes, so any change shows. */
export function contentVersion(content: Buffer): string {
  return createHash('sha256').update(content).digest('base64url').slice(0, 32);
}

/** A hidden name next to `path` for a temporary upload or the replaced original. */
function sibling(path: string, kind: 'tmp' | 'old'): string {
  return [...path.split('/').slice(0, -1), `.verity-${randomUUID()}.${kind}`].join('/');
}

/** What the routes and agent tools need from an SMB client; tests substitute a fake. */
export type NetworkShareClient = Pick<
  SmbClient,
  'test' | 'list' | 'info' | 'read' | 'create' | 'update'
>;
