import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  devServerName,
  LISTENING_PORTS_SCRIPT,
  parseListeningProcesses,
  sessionDevServers,
} from './listening-ports.js';

const execFileAsync = promisify(execFile);

describe('listening port discovery', () => {
  const children: Array<{ kill(): void }> = [];
  const servers: Server[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
    for (const server of servers.splice(0)) server.close();
  });

  // Runs the shipped script against a real listener: a script that stops emitting
  // one of its sections, or a parser that drifts from its layout, would otherwise
  // leave the sheet silently empty while every fixture test stays green.
  it.skipIf(!existsSync('/proc/net/tcp'))(
    'finds a real listener with its owning process and working directory',
    async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'verity-ports-')));
      const child = execFile(
        process.execPath,
        [
          '-e',
          "require('net').createServer().listen(0, '0.0.0.0', function () { console.log(this.address().port) })",
        ],
        { cwd },
      );
      children.push(child);
      const port = await new Promise<number>((resolve) =>
        child.stdout!.once('data', (chunk) => resolve(Number(String(chunk).trim()))),
      );

      const { stdout } = await execFileAsync('sh', ['-c', LISTENING_PORTS_SCRIPT]);
      const found = parseListeningProcesses(stdout).find((entry) => entry.port === port);

      expect(found).toEqual(expect.objectContaining({ port, bind: 'any', pid: child.pid, cwd }));
      expect(found?.command).toContain(process.execPath);
      expect(sessionDevServers(found ? [found] : [], cwd)).toEqual([
        expect.objectContaining({ port, reachable: true, workdir: '.' }),
      ]);
    },
  );

  it.skipIf(!existsSync('/proc/net/tcp'))(
    'marks a loopback-only listener unreachable for the connector',
    async () => {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;

      const { stdout } = await execFileAsync('sh', ['-c', LISTENING_PORTS_SCRIPT]);

      expect(parseListeningProcesses(stdout).find((entry) => entry.port === port)).toEqual(
        expect.objectContaining({ bind: 'loopback', pid: process.pid }),
      );
    },
  );

  it('reports a port bound on IPv4 loopback and IPv6 any once, as reachable', () => {
    const output = [
      '#tcp',
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   1: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11 1 0',
      '   2: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12 1 0',
      '   3: 030014AC:1436 020014AC:20FB 01 00000000:00000000 00:00000000 00000000  1000        0 13 1 0',
      '#fd',
      '/proc/40/fd:',
      'lrwx------ 1 dev dev 64 Sep 30 13:07 18 -> socket:[11]',
      'lrwx------ 1 dev dev 64 Sep 30 13:07 19 -> socket:[12]',
      'lrwx------ 1 dev dev 64 Sep 30 13:07 20 -> socket:[13]',
      '#proc',
      'P\t40\t/work/.verity-sessions/agent-1/web\tnode /work/.verity-sessions/agent-1/node_modules/.bin/vite ',
    ].join('\n');

    expect(parseListeningProcesses(output)).toEqual([
      {
        port: 0x1435,
        bind: 'any',
        pid: 40,
        cwd: '/work/.verity-sessions/agent-1/web',
        command: 'node /work/.verity-sessions/agent-1/node_modules/.bin/vite',
      },
    ]);
  });

  it('attributes listeners to the session whose worktree contains them', () => {
    const listener = (pid: number, cwd: string) => ({
      port: 3000 + pid,
      bind: 'any' as const,
      pid,
      cwd,
      command: 'node server.js',
    });
    const processes = [
      listener(1, '/work/.verity-sessions/agent-1'),
      listener(2, '/work/.verity-sessions/agent-1/apps/web'),
      // A sibling whose name extends this session's must not be mistaken for it.
      listener(3, '/work/.verity-sessions/agent-10'),
      listener(4, '/work'),
    ];

    expect(
      sessionDevServers(processes, '/work/.verity-sessions/agent-1/').map(({ pid, workdir }) => [
        pid,
        workdir,
      ]),
    ).toEqual([
      [1, '.'],
      [2, 'apps/web'],
    ]);
  });

  it('names common dev servers from their command line', () => {
    expect(devServerName('node /w/node_modules/.bin/vite --host 0.0.0.0')).toBe('Vite');
    expect(devServerName('node /w/node_modules/.bin/storybook dev -p 6006')).toBe('Storybook');
    expect(devServerName('python3 -m http.server 8000')).toBe('Python HTTP');
    expect(devServerName('/usr/local/bin/caddy run')).toBe('caddy');
  });
});
