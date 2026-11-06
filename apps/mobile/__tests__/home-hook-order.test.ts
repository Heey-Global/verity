import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

it('runs every overview hook before the loading and error returns', () => {
  const source = ts.createSourceFile(
    'index.tsx',
    readFileSync(join(__dirname, '../app/index.tsx'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const component = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'SessionList',
  );
  expect(component?.body).toBeDefined();
  const lateHooks: string[] = [];
  let canReturn = false;
  function visit(node: ts.Node): void {
    // Returns in callbacks do not end the component's render.
    if (ts.isFunctionLike(node)) return;
    if (
      canReturn &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /^use[A-Z]/.test(node.expression.text)
    ) {
      lateHooks.push(node.expression.text);
    }
    if (ts.isReturnStatement(node)) canReturn = true;
    ts.forEachChild(node, visit);
  }
  // A hook below an early return is skipped on the first loading render and
  // crashes React when the sessions arrive, even when the preview is disabled.
  component!.body!.statements.forEach(visit);
  expect(canReturn).toBe(true);
  expect(lateHooks).toEqual([]);
});
