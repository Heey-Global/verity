import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Paginated release history can exceed execFileSync's buffered output limit.
 * @param {string} command
 * @param {string[]} args
 * @returns {unknown}
 */
export function captureJson(command, args) {
  const directory = mkdtempSync(join(tmpdir(), 'verity-release-json-'));
  const path = join(directory, 'output.json');
  const fd = openSync(path, 'w');
  try {
    execFileSync(command, args, { stdio: ['ignore', fd, 'inherit'] });
    return JSON.parse(readFileSync(path, 'utf8'));
  } finally {
    closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
  }
}
