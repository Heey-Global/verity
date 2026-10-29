import { ESLint } from 'eslint';
import ts from 'typescript';
import { dirname, relative, resolve } from 'node:path';

/** @param {ts.Diagnostic} diagnostic */
function diagnosticError(diagnostic) {
  return new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

/**
 * Keep ambient declarations and augmentations even when their file is not imported.
 * Removing these roots would silently change the types seen by type-aware rules.
 * @param {string} file
 */
function contributesAmbientTypes(file) {
  if (/\.d\.[cm]?ts$/.test(file)) return true;
  const text = ts.sys.readFile(file);
  if (text === undefined) throw new Error(`Cannot read ${file}`);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  return (
    !ts.isExternalModule(source) ||
    source.statements.some((statement) => ts.isModuleDeclaration(statement))
  );
}

/**
 * Root the type graph at the requested files instead of every test in the project.
 * Imports still load normally, and project references resolve to current sources,
 * so lint never relies on potentially stale generated declarations.
 * @param {string} configPath
 * @param {string[]} files Absolute paths already covered by this project's include.
 */
export function createLintProgram(configPath, files) {
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw diagnosticError(diagnostic);
      },
    },
  );
  if (!config) throw new Error(`Cannot read ${configPath}`);
  const [error] = config.errors;
  if (error) throw diagnosticError(error);
  const included = new Set(config.fileNames.map((file) => resolve(file)));
  for (const file of files) {
    if (!included.has(file)) throw new Error(`${file} is not included in ${configPath}`);
  }
  const ambient = config.fileNames.filter(contributesAmbientTypes);
  const host = Object.assign(ts.createCompilerHost(config.options), {
    useSourceOfProjectReferenceRedirect: () => true,
  });
  return ts.createProgram({
    rootNames: [...new Set([...files, ...ambient])],
    options: config.options,
    projectReferences: config.projectReferences,
    host,
  });
}

/**
 * Explicit file paths only, matching the scoped npm command and lint.sh batches.
 * @param {string[]} files
 * @param {string} [cwd]
 */
export async function lintFiles(files, cwd = process.cwd()) {
  if (!files.length) throw new Error('Provide explicit file paths to lint.');
  const base = new ESLint({ cwd, warnIgnored: false });
  /** @type {Map<string, string[]>} */
  const projects = new Map();
  for (const file of files) {
    const absolute = resolve(cwd, file);
    if (await base.isPathIgnored(absolute)) continue;
    /** @type {unknown} */
    const resolvedConfig = await base.calculateConfigForFile(absolute);
    const config = /** @type {import('eslint').Linter.Config | undefined} */ (resolvedConfig);
    if (!config?.languageOptions?.parserOptions?.projectService) continue;
    const configPath = ts.findConfigFile(dirname(absolute), (path) => ts.sys.fileExists(path));
    if (!configPath) throw new Error(`No tsconfig.json for ${file}`);
    const roots = projects.get(configPath) ?? [];
    roots.push(absolute);
    projects.set(configPath, roots);
  }
  /** @type {import('eslint').ESLint.LintResult[]} */
  const results = [];
  const typedFiles = new Set([...projects.values()].flat());
  // Release each project's program before starting another one in a mixed batch.
  for (const [configPath, roots] of projects) {
    const eslint = new ESLint({
      cwd,
      warnIgnored: false,
      overrideConfig: [
        {
          basePath: cwd,
          files: roots.map((file) => relative(cwd, file).replaceAll('\\', '/')),
          languageOptions: {
            parserOptions: {
              projectService: false,
              programs: [createLintProgram(configPath, roots)],
            },
          },
        },
      ],
    });
    results.push(...(await eslint.lintFiles(roots)));
  }
  const untypedFiles = files.filter((file) => !typedFiles.has(resolve(cwd, file)));
  if (untypedFiles.length) results.push(...(await base.lintFiles(untypedFiles)));
  return { eslint: base, results };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const files = process.argv.slice(2).filter((argument) => argument !== '--');
  const { eslint, results } = await lintFiles(files);
  process.stdout.write((await eslint.loadFormatter('stylish')).format(results));
  process.exitCode = results.some((result) => result.errorCount > 0) ? 1 : 0;
}
