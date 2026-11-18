// Worker for shareDependencyFiles: runs under the uid and gid of the session
// whose dependency files it shares, never with the Server's own rights.
import { shareOwnDependencyFiles } from './dependency-sharing.js';

const [root, worktree, mode] = process.argv.slice(2);
if (!root || !worktree || (mode !== 'apply' && mode !== 'dry-run'))
  throw new Error('Dependency sharing worker requires a project root, worktree and mode');
const controller = new AbortController();
// The parent stops a pass at its budget; stop between files rather than mid-rename.
process.once('SIGTERM', () => controller.abort());
process.stdout.write(
  JSON.stringify(
    await shareOwnDependencyFiles(root, worktree, controller.signal, mode === 'dry-run'),
  ) + '\n',
);
