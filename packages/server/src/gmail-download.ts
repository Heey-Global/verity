import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm, link } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { assertProjectTransportAuthority } from './project-transport-authority.js';

/** Pin the download directory so concurrent symlink replacement cannot redirect writes. */
export async function withGmailDownload<T>(
  worktree: string,
  run: (directory: string, published: string) => Promise<T>,
): Promise<T> {
  const root = await realpath(worktree);
  const downloads = join(root, 'downloads');
  await assertProjectTransportAuthority();
  const workspace = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  let temporary: string | undefined;
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const downloadEntry = `/proc/self/fd/${workspace.fd}/downloads`;
    await mkdir(downloadEntry, { recursive: true });
    directory = await open(
      downloadEntry,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const pinned = `/proc/self/fd/${directory.fd}`;
    const resolved = await realpath(pinned);
    const path = relative(root, resolved);
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new Error('Gmail downloads must stay inside the session workspace');
    }
    temporary = await mkdtemp(join(pinned, 'gmail-'));
    const published = join(downloads, temporary.split('/').pop()!);
    temporaryHandle = await open(
      temporary,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const pinnedTemporary = `/proc/self/fd/${temporaryHandle.fd}`;
    const temporaryReal = await realpath(pinnedTemporary);
    if (
      (await realpath(temporary)) !== temporaryReal ||
      !temporaryReal.startsWith(`${resolved}${sep}`)
    ) {
      throw new Error('The download directory changed');
    }
    const result = await run(pinnedTemporary, published);
    await assertProjectTransportAuthority();
    if ((await realpath(downloads)) !== resolved || (await realpath(published)) !== temporaryReal)
      throw new Error('The download directory changed');
    temporary = undefined;
    return result;
  } finally {
    try {
      if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
    } finally {
      await temporaryHandle?.close();
      await directory?.close();
      await workspace.close();
    }
  }
}

/** Replace JSON data strings with spool paths while decoding with bounded buffers. */
export async function spoolGmailJson(response: Response, directory: string): Promise<unknown> {
  if (!response.body) throw new Error('The Gmail response has no body');
  let json = '';
  let token = '';
  let inString = false;
  let escaped = false;
  let lastString = '';
  let colon = false;
  let data = false;
  let carry = '';
  let count = 0;
  let padded = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const flush = async (final: boolean): Promise<void> => {
    const text = JSON.parse(`"${token}"`) as string;
    token = '';
    if (!/^[A-Za-z0-9_+/=-]*$/u.test(text)) throw new Error('Invalid Gmail attachment encoding');
    if (padded && text.length > 0) throw new Error('Invalid Gmail attachment encoding');
    carry += text;
    const length = final ? carry.length : Math.floor(carry.length / 4) * 4;
    const encoded = carry.slice(0, length);
    carry = carry.slice(length);
    if (final && encoded.length % 4 === 1) throw new Error('Invalid Gmail attachment encoding');
    if (encoded.includes('=')) {
      if (
        !/^[A-Za-z0-9_+/-]*={1,2}$/u.test(encoded) ||
        encoded.length % 4 !== 0 ||
        carry.length > 0
      ) {
        throw new Error('Invalid Gmail attachment encoding');
      }
      padded = true;
    }
    if (encoded) await handle!.writeFile(Buffer.from(encoded, 'base64url'));
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const value of response.body) {
      const bytes: unknown = value;
      if (!(bytes instanceof Uint8Array)) throw new Error('Invalid Gmail response stream');
      // Providers may deliver large chunks; keep decoded scratch strings bounded too.
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        const chunk = decoder.decode(bytes.subarray(offset, offset + 16384), { stream: true });
        for (const char of chunk) {
          if (inString) {
            if (char === '"' && !escaped) {
              inString = false;
              if (data) {
                await flush(true);
                await handle!.close();
                handle = undefined;
                data = false;
              } else {
                lastString = JSON.parse(`"${token}"`) as string;
                json += `"${token}"`;
                token = '';
              }
              colon = false;
            } else {
              token += char;
              escaped = char === '\\' && !escaped;
            }
          } else if (char === '"') {
            inString = true;
            escaped = false;
            token = '';
            data = colon && lastString === 'data';
            if (data) {
              const path = join(directory, `body-${count++}`);
              handle = await open(path, 'wx', 0o600);
              json += JSON.stringify(path);
              carry = '';
              padded = false;
            }
          } else {
            json += char;
            if (!/\s/u.test(char)) colon = char === ':';
          }
        }
        // Do not split JSON escapes, including partial unicode escapes.
        if (data && !escaped && !/\\(?:u[0-9a-fA-F]{0,3})?$/u.test(token)) await flush(false);
      }
    }
    decoder.decode();
    if (inString) throw new Error('Incomplete Gmail response');
    return JSON.parse(json) as unknown;
  } finally {
    await handle?.close();
  }
}

export async function publishGmailBody(
  source: string,
  directory: string,
  filename: string,
): Promise<string> {
  const safe =
    Array.from(filename, (char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\'
        ? '_'
        : char,
    )
      .join('')
      .replace(/^\.+/u, '')
      .slice(0, 60) || 'attachment';
  const target = join(directory, `attachment-${safe}`);
  await link(source, target);
  await rm(source);
  return target;
}
