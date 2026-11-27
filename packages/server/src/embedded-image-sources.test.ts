import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('wires embedded server provisioning through the bundled Feature reader', () => {
  const source = readFileSync(new URL('./embedded.ts', import.meta.url), 'utf8');
  const imageSources = readFileSync(
    new URL('./embedded-image-sources.ts', import.meta.url),
    'utf8',
  );

  expect(source).toContain(
    'const resolveDevcontainerFeature = prepareEmbeddedToolkitFeature(config);',
  );
  expect(source).toContain('const devcontainerFeature = resolveDevcontainerFeature();');
  const file = ts.createSourceFile('embedded.ts', source, ts.ScriptTarget.Latest);
  const findProvisioning = (node: ts.Node): ts.CallExpression | undefined =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'createEmbeddedProvisioning'
      ? node
      : ts.forEachChild(node, findProvisioning);
  const options = findProvisioning(file)?.arguments[0];
  expect(
    options &&
      ts.isObjectLiteralExpression(options) &&
      options.properties.some(
        (property) =>
          ts.isShorthandPropertyAssignment(property) &&
          property.name.text === 'devcontainerFeature',
      ),
  ).toBe(true);
  expect(imageSources.match(/resolveToolkitFeatureRef\(/g)).toHaveLength(2);
  expect(
    imageSources.match(/resolveToolkitFeatureRef\(\s*readBundledDevcontainerFeature\(\),/g),
  ).toHaveLength(2);
});
