import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { serverImportViolations } from './server-import-guard.mjs';

export const FACADE = 'packages/store/src/store.ts';
export const DEBT = 'scripts/store-architecture-debt.json';

/** Only direct collaborator calls with forwarded parameters belong in facade methods.
 * Callback adapters and lifecycle infrastructure remain explicit migration debt.
 * @param {string} text */
export function facadeImplementations(text) {
  const source = ts.createSourceFile(FACADE, text, ts.ScriptTarget.Latest, true);
  const facade = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === 'EventStore',
  );
  if (!facade || !ts.isClassDeclaration(facade)) throw new Error('EventStore class is missing');
  /** @type {Record<string, string>} */
  const debt = {};
  const members = [
    ...facade.members,
    ...source.statements.filter(
      (node) =>
        node !== facade &&
        !ts.isImportDeclaration(node) &&
        !ts.isExportDeclaration(node) &&
        !ts.isInterfaceDeclaration(node) &&
        !ts.isTypeAliasDeclaration(node),
    ),
  ];
  for (const member of members) {
    const body =
      ts.isFunctionLike(member) || ts.isClassStaticBlockDeclaration(member)
        ? 'body' in member
          ? member.body
          : undefined
        : undefined;
    const initializer = ts.isPropertyDeclaration(member) ? member.initializer : undefined;
    if (!body && !initializer && member.parent === facade) continue;
    const name =
      ('name' in member && member.name ? member.name.getText(source) : undefined) ??
      (ts.isConstructorDeclaration(member)
        ? 'constructor'
        : ts.isVariableStatement(member)
          ? member.declarationList.declarations
              .map((declaration) => declaration.name.getText(source))
              .join(', ')
          : ts.SyntaxKind[member.kind]);
    const statements = body && ts.isBlock(body) ? body.statements : [];
    const expression =
      statements.length === 1 && ts.isReturnStatement(statements[0])
        ? statements[0].expression
        : undefined;
    const parameters = new Set(
      (ts.isFunctionLike(member) ? member.parameters : []).map((p) => p.name.getText(source)),
    );
    const forwarded =
      expression &&
      ts.isCallExpression(expression) &&
      /^this\.[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(expression.expression.getText(source)) &&
      !expression.expression.getText(source).startsWith('this.db.') &&
      expression.arguments.every((arg) => ts.isIdentifier(arg) && parameters.has(arg.text));
    if (forwarded || (member.parent === facade && isStoreWiring(initializer))) continue;
    const key = member.parent === facade ? name : 'module: ' + name;
    if (Object.hasOwn(debt, key)) throw new Error('Duplicate facade exception: ' + key);
    // Token hashing ignores formatting and comments but detects edits to retained implementations.
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      true,
      ts.LanguageVariant.Standard,
      (body ?? initializer ?? member).getText(source),
    );
    const tokens = [];
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
    Object.defineProperty(debt, key, {
      enumerable: true,
      value:
        createHash('sha256')
          .update(JSON.stringify(tokens))
          .digest('hex')
          .match(/.{8}/g)
          ?.join(' ') ?? '',
    });
  }
  return debt;
}

/** @param {ts.Expression | undefined} initializer */
function isStoreWiring(initializer) {
  return (
    initializer &&
    ts.isNewExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text.endsWith('Store') &&
    (initializer.arguments ?? []).every(
      (argument) =>
        ts.isArrowFunction(argument) &&
        argument.parameters.length === 0 &&
        ts.isPropertyAccessExpression(argument.body) &&
        argument.body.expression.kind === ts.SyntaxKind.ThisKeyword &&
        argument.body.name.text === 'db',
    )
  );
}

/** @param {Record<string, string>} actual @param {Record<string, string>} allowed */
export function compareImplementations(actual, allowed) {
  return [
    ...Object.keys(actual)
      .filter((name) => actual[name] !== allowed[name])
      .map((name) => 'Unapproved facade implementation: ' + name),
    ...Object.keys(allowed)
      .filter((name) => !(name in actual))
      .map((name) => 'Remove retired facade exception: ' + name),
  ];
}

/** @param {Record<string, string>} current @param {Record<string, string>} base */
export function compareBaseline(current, base) {
  return Object.keys(current)
    .filter((name) => current[name] !== base[name])
    .map((name) => 'Facade exception added or changed: ' + name);
}

/** @param {string} root @param {string[]} files */
export function storeImportViolations(root, files) {
  return serverImportViolations(root, files, {
    source: 'packages/store/src/',
    roots: [FACADE],
    entries: new Set(['index.ts', 'testing.ts']),
  });
}

/** @param {string} root */
export function checkStoreArchitecture(root) {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(
      (f) => /\.[cm]?[jt]sx?$/.test(f) && !f.startsWith('vendor/') && existsSync(join(root, f)),
    );
  const record = parseRecord(readFileSync(join(root, DEBT), 'utf8'));
  const problems = compareImplementations(
    facadeImplementations(readFileSync(join(root, FACADE), 'utf8')),
    record.methods,
  );
  const imports = storeImportViolations(root, files);
  for (const path of imports)
    if (!record.imports.includes(path)) problems.push('Store back-import: ' + path);
  for (const path of record.imports)
    if (!imports.includes(path)) problems.push('Remove retired import exception: ' + path);
  const base = baseRecord(root);
  if (base) {
    problems.push(...compareBaseline(record.methods, base.methods));
    for (const path of record.imports)
      if (!base.imports.includes(path)) problems.push('Import exception added: ' + path);
  }
  return problems;
}

/** @param {string} root */
function baseRecord(root) {
  const cwd = root;
  const options = { cwd, encoding: /** @type {const} */ ('utf8') };
  const explicitBase = process.env.STORE_ARCHITECTURE_BASE;
  let ref = explicitBase;
  if (!ref) {
    try {
      ref = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
        ...options,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      // Local checkouts and non-PR CI can still check the current tree.
      return undefined;
    }
  }
  if (!execFileSync('git', ['ls-tree', '--name-only', ref, DEBT], options).trim()) {
    return undefined;
  }
  return parseRecord(execFileSync('git', ['show', ref + ':' + DEBT], options));
}

/** @param {string} text */
function parseRecord(text) {
  const record = /** @type {unknown} */ (JSON.parse(text));
  if (
    !record ||
    typeof record !== 'object' ||
    !('methods' in record) ||
    !record.methods ||
    typeof record.methods !== 'object' ||
    Array.isArray(record.methods) ||
    !Object.values(record.methods).every((value) => typeof value === 'string') ||
    !('imports' in record) ||
    !Array.isArray(record.imports) ||
    !record.imports.every((value) => typeof value === 'string')
  ) {
    throw new Error('Invalid Store architecture debt record');
  }
  return {
    methods: /** @type {Record<string, string>} */ (record.methods),
    imports: /** @type {string[]} */ (record.imports),
  };
}
