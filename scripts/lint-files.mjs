import { ESLint } from 'eslint';
import ts from 'typescript';
import { dirname, relative, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { LocalLintCache } from './lint-cache.mjs';
import { AmbientClassificationCache } from './lint-ambient-cache.mjs';

// Keep type graphs small even when a scoped invocation names many files.
const typeBatchSize = 16;

/** @param {ts.Diagnostic} diagnostic */
function diagnosticError(diagnostic) {
  return new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

/**
 * Keep ambient declarations and augmentations even when their file is not imported.
 * Removing these roots would silently change the types seen by type-aware rules.
 * @param {string} file
 * @param {string | undefined} [text]
 */
function contributesAmbientTypes(file, text = ts.sys.readFile(file)) {
  if (/\.d\.[cm]?ts$/.test(file)) return true;
  if (text === undefined) throw new Error(`Cannot read ${file}`);
  const source = ts.createSourceFile(file, text, {
    languageVersion: ts.ScriptTarget.Latest,
    jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
  });
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
 * @param {LocalLintCache} [cache]
 * @param {AmbientClassificationCache} [classifications]
 */
function createLintProject(configPath, cache, classifications) {
  /** @type {ts.ParseConfigFileHost} */
  const configHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw diagnosticError(diagnostic);
    },
  };
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    cache ? cache.observe(configHost) : configHost,
  );
  if (!config) throw new Error(`Cannot read ${configPath}`);
  const [error] = config.errors;
  if (error) throw diagnosticError(error);
  const included = new Set(config.fileNames.map((file) => resolve(file)));
  const ambient = config.fileNames.filter((file) => {
    const classify = () => {
      if (!classifications) return contributesAmbientTypes(file);
      const text = ts.sys.readFile(file);
      if (text === undefined) throw new Error(`Cannot read ${file}`);
      return classifications.classify(file, text, () => contributesAmbientTypes(file, text));
    };
    return cache ? cache.ambient(file, classify) : classify();
  });
  classifications?.save();
  cache?.context.push([configPath, config.fileNames, ambient]);
  /** @param {string[]} files */
  return (files) => {
    for (const file of files) {
      if (!included.has(file)) throw new Error(`${file} is not included in ${configPath}`);
    }
    // Each invocation discovers current configuration and ambient declarations.
    // Discard temporary discovery ASTs and completed ESLint state before parsing.
    globalThis.gc?.();
    const host = Object.assign(ts.createCompilerHost(config.options), {
      useSourceOfProjectReferenceRedirect: () => true,
    });
    return ts.createProgram({
      rootNames: [...new Set([...files, ...ambient])],
      options: config.options,
      projectReferences: config.projectReferences,
      host: cache ? cache.observe(host) : host,
    });
  };
}

/**
 * Create a fresh snapshot for callers outside a single lint invocation.
 * @param {string} configPath
 * @param {string[]} files
 */
export function createLintProgram(configPath, files) {
  return createLintProject(configPath)(files);
}

/**
 * Let each batch's ESLint instance and ESTree maps die before building the next graph.
 * @param {string[]} batch
 * @param {ts.Program} program
 * @param {string} cwd
 */
async function lintBatch(batch, program, cwd) {
  const eslint = new ESLint({
    cwd,
    warnIgnored: false,
    overrideConfig: [
      {
        basePath: cwd,
        files: batch.map((file) => relative(cwd, file).replaceAll('\\', '/')),
        languageOptions: {
          parserOptions: { projectService: false, programs: [program] },
        },
      },
    ],
  });
  return eslint.lintFiles(batch);
}

/**
 * Explicit file paths only, matching the scoped npm command and lint.sh batches.
 * @param {string[]} files
 * @param {string} [cwd]
 * @param {{ cache?: boolean, ambientCache?: boolean }} [options]
 */
export async function lintFiles(files, cwd = process.cwd(), options = {}) {
  if (!files.length) throw new Error('Provide explicit file paths to lint.');
  const base = new ESLint({ cwd, warnIgnored: false });
  /** @type {Map<string, string[]>} */
  const projects = new Map();
  /** @type {unknown[]} */
  const configs = [];
  /** @type {Set<string>} */
  const configFiles = new Set();
  for (const file of files) {
    const absolute = resolve(cwd, file);
    if (await base.isPathIgnored(absolute)) continue;
    /** @type {unknown} */
    const resolvedConfig = await base.calculateConfigForFile(absolute);
    if (options.cache) {
      configs.push([absolute, resolvedConfig]);
      const configFile = await base.findConfigFile(absolute);
      if (configFile) configFiles.add(configFile);
    }
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
  const cache = options.cache
    ? new LocalLintCache(files, cwd, configs, [...configFiles])
    : undefined;
  for (const file of files) cache?.readInput(resolve(cwd, file));
  const typedProjects = [...projects].map(([configPath, roots]) => ({
    roots,
    createProgram: createLintProject(
      configPath,
      cache,
      options.ambientCache === false ? undefined : new AmbientClassificationCache(configPath, cwd),
    ),
  }));
  if (cache?.hit()) return { eslint: base, results, cached: true };
  for (const { roots, createProgram } of typedProjects) {
    for (let offset = 0; offset < roots.length; offset += typeBatchSize) {
      const batch = roots.slice(offset, offset + typeBatchSize);
      results.push(...(await lintBatch(batch, createProgram(batch), cwd)));
      // Unwind the completed async frame before collecting its program on the next batch.
      await setImmediate();
    }
  }
  const untypedFiles = files.filter((file) => !typedFiles.has(resolve(cwd, file)));
  if (untypedFiles.length) results.push(...(await base.lintFiles(untypedFiles)));
  if (results.every((result) => result.errorCount === 0 && result.warningCount === 0))
    cache?.save();
  return { eslint: base, results, cached: false };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const files = process.argv
    .slice(2)
    .filter(
      (argument) =>
        argument !== '--' && argument !== '--local-cache' && argument !== '--no-ambient-cache',
    );
  const cache = process.argv.includes('--local-cache') && !process.env.CI;
  const { eslint, results, cached } = await lintFiles(files, process.cwd(), {
    cache,
    ambientCache: !process.argv.includes('--no-ambient-cache'),
  });
  if (cached) process.stdout.write(`Reused clean lint results for ${files.length} files.\n`);
  process.stdout.write((await eslint.loadFormatter('stylish')).format(results));
  process.exitCode = results.some((result) => result.errorCount > 0) ? 1 : 0;
}
