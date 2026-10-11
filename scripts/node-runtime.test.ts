import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { satisfies, valid } from 'semver';
import { describe, expect, it } from 'vitest';

const selected = readFileSync('.nvmrc', 'utf8').trim();
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
  engines: { node: string };
  devDependencies: Record<string, string>;
};
const tracked = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
const files = tracked.stdout.split('\0').filter(Boolean);

describe('owned Node runtime configuration', () => {
  it('keeps the contributor pin inside the supported runtime contract', () => {
    expect(valid(selected)).toBe(selected);
    expect(satisfies(selected, manifest.engines.node)).toBe(true);
    expect(manifest.devDependencies['@types/node']?.split('.')[0]).toBe(selected.split('.')[0]);
  });

  it('keeps CI and container runtimes on the contributor pin', () => {
    expect(tracked.status).toBe(0);
    const workflowPins: string[] = [];
    const imagePins: string[] = [];
    for (const file of files) {
      if (
        !file.startsWith('.github/workflows/') &&
        !file.startsWith('deploy/') &&
        !file.startsWith('features/verity-sandbox-toolkit/prebuilt/') &&
        !file.startsWith('scripts/test-runner-claude-live-')
      )
        continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/node-version:\s*['"]?([^'"\s]+)/gu)) {
        workflowPins.push(`${file}: ${match[1]}`);
        expect(match[1], file).toBe(selected);
      }
      // A floating or older container pin can leave smoke checks green on a
      // different native-module ABI than the image they are meant to verify.
      for (const match of source.matchAll(/node:(\d[^\s'"@]*)(?:@sha256:([a-f0-9]{64}))?/gu)) {
        imagePins.push(`${file}: ${match[1]}`);
        expect(match[1], file).toMatch(new RegExp(`^${selected.replaceAll('.', '\\.')}-`));
        expect(match[2], `${file} must retain an immutable image digest`).toBeDefined();
      }
    }
    for (const file of files.filter((name) => name.endsWith('Dockerfile'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /distroless\/nodejs(\d+)-[^:\s]+:nonroot@sha256:[a-f0-9]{64}/gu,
      )) {
        expect(match[1], file).toBe(selected.split('.')[0]);
        expect(source, 'distroless patch lag must not select a different runtime').toContain(
          'COPY --from=builder /usr/local/bin/node /nodejs/bin/node',
        );
      }
    }
    expect(workflowPins.length).toBeGreaterThan(0);
    expect(imagePins.length).toBeGreaterThan(0);
  });

  it('keeps remote mobile builds and injected devcontainer Node aligned', () => {
    const eas = JSON.parse(readFileSync('apps/mobile/eas.json', 'utf8')) as {
      build: Record<string, { node?: string }>;
    };
    expect(Object.keys(eas.build).length).toBeGreaterThan(0);
    for (const [profile, config] of Object.entries(eas.build)) {
      expect(config.node, profile).toBe(selected);
    }
    const provisioner = readFileSync('packages/server/src/provisioner.ts', 'utf8');
    const injected = /DEVCONTAINER_NODE_FEATURE_OPTIONS = \{ version: '([^']+)' \}/u.exec(
      provisioner,
    );
    expect(injected?.[1], 'fleet devcontainers must use the verified runtime').toBe(selected);
  });

  it('lets Renovate discover remote build pins from the real configuration', () => {
    const config = JSON.parse(readFileSync('renovate.json', 'utf8')) as {
      customManagers: Array<{
        datasourceTemplate?: string;
        depNameTemplate?: string;
        matchStrings: string[];
      }>;
    };
    const managers = config.customManagers.filter(
      (manager) =>
        manager.datasourceTemplate === 'node-version' && manager.depNameTemplate === 'node',
    );
    expect(managers.length).toBeGreaterThan(0);
    for (const file of ['apps/mobile/eas.json', 'packages/server/src/provisioner.ts']) {
      const source = readFileSync(file, 'utf8');
      const pins = managers.flatMap((manager) =>
        manager.matchStrings.flatMap((pattern) =>
          [...source.matchAll(new RegExp(pattern, 'gu'))].map(
            (match) => match.groups?.currentValue,
          ),
        ),
      );
      expect(pins.length, file).toBeGreaterThan(0);
      expect(
        pins.every((pin) => pin === selected),
        file,
      ).toBe(true);
    }
  });

  it('lets Renovate update smoke image versions and digests together', () => {
    const config = JSON.parse(readFileSync('renovate.json', 'utf8')) as {
      customManagers: Array<{
        datasourceTemplate?: string;
        depNameTemplate?: string;
        managerFilePatterns: string[];
        matchStrings: string[];
      }>;
    };
    const managers = config.customManagers.filter(
      (manager) => manager.datasourceTemplate === 'docker' && manager.depNameTemplate === 'node',
    );
    for (const file of files.filter(
      (name) =>
        (name.startsWith('deploy/bin/verity-project-relay-') && name.endsWith('smoke')) ||
        (name.startsWith('scripts/test-runner-claude-live-') && name.endsWith('.sh')) ||
        name === '.github/workflows/ci.yml',
    )) {
      const source = readFileSync(file, 'utf8');
      const pins = managers
        .filter((manager) =>
          manager.managerFilePatterns.some((pattern) =>
            new RegExp(pattern.slice(1, -1), 'u').test(file),
          ),
        )
        .flatMap((manager) =>
          manager.matchStrings.flatMap((pattern) => [
            ...source.matchAll(new RegExp(pattern, 'gu')),
          ]),
        );
      expect(pins.length, file).toBeGreaterThan(0);
      for (const pin of pins) {
        expect(pin.groups?.currentValue, file).toMatch(
          new RegExp(`^${selected.replaceAll('.', '\\.')}-`),
        );
        expect(pin.groups?.currentDigest, file).toMatch(/^sha256:[a-f0-9]{64}$/u);
      }
    }
  });
});
