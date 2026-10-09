import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error -- native patch definitions are JavaScript
import { NATIVE_PATCHES, applyNativePatch } from './patch-mobile-native-deps.mjs';

const patch = NATIVE_PATCHES.find(
  (entry: { package: string }) => entry.package === 'react-native-unistyles',
)!;
const installedSource = 'node_modules/react-native-unistyles/ios/UnistylesModuleOnLoad.mm';
const patched = applyNativePatch(patch, patch.before).source;

function runLifecycle(source: string) {
  const handoffCleanup = source.match(/}, \[\] \{([\s\S]*?)\n {4}\}\);/)?.[1] ?? '';
  const helper = source.match(/class VerityUnistylesLifecycle \{[\s\S]*?\n};/)?.[0] ?? '';
  const invalidate = source
    .match(/- \(void\)invalidate \{([\s\S]*?)\n}/)![1]!
    .replace('[super invalidate];', '')
    .replaceAll('(__bridge const void*)self', 'self');
  const root = mkdtempSync(join(tmpdir(), 'unistyles-reload-'));
  try {
    writeFileSync(
      join(root, 'reload.cpp'),
      `
#include <mutex>
#include <cassert>
${helper}
${helper ? 'static VerityUnistylesLifecycle verityUnistylesLifecycle;' : ''}
bool configured = false;
int retainedStyles = 0;
namespace core { struct UnistylesRegistry {
  static UnistylesRegistry& get() { static UnistylesRegistry registry; return registry; }
  void destroy() { configured = false; retainedStyles = 0; }
}; }
void install(const void* self) {
  ${helper ? `verityUnistylesLifecycle.install(self, [] { configured = true; ++retainedStyles; }, [] { ${handoffCleanup} });` : 'configured = true; ++retainedStyles;'}
}
void invalidate(const void* self) { ${invalidate} }
int main() {
  int oldRuntime, nextRuntime;
  install(&oldRuntime);
  install(&nextRuntime);
  assert(retainedStyles == 1); // New runtimes must never inherit old JSI style objects.
  invalidate(&oldRuntime);
  assert(configured); // Retired runtimes must not delete the new theme registry.
  invalidate(&nextRuntime);
  assert(!configured);
  install(&oldRuntime);
  invalidate(&oldRuntime);
  assert(!configured);
  install(&nextRuntime);
  assert(retainedStyles == 1); // New runtimes must never inherit old JSI style objects.
  invalidate(&oldRuntime);
  assert(configured);
  invalidate(&nextRuntime);
  invalidate(&nextRuntime);
  assert(!configured);
}
`,
    );
    execFileSync('g++', [
      '-std=c++17',
      '-pthread',
      join(root, 'reload.cpp'),
      '-o',
      join(root, 'reload'),
    ]);
    return spawnSync(join(root, 'reload'), { cwd: root }).status;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('keeps the next runtime configured when the previous runtime finishes teardown', () => {
  expect(patched).toContain('verityUnistylesLifecycle.install((__bridge const void*)self, [&] {');
  expect(runLifecycle(patched)).toBe(0);
});

it('rejects an ownership handoff that retains old runtime style objects', () => {
  const missingCleanup = patched.replace(
    'if (owner != nullptr && owner != nextOwner) destroy();',
    '',
  );
  expect(runLifecycle(missingCleanup)).not.toBe(0);
});

it('detects a removed native handoff cleanup callback', () => {
  const missingCallback = patched.replace(
    /(}, \[\] \{\s*)core::UnistylesRegistry::get\(\)\.destroy\(\);/,
    '$1',
  );
  expect(missingCallback).not.toBe(patched);
  expect(runLifecycle(missingCallback)).not.toBe(0);
});

it('detects the original unconditional teardown clearing the new runtime', () => {
  expect(runLifecycle(patch.before)).not.toBe(0);
});

it('applies the native ownership patch idempotently and rejects source drift', () => {
  expect(applyNativePatch(patch, patched).status).toBe('already-patched');
  expect(() =>
    applyNativePatch(patch, patch.before.replace('get().destroy()', 'get().reset()')),
  ).toThrow();
});

it.skipIf(!existsSync(installedSource))(
  'checks the installed native source when mobile dependencies are available',
  () => {
    expect(applyNativePatch(patch, readFileSync(installedSource, 'utf8')).source).toBe(patched);
  },
);
