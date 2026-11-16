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

// iOS stops retrying native attachment while Projects is display:none. Updating
// the same detector on a later tab switch does not retry that attachment.
it('mounts the reorder detector around the sidebar instead of inside its hidden project pane', () => {
  const source = ts.createSourceFile(
    'index.tsx',
    readFileSync(join(__dirname, '../app/index.tsx'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const variables = new Map<string, ts.Expression>();
  function collect(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      variables.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  }
  collect(source);
  const detectors: ts.JsxElement[] = [];
  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'GestureDetector')
      detectors.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(detectors).toHaveLength(1);
  const detector = detectors[0]!;
  const boundary = variables.get('gestureSidebar')!;
  expect(boundary).toBeDefined();
  expect(detector.pos).toBeGreaterThanOrEqual(boundary.pos);
  expect(detector.end).toBeLessThanOrEqual(boundary.end);
  expect(detector.getText(source)).toContain('{sidebar}');
  expect(detector.getText(source)).toContain('collapsable={false}');
  expect(detector.getText(source)).not.toContain('hiddenPane');
  expect(variables.get('master')!.getText(source)).not.toContain('GestureDetector');
  // Both phone and split layouts must use the visible detector host.
  const uses: ts.Identifier[] = [];
  function findUses(node: ts.Node): void {
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'gestureSidebar'
    )
      uses.push(node.expression);
    ts.forEachChild(node, findUses);
  }
  findUses(source);
  expect(uses).toHaveLength(2);
});
