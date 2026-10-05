import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = ts.createSourceFile(
  'embedded.ts',
  readFileSync(new URL('./embedded.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function nodes<T extends ts.Node>(predicate: (node: ts.Node) => node is T): T[] {
  const matches: T[] = [];
  function visit(node: ts.Node): void {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return matches;
}
function property(expression: ts.NewExpression, name: string): string | undefined {
  const options = expression.arguments?.[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  const entry = options.properties.find((item) => item.name?.getText(source) === name);
  return entry && ts.isPropertyAssignment(entry)
    ? entry.initializer.getText(source)
    : entry && ts.isShorthandPropertyAssignment(entry)
      ? entry.name.getText(source)
      : undefined;
}

describe('production session isolation wiring', () => {
  it('branch metadata polling resolves private state without waking a session', () => {
    const branches = nodes(ts.isVariableDeclaration).find(
      (node) => node.name.getText(source) === 'branches',
    );
    const text = branches?.initializer?.getText(source);
    expect(text).toMatch(/readOnly\s*\? await resolveSessionProject/);
    expect(text).toMatch(/'rev-parse'/);
    expect(text).toMatch(/'for-each-ref'/);
    expect(text).toMatch(/'show-ref'/);
    expect(text).toMatch(/readOnly && runtimeProject.state !== 'active'/);
    expect(text).toContain('createSleepingSessionGit');
    expect(text).toMatch(/args\[index \+ 2\] !== 'worktree' \|\| args\[index \+ 3\] === 'list'/);
  });
  it('protects legacy transcript cwd directories alongside private session transcripts', () => {
    const property = nodes(ts.isPropertyAssignment).find(
      (node) => node.name.getText(source) === 'liveCwdDirs',
    );
    const expression = property?.initializer.getText(source);
    // Legacy subagent transcripts are irreplaceable after the first isolated resume.
    expect(expression).toContain('sessionSandboxCwd(worktree)');
    expect(expression).toContain(
      'runnerSandboxPath(worktree, config.hostCloneRoot, RUNNER_CONTAINER_PROJECT_ROOT)',
    );
  });
  it('migration explicitly stops legacy managed processes before copying their workspace', () => {
    const serverSource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const migration = serverSource.slice(
      serverSource.indexOf('registerSessionIsolationMigrationRoute('),
    );
    // The private resolver rejects linked worktrees, so ordinary shutdown leaves legacy writers alive.
    expect(migration).toMatch(/stopSession\(sessionId,\s*\{\s*legacyRuntime:\s*true\s*\}\)/);
  });
  it('every Docker agent backend uses a private runtime and checkout', () => {
    const backends = nodes(ts.isNewExpression).filter(
      (node) => node.expression.getText(source) === 'DockerExecBackend',
    );
    expect(backends.length).toBeGreaterThan(0);
    for (const backend of backends) {
      expect(property(backend, 'containerName')).toBe('runtimeProject.containerName');
      expect(property(backend, 'hostProjectRoot')).toBe('session.worktree');
    }
  });
  it('all constructed session preview and listener managers use the read-only session resolver', () => {
    const constructors = nodes(ts.isNewExpression).filter((node) =>
      [
        'ListenerDiscovery',
        'LocalPreviewManager',
        'PreviewShareManager',
        'ManagedDevServerManager',
      ].includes(node.expression.getText(source)),
    );
    expect(constructors.length).toBeGreaterThan(0);
    for (const constructor of constructors)
      expect(property(constructor, 'resolveSessionProject')).toMatch(
        /^(resolveSessionProject|\(sessionId, project\) => resolveSessionProject\(sessionId, project\))$/,
      );
    const resolver = nodes(ts.isVariableDeclaration).find(
      (node) => node.name.getText(source) === 'resolveSessionProject',
    );
    expect(resolver?.initializer).toBeDefined();
    const calls: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
      ts.forEachChild(node, visit);
    }
    visit(resolver!.initializer!);
    expect(calls).toContain('projectDocker.inspectContainer');
    // A background listener scan must not silently wake every stopped session.
    expect(
      calls.some((call) =>
        /ensureSessionProject|\.ensure$|\.startContainer$|\.createContainer$/.test(call),
      ),
    ).toBe(false);
  });
});
