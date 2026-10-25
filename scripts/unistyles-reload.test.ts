import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- executable JavaScript helper
import { resolvePackageRoot } from './patch-mobile-native-deps.mjs';

// Contract-only CI installs omit native dependencies; the mobile job requires them.
let root: string | undefined;
try {
  root = resolvePackageRoot(process.cwd(), 'react-native-unistyles');
} catch (error) {
  if (process.env.VERITY_REQUIRE_MOBILE_NATIVE === '1') throw error;
}
describe.skipIf(root === undefined)('installed Unistyles reload protections', () => {
  const source = (file: string) =>
    root === undefined ? '' : readFileSync(join(root, file), 'utf8');
  const registry = source('cxx/core/UnistylesRegistry.cpp');
  const header = source('cxx/core/UnistylesRegistry.h');
  const moduleSource = source('ios/UnistylesModuleOnLoad.mm');
  const wrapper = source('cxx/core/UnistyleWrapper.h');

  function runLifecycle(code: string) {
    const methods = code.slice(
      code.indexOf('uint64_t core::UnistylesRegistry::takeOwnership()'),
      code.indexOf('core::UnistylesRegistry::OwnedState core::UnistylesRegistry::takeOwnedState()'),
    );
    const current = header.match(
      /inline bool isCurrent\(uint64_t generation\) const noexcept \{[\s\S]*?\n {4}}/,
    )![0];
    const dir = mkdtempSync(join(tmpdir(), 'unistyles-reload-'));
    try {
      writeFileSync(
        join(dir, 'reload.cpp'),
        `
#include <atomic>
#include <cassert>
#include <cstdint>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <utility>
namespace core { class UnistylesRegistry {
public:
 struct Sheet { std::unordered_map<int, int> unistyles; };
 struct OwnedState { std::unordered_map<int, std::shared_ptr<Sheet>> styleSheets; };
 std::mutex _ownershipMutex;
 std::atomic<uint64_t> _generation{0};
 uint64_t _lastGeneration = 0;
 std::unordered_map<uint64_t, OwnedState> _replacedStates;
 OwnedState active;
 uint64_t takeOwnership();
 void releaseOwnership(uint64_t generation);
 ${current}
 OwnedState takeOwnedState() { return std::exchange(active, {}); }
}; }
${methods}
int main() {
 core::UnistylesRegistry r;
 auto old = r.takeOwnership();
 auto oldSheet = std::make_shared<core::UnistylesRegistry::Sheet>();
 oldSheet->unistyles[1] = 1;
 r.active.styleSheets[1] = oldSheet;
 auto next = r.takeOwnership();
 assert(next != old && !r.isCurrent(old) && r.isCurrent(next));
 assert(r.active.styleSheets.empty());
 assert(oldSheet->unistyles.size() == 1);
 auto nextSheet = std::make_shared<core::UnistylesRegistry::Sheet>();
 nextSheet->unistyles[1] = 2;
 r.active.styleSheets[1] = nextSheet;
 r.releaseOwnership(old);
 assert(oldSheet->unistyles.empty());
 assert(r.isCurrent(next) && nextSheet->unistyles.size() == 1);
 r.releaseOwnership(old);
 assert(r.isCurrent(next));
 r.releaseOwnership(next);
 assert(!r.isCurrent(next) && nextSheet->unistyles.empty());
 assert(!r.isCurrent(0));
}
`,
      );
      execFileSync('g++', [
        '-std=c++17',
        '-pthread',
        join(dir, 'reload.cpp'),
        '-o',
        join(dir, 'reload'),
      ]);
      return spawnSync(join(dir, 'reload'), { cwd: dir }).status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('isolates retiring runtime state using the installed ownership implementation', () => {
    expect(moduleSource).toContain('_generation = core::UnistylesRegistry::get().takeOwnership();');
    expect(moduleSource).toContain('runOnJSThread, _generation');
    expect(moduleSource).toContain('releaseOwnership(_generation)');
    expect(runLifecycle(registry)).toBe(0);
  });

  it('detects teardown that clears the replacement runtime', () => {
    const broken = registry.replace('if (this->isCurrent(generation)) {', 'if (true) {');
    expect(broken).not.toBe(registry);
    expect(runLifecycle(broken)).not.toBe(0);
  });

  it('detects a handoff that retains styles in the active registry', () => {
    const broken = registry.replace(
      'this->_replacedStates[previousGeneration] = this->takeOwnedState();',
      'this->_replacedStates[previousGeneration] = {};',
    );
    expect(broken).not.toBe(registry);
    expect(runLifecycle(broken)).not.toBe(0);
  });

  function assertStyleGuard(code: string) {
    // A stale getter can otherwise pass a null style to Parser::rebuildUnistyle.
    expect(code).toMatch(
      /auto unistyle = unistylesRuntime->ownsRegistry\(\)[\s\S]*?\? registry.getUnistyleById\(unistyleID\)[\s\S]*?: nullptr;/,
    );
    const guard = code.indexOf('if (unistyle == nullptr)');
    expect(guard).toBeGreaterThan(-1);
    const rebuild = code.indexOf('rebuildUnistyle', guard);
    expect(rebuild).toBeGreaterThan(guard);
    expect(code.slice(guard, rebuild)).toContain('throw jsi::JSError');
  }

  it('guards stale and missing styles before rebuilding', () => {
    assertStyleGuard(wrapper);
    expect(() =>
      assertStyleGuard(wrapper.replace('if (unistyle == nullptr)', 'if (false)')),
    ).toThrow();
    expect(() =>
      assertStyleGuard(wrapper.replace('unistylesRuntime->ownsRegistry()', 'true')),
    ).toThrow();
  });
});
