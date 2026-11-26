import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { generatedFiles } from './file-size-guard.mjs';

const SOURCE = 'packages/server/src/';
const ROOTS = [`${SOURCE}server.ts`, `${SOURCE}embedded.ts`];
// Outer composition roots and public entry points consume the server. These
// exemptions apply only to origins: a domain -> index -> server path still fails.
const ENTRY_POINTS = new Set([
  'server-main.ts', // Executable startup constructs the embedded server.
  'main.ts', // Executable dispatcher loads server-main.
  'index.ts', // Public API preserves the buildServer export.
  'testing.ts', // Public embedded-server test factory.
]);
/** @param {string} file */
const testConsumer = (file) => /\.(?:test|test-helper)\.[cm]?[jt]sx?$/.test(file);

/** Read import edges without retaining a type program or ASTs for the tree.
 * @param {string} file @param {string} text */
function specifiers(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  /** @type {Set<string>} */
  const found = new Set();
  /** @type {Map<ts.Node, Map<string, ts.Expression | undefined>>} */
  const constants = new Map();
  /** @param {ts.Node} node */
  function collect(node) {
    if (
      (ts.isFunctionExpression(node) ||
        ts.isClassExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name
    ) {
      if (!constants.has(node)) constants.set(node, new Map());
      constants.get(node).set(node.name.text, undefined);
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      let scope = node.parent;
      while (
        scope &&
        !ts.isBlock(scope) &&
        !ts.isSourceFile(scope) &&
        !ts.isFunctionLike(scope) &&
        !ts.isForStatement(scope) &&
        !ts.isForOfStatement(scope) &&
        !ts.isForInStatement(scope) &&
        !ts.isCatchClause(scope) &&
        !ts.isCaseBlock(scope)
      )
        scope = scope.parent;
      if (!constants.has(scope)) constants.set(scope, new Map());
      const value =
        ts.isVariableDeclaration(node) &&
        ts.isVariableDeclarationList(node.parent) &&
        node.parent.flags & ts.NodeFlags.Const
          ? node.initializer
          : undefined;
      /** @param {ts.BindingName} name @param {ts.Expression | undefined} expression */
      function bind(name, expression) {
        if (ts.isIdentifier(name)) constants.get(scope).set(name.text, expression);
        else
          for (const element of name.elements) {
            if (ts.isBindingElement(element)) bind(element.name, undefined);
          }
      }
      bind(node.name, value);
    }
    ts.forEachChild(node, collect);
  }
  collect(source);
  /** @param {ts.Node | undefined} node @param {Set<ts.Node>} seen @returns {string | undefined} */
  function literal(node, seen = new Set()) {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return literal(node.expression, seen);
    if (ts.isIdentifier(node)) {
      for (let scope = node.parent; scope; scope = scope.parent) {
        const bindings = constants.get(scope);
        if (!bindings?.has(node.text)) continue;
        const value = bindings.get(node.text);
        if (!value || seen.has(value)) return undefined;
        return literal(value, new Set([...seen, value]));
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literal(node.left, seen),
        right = literal(node.right, seen);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const part = literal(span.expression, seen);
        if (part === undefined) return undefined;
        value += part + span.literal.text;
      }
      return value;
    }
    return undefined;
  }
  /** @param {ts.Node} node */
  function visit(node) {
    let argument;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      argument = node.moduleSpecifier;
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      argument = node.moduleReference.expression;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      argument = node.argument.literal;
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      argument = node.arguments[0];
    const value = literal(argument);
    if (value !== undefined) found.add(value);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...found];
}

/** @param {string} root @param {string[]} files
 * @param {{ source?: string, roots?: string[], entries?: Set<string> }} options */
export function serverImportViolations(root, files, options = {}) {
  const sourcePrefix = options.source ?? SOURCE;
  const roots = options.roots ?? ROOTS;
  const entries = options.entries ?? ENTRY_POINTS;
  const configPath = join(root, 'packages/server/tsconfig.json');
  const config = ts.readConfigFile(configPath, (f) => ts.sys.readFile(f));
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  if (parsed.errors.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      }),
    );
  const localFiles = files.filter((f) => f.startsWith(sourcePrefix));
  const sources = new Set(files.map((f) => resolve(root, f)));
  /** @type {Map<string, string>} */
  const emitted = new Map();
  const configs = new Map([['packages/server', parsed.options]]);
  for (const file of files) {
    const workspace = file.match(/^(packages\/[^/]+)\/src\//)?.[1];
    if (!workspace || configs.has(workspace)) continue;
    const path = join(root, workspace, 'tsconfig.json');
    if (!existsSync(path)) continue;
    const read = ts.readConfigFile(path, (f) => ts.sys.readFile(f));
    if (read.error) throw new Error(`Cannot read ${path}`);
    const result = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path));
    if (result.errors.length) throw new Error(`Cannot parse ${path}`);
    configs.set(workspace, result.options);
  }
  const outputDirectories = new Set();
  // Virtual emitted files make workspace package exports resolve on clean trees.
  for (const [workspace, options] of configs) {
    if (!options.rootDir || !options.outDir) continue;
    const sourceRoot = resolve(options.rootDir);
    const outputRoot = resolve(options.outDir);
    const packagePath = join(root, workspace, 'package.json');
    if (!existsSync(packagePath)) continue;
    /** @type {unknown} */
    const packageData = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (
      !packageData ||
      typeof packageData !== 'object' ||
      !('name' in packageData) ||
      typeof packageData.name !== 'string'
    )
      throw new Error(`Missing package name in ${packagePath}`);
    const packageName = packageData.name;
    const linkedOutput = join(
      root,
      'node_modules',
      packageName,
      relative(join(root, workspace), outputRoot),
    );
    for (const output of [outputRoot, linkedOutput]) {
      outputDirectories.add(output);
      for (const file of sources) {
        if (!file.startsWith(sourceRoot + '/')) continue;
        const suffix = relative(sourceRoot, file).replace(/\.[cm]?[jt]sx?$/, '');
        for (const ext of ['.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.d.mts', '.d.cts']) {
          const path = join(output, suffix + ext);
          emitted.set(path, file);
          for (let dir = dirname(path); dir.startsWith(output); dir = dirname(dir))
            outputDirectories.add(dir);
        }
      }
    }
  }
  /** @type {ts.ModuleResolutionHost} */
  const host = {
    ...ts.sys,
    fileExists: (f) => sources.has(f) || emitted.has(f) || ts.sys.fileExists(f),
    directoryExists: (d) => outputDirectories.has(d) || ts.sys.directoryExists(d),
    realpath: (f) => (emitted.has(f) ? f : ts.sys.realpath(f)),
  };
  const cache = ts.createModuleResolutionCache(root, (f) => f);
  /** @type {Map<string, Set<string>>} */
  const reverse = new Map();
  const queue = [...localFiles];
  const visited = new Set();
  for (const file of queue) {
    if (visited.has(file)) continue;
    visited.add(file);
    const workspace = file.match(/^(packages\/[^/]+)\//)?.[1];
    const options = configs.get(workspace) ?? parsed.options;
    for (const name of specifiers(file, readFileSync(join(root, file), 'utf8'))) {
      const target = ts.resolveModuleName(
        name,
        join(root, file),
        options,
        host,
        cache,
        undefined,
        ts.ModuleKind.ESNext,
      ).resolvedModule?.resolvedFileName;
      if (!target) continue;
      const source = emitted.get(target) ?? target;
      if (!sources.has(source)) continue;
      const path = relative(root, source).split('\\').join('/');
      queue.push(path);
      if (!reverse.has(path)) reverse.set(path, new Set());
      reverse.get(path).add(file);
    }
  }
  // Reverse traversal finds a shortest diagnostic path for every consumer and
  // handles cycles without repeatedly walking the same subtree.
  return roots
    .flatMap((targetRoot) => {
      /** @type {Map<string, string[]>} */
      const paths = new Map([[targetRoot, [targetRoot]]]);
      const pending = [targetRoot];
      for (const target of pending) {
        for (const file of reverse.get(target) ?? []) {
          if (paths.has(file)) continue;
          paths.set(file, [file, ...(paths.get(target) ?? [])]);
          pending.push(file);
        }
      }
      return [...paths.entries()]
        .filter(
          ([file]) =>
            file.startsWith(sourcePrefix) &&
            file !== targetRoot &&
            !entries.has(file.slice(sourcePrefix.length)) &&
            !(
              targetRoot === ROOTS[0] && [`${SOURCE}app.ts`, `${SOURCE}embedded.ts`].includes(file)
            ) &&
            !testConsumer(file),
        )
        .map(([, path]) => path.join(' -> '));
    })
    .sort();
}

/** @param {string} root */
export function checkServerImports(root) {
  const generated = new Set(generatedFiles(root));
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
    .split('\0')
    .filter(
      (file) =>
        /\.[cm]?[jt]sx?$/.test(file) &&
        !file.startsWith('vendor/') &&
        !generated.has(file) &&
        existsSync(join(root, file)),
    );
  const violations = serverImportViolations(root, [...new Set(files)]);
  if (violations.length)
    throw new Error(`Composition-root back-imports:\n${violations.join('\n')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkServerImports(process.cwd());
    console.log('Server import boundaries passed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
