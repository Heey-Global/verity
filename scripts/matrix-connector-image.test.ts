import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync('connectors/matrix/Dockerfile', 'utf8');
const manifest = readFileSync('connectors/matrix/Cargo.toml', 'utf8');
const source = readFileSync('connectors/matrix/src/main.rs', 'utf8');

const packageField = (field: string) =>
  manifest.match(new RegExp(`^\\[package\\][\\s\\S]*?^${field} = "([^"]+)"`, 'mu'))?.[1];
const packageName = packageField('name')!;
const packageVersion = packageField('version')!;

// Dockerfile instructions with line continuations folded, grouped per stage.
const stages = dockerfile
  .replace(/\\\n\s*/gu, ' ')
  .split('\n')
  .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
  .reduce<string[][]>((all, line) => {
    if (line.startsWith('FROM ')) all.push([]);
    all.at(-1)?.push(line);
    return all;
  }, []);
const builder = stages[0]!;
const runtime = stages.at(-1)!;

describe('Matrix connector image build', () => {
  it('reads the package name and version from Cargo.toml', () => {
    expect(packageName).toBe('verity-matrix-connector');
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("lets Cargo remove the dependency-cache placeholder's artifacts", () => {
    // Globs into target/ silently stopped matching after a Rust update, and the
    // placeholder `fn main() {}` shipped as the connector: exit 0, no output.
    const placeholder = builder.find((line) => line.includes('fn main() {}'));
    expect(placeholder).toBeDefined();
    const steps = placeholder!.split('&&').map((step) => step.trim());
    const build = steps.findIndex((step) => step.startsWith('cargo build'));
    const clean = steps.findIndex((step) =>
      new RegExp(`^cargo clean\\b.*--release\\b.*-p ${packageName}$`, 'u').test(step),
    );
    expect(build).toBeGreaterThanOrEqual(0);
    expect(clean).toBeGreaterThan(build);
  });

  it('rejects a binary that does not answer --version after the real build', () => {
    const copySources = builder.findIndex((line) => line.startsWith('COPY connectors/matrix/src'));
    expect(copySources).toBeGreaterThan(0);
    const realBuild = builder.slice(copySources + 1).find((line) => line.includes('cargo build'));
    expect(realBuild).toBeDefined();
    const steps = realBuild!.split('&&').map((step) => step.trim());
    expect(steps[0]).toMatch(/^RUN touch src\/\*\.rs$/u);
    const build = steps.findIndex((step) => step.startsWith('cargo build'));
    const binary = `target/release/${packageName}`;
    const probe = steps.findIndex((step) => step.includes(`${binary} --version`));
    expect(probe).toBeGreaterThan(build);
    const pattern = steps
      .slice(probe)
      .map((step) => step.match(/grep -qx '([^']+)'/u)?.[1])
      .find(Boolean);
    expect(pattern).toBeDefined();
    const expected = new RegExp(`^${pattern}$`, 'u');
    // The real binary prints `<name> <version>`; the placeholder prints nothing.
    expect(`${packageName} ${packageVersion}`).toMatch(expected);
    expect('').not.toMatch(expected);

    // The guarded file is the one the runtime image ships and runs.
    const shipped = runtime.find((line) => line.startsWith('COPY --from=builder'));
    expect(shipped).toContain(`/build/${binary} /usr/local/bin/${packageName}`);
    expect(runtime).toContain(`ENTRYPOINT ["/usr/local/bin/${packageName}"]`);
  });

  it('answers --version with the package name and version before reading configuration', () => {
    expect(source).toMatch(
      /const VERSION_LINE: &str = concat!\(env!\("CARGO_PKG_NAME"\), " ", env!\("CARGO_PKG_VERSION"\)\);/u,
    );
    const main = source.slice(source.indexOf('async fn main()'));
    const versionFlag = main.search(
      /if env::args\(\)\.nth\(1\)\.as_deref\(\) == Some\("--version"\) \{\s*println!\("\{VERSION_LINE\}"\);\s*return Ok\(\(\)\);/u,
    );
    expect(versionFlag).toBeGreaterThan(0);
    // Configuration errors exit non-zero, which would fail the build's probe.
    expect(versionFlag).toBeLessThan(main.indexOf('Config::from_env()'));
  });
});
