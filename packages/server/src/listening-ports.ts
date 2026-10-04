import { posix } from 'node:path';

/** A TCP listener inside a project sandbox, joined to the process that owns it. */
export interface ListeningProcess {
  sessionId?: string;
  announcedName?: string;
  port: number;
  /** `any` is reachable from the preview connector over the project network;
   *  `loopback` answers only inside the sandbox itself. */
  bind: 'any' | 'loopback' | 'other';
  pid: number;
  cwd: string;
  command: string;
  /** An IPv6 wildcard needs an IPv4 probe before the connector can use it. */
  ipv6Wildcard?: boolean;
  reachable?: boolean;
}

/** A listener attributed to one session worktree, as the preview sheet shows it. */
export interface SessionDevServer {
  scope?: 'session' | 'project';
  sessionId?: string;
  port: number;
  reachable: boolean;
  pid: number;
  name: string;
  command: string;
  /** Working directory relative to the session worktree; `.` for its root. */
  workdir: string;
}

const MAX_COMMAND_CHARS = 300;

/**
 * Collects listening sockets, socket ownership and process metadata in one exec.
 * Parsing stays in Node so the script needs nothing beyond POSIX sh, `ls`, `tr`
 * and `cut`, which every sandbox image carries. Processes of other users (the
 * broker, root helpers) are unreadable to the exec user and drop out by design.
 */
export const LISTENING_PORTS_SCRIPT = [
  "echo '#tcp'",
  'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null',
  "echo '#fd'",
  // The extra operand keeps `ls` printing a `/proc/N/fd:` header even when the
  // glob matches a single process; the parser attributes sockets by that header.
  'ls -l /proc/[0-9]*/fd /dev/null 2>/dev/null',
  "echo '#proc'",
  'for d in /proc/[0-9]*; do',
  'c=$(readlink "$d/cwd" 2>/dev/null) || continue',
  `printf 'P\\t%s\\t%s\\t' "\${d#/proc/}" "$c"`,
  `tr '\\0\\n\\t' '   ' < "$d/cmdline" 2>/dev/null | cut -c1-${String(MAX_COMMAND_CHARS)}`,
  // An empty or vanished cmdline makes `cut` print nothing, which would glue the
  // next process onto this line. The extra newline ends it either way.
  'echo',
  `printf 'E\\t%s\\t' "\${d#/proc/}"`,
  `tr '\\0' '\\n' < "$d/environ" 2>/dev/null | sed -n 's/^VERITY_SESSION_ID=//p' | head -c 200`,
  'echo',
  `printf 'F\\t%s\\t' "\${d#/proc/}"`,
  `tr '\\0' '\\n' < "$d/environ" 2>/dev/null | sed -n 's/^VERITY_PREVIEW_FORWARDER=//p' | head -c 20`,
  'echo',
  'done',
  "echo '#announce'",
  'for f in /tmp/verity-dev-servers/announcements/*.json; do [ -f "$f" ] && cat "$f" && echo; done',
  'true',
].join('\n');

function bindOf(hexAddress: string): ListeningProcess['bind'] {
  const address = hexAddress.toUpperCase();
  // Node's default IPv6 wildcard also accepts IPv4 on a dual-stack socket.
  if (/^0+$/u.test(address)) return 'any';
  // IPv4 is little-endian per word: 127.x.y.z ends in 7F.
  if (address.length === 8) return address.endsWith('7F') ? 'loopback' : 'other';
  if (address === '00000000000000000000000001000000') return 'loopback';
  if (address.startsWith('0000000000000000FFFF0000')) {
    return address.endsWith('7F') ? 'loopback' : 'other';
  }
  return 'other';
}

/** Parses {@link LISTENING_PORTS_SCRIPT} output. A port bound twice (IPv4 and
 *  IPv6, or several workers) is reported once, preferring its widest bind. */
export function parseListeningProcesses(output: string): ListeningProcess[] {
  const listeners = new Map<
    string,
    { port: number; bind: ListeningProcess['bind']; ipv6Wildcard?: boolean }
  >();
  const owners = new Map<string, number>();
  const processes = new Map<number, { cwd: string; command: string }>();
  const forwarders = new Set<number>();
  const sessions = new Map<number, string>();
  const announcements = new Map<number, { name: string; pid: number; sessionId?: string }>();
  let section = '';
  let fdPid: number | null = null;
  for (const line of output.split('\n')) {
    if (line === '#tcp' || line === '#fd' || line === '#proc' || line === '#announce') {
      section = line;
      continue;
    }
    if (section === '#tcp') {
      const fields = line.trim().split(/\s+/u);
      // sl local rem st tx:rx tr:when retrnsmt uid timeout inode
      if (fields.length < 10 || fields[3] !== '0A') continue;
      const [address, portHex] = (fields[1] ?? '').split(':');
      const inode = fields[9];
      if (!address || !portHex || !inode || inode === '0') continue;
      listeners.set(inode, {
        port: Number.parseInt(portHex, 16),
        bind: bindOf(address),
        ...(address.length === 32 && /^0+$/u.test(address) ? { ipv6Wildcard: true } : {}),
      });
    } else if (section === '#fd') {
      const header = /^\/proc\/(\d+)\/fd:$/u.exec(line);
      if (header) {
        fdPid = Number(header[1]);
        continue;
      }
      const socket = /-> socket:\[(\d+)\]$/u.exec(line);
      if (socket && fdPid !== null && !owners.has(socket[1]!)) owners.set(socket[1]!, fdPid);
    } else if (section === '#announce') {
      try {
        const value = JSON.parse(line) as {
          port?: number;
          name?: string;
          pid?: number;
          sessionId?: string;
        };
        if (
          Number.isInteger(value.port) &&
          typeof value.name === 'string' &&
          typeof value.pid === 'number'
        )
          announcements.set(value.port!, {
            name: value.name.slice(0, 100),
            pid: value.pid,
            ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
          });
      } catch {
        /* A partially written hint must not suppress actual listeners. */
      }
    } else if (section === '#proc' && line.startsWith('F\t')) {
      const [, pid, marker] = line.split('\t');
      if (pid && marker) forwarders.add(Number(pid));
    } else if (section === '#proc' && line.startsWith('E\t')) {
      const [, pid, sessionId] = line.split('\t');
      if (pid && sessionId) sessions.set(Number(pid), sessionId);
    } else if (section === '#proc' && line.startsWith('P\t')) {
      const [, pid, cwd, ...command] = line.split('\t');
      if (!pid || !cwd) continue;
      processes.set(Number(pid), { cwd, command: command.join(' ').trim() });
    }
  }
  const rank = { any: 2, other: 1, loopback: 0 } as const;
  const byPort = new Map<number, ListeningProcess>();
  for (const [inode, listener] of listeners) {
    const pid = owners.get(inode);
    const process = pid === undefined ? undefined : processes.get(pid);
    if (pid === undefined || !process || forwarders.has(pid)) continue;
    const current = byPort.get(listener.port);
    if (current && rank[current.bind] >= rank[listener.bind]) continue;
    const announcement = announcements.get(listener.port);
    const sessionId = sessions.get(pid);
    byPort.set(listener.port, {
      ...listener,
      pid,
      ...process,
      ...(sessionId ? { sessionId } : {}),
      ...(announcement &&
      (announcement.pid === pid || (sessionId && announcement.sessionId === sessionId))
        ? { announcedName: announcement.name }
        : {}),
    });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

const KNOWN_SERVERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bstorybook\b/u, 'Storybook'],
  [/\bnext\b/u, 'Next.js'],
  [/\bnuxt\b/u, 'Nuxt'],
  [/\bastro\b/u, 'Astro'],
  [/\bremix\b/u, 'Remix'],
  [/\bsvelte-kit\b/u, 'SvelteKit'],
  [/\bvite\b/u, 'Vite'],
  [/\bwebpack\b/u, 'webpack'],
  [/\bexpo\b/u, 'Expo'],
  [/\bng serve\b|@angular\/cli/u, 'Angular'],
  [/\bhttp\.server\b/u, 'Python HTTP'],
  [/\b(?:uvicorn|gunicorn|flask|django|manage\.py)\b/u, 'Python'],
  [/\b(?:rails|puma)\b/u, 'Rails'],
];

/** A short human label for a listener's command line: the framework when it is
 *  recognisable, otherwise the executable's basename. */
export function devServerName(command: string): string {
  for (const [pattern, name] of KNOWN_SERVERS) if (pattern.test(command)) return name;
  const executable = command.split(' ', 1)[0] ?? '';
  return posix.basename(executable) || 'Server';
}

/** Keeps the listeners whose process runs inside `worktree` (a sandbox path). */
export function sessionDevServers(
  processes: readonly ListeningProcess[],
  worktree: string,
  sessionId?: string,
): SessionDevServer[] {
  const root = posix.normalize(worktree).replace(/\/+$/u, '');
  return processes.flatMap((process) => {
    const cwd = posix.normalize(process.cwd);
    if (
      process.sessionId && sessionId
        ? process.sessionId !== sessionId
        : cwd !== root && !cwd.startsWith(`${root}/`)
    )
      return [];
    return [
      {
        port: process.port,
        reachable: process.reachable ?? process.bind === 'any',
        pid: process.pid,
        name: process.announcedName ?? devServerName(process.command),
        command: process.command,
        workdir: posix.relative(root, cwd) || '.',
      },
    ];
  });
}
