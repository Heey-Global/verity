#!/usr/bin/env node
// Every source file in the repository stays at or below FILE_LINE_LIMIT lines
// (docs/adr/0029-module-boundaries-and-file-size.md). Files that were already
// larger are recorded with their current line count in file-size-debt.json, and
// that record may only shrink: a recorded file must not grow, a new file must
// not cross the limit, and a file that got smaller must lower its entry in the
// same change, so the next change cannot quietly spend the room it freed.
//
// Without this check nothing stops a composition root from growing one wiring
// block at a time until type-aware lint no longer fits its memory budget, which
// is how packages/server/src/server.ts grew back after it was first split up.
//
// Usage: node scripts/file-size-guard.mjs [--update]
//   --update lowers or removes debt entries for files that shrank. It never
//   raises an entry or records a new file.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FILE_LINE_LIMIT = 1500;
export const DEBT_FILE = 'scripts/file-size-debt.json';
const BUNDLE_SCRIPT = 'scripts/build-runner-worker.mjs';

const SOURCE = /\.[cm]?[jt]sx?$/;
// Declarations describe code that lives elsewhere; vendor/ holds third-party
// code kept as published.
const EXCLUDED = [/\.d\.[cm]?ts$/, /^vendor\//];

/** Paths of generated bundles, read from the script that writes them, so a
 *  moved bundle cannot leave a stale exclusion behind.
 *  @param {string} root */
export function generatedFiles(root) {
  const script = readFileSync(join(root, BUNDLE_SCRIPT), 'utf8');
  const outfile = script.match(/^const outfile = '([^']+)';$/m)?.[1];
  if (!outfile) throw new Error(`${BUNDLE_SCRIPT} no longer declares its outfile`);
  return [outfile];
}

/** Tracked and new unignored source files that exist in the working tree.
 *  @param {string} root */
export function guardedFiles(root) {
  const listed = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const generated = new Set(generatedFiles(root));
  return [...new Set(listed.stdout.split('\0'))]
    .filter((file) => SOURCE.test(file))
    .filter((file) => !generated.has(file) && !EXCLUDED.some((pattern) => pattern.test(file)))
    .filter((file) => existsSync(join(root, file)))
    .sort();
}

/** Lines as an editor numbers them: a final line without a newline counts.
 *  @param {string} text */
export function lineCount(text) {
  if (text.length === 0) return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

/** Every guarded file above the limit, with its line count.
 *  @param {string} root */
export function oversizedFiles(root, limit = FILE_LINE_LIMIT) {
  /** @type {Record<string, number>} */
  const found = {};
  for (const file of guardedFiles(root)) {
    const lines = lineCount(readFileSync(join(root, file), 'utf8'));
    if (lines > limit) found[file] = lines;
  }
  return found;
}

/**
 * Differences between the oversized files and the recorded debt, as messages.
 * @param {Record<string, number>} found
 * @param {Record<string, number>} debt
 */
export function compareWithDebt(found, debt, limit = FILE_LINE_LIMIT) {
  const problems = [];
  for (const [file, lines] of Object.entries(found)) {
    const recorded = debt[file];
    if (recorded === undefined) {
      problems.push(
        `${file}: ${lines} lines exceeds the ${limit}-line limit. Split it into modules instead of recording it.`,
      );
    } else if (lines > recorded) {
      problems.push(
        `${file}: grew from ${recorded} to ${lines} lines. Recorded files may only shrink; move the new code into a module of its own.`,
      );
    } else if (lines < recorded) {
      problems.push(
        `${file}: shrank from ${recorded} to ${lines} lines. Lower its entry in ${DEBT_FILE} (node scripts/file-size-guard.mjs --update).`,
      );
    }
  }
  for (const [file, recorded] of Object.entries(debt)) {
    if (file in found) continue;
    problems.push(
      `${file}: recorded at ${recorded} lines but is now within the limit or gone. Remove its entry from ${DEBT_FILE} (node scripts/file-size-guard.mjs --update).`,
    );
  }
  return problems.sort();
}

/** Debt lowered to what shrank; growth and new files are left for the check to report.
 *  @param {Record<string, number>} found
 *  @param {Record<string, number>} debt */
export function loweredDebt(found, debt) {
  /** @type {Record<string, number>} */
  const lowered = {};
  for (const [file, recorded] of Object.entries(debt)) {
    const lines = found[file];
    if (lines !== undefined) lowered[file] = Math.min(lines, recorded);
  }
  return sortedRecord(lowered);
}

/** @param {Record<string, number>} record */
function sortedRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** @param {string} root @returns {Record<string, number>} */
export function readDebt(root) {
  const parsed = /** @type {unknown} */ (JSON.parse(readFileSync(join(root, DEBT_FILE), 'utf8')));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${DEBT_FILE} must map file paths to line counts`);
  }
  /** @type {Record<string, number>} */
  const debt = {};
  for (const [file, lines] of Object.entries(/** @type {Record<string, unknown>} */ (parsed))) {
    if (typeof lines !== 'number' || !Number.isInteger(lines) || lines <= 0) {
      throw new Error(`${DEBT_FILE}: ${file} must record a positive line count`);
    }
    debt[file] = lines;
  }
  return debt;
}

/** @param {string} root @param {Record<string, number>} debt */
export function writeDebt(root, debt) {
  writeFileSync(join(root, DEBT_FILE), `${JSON.stringify(sortedRecord(debt), null, 2)}\n`);
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const found = oversizedFiles(root);
  if (process.argv.includes('--update')) writeDebt(root, loweredDebt(found, readDebt(root)));
  const problems = compareWithDebt(found, readDebt(root));
  if (problems.length === 0) return 0;
  process.stderr.write(
    `File size check failed (limit ${FILE_LINE_LIMIT} lines, docs/adr/0029-module-boundaries-and-file-size.md):\n`,
  );
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
