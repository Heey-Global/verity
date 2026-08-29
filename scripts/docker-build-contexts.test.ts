import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('selective Docker build contexts', () => {
  it('includes every root TypeScript project in builders that run the root build', () => {
    const rootConfig = JSON.parse(readFileSync('tsconfig.json', 'utf8')) as {
      references: Array<{ path: string }>;
    };

    for (const dockerfilePath of ['deploy/Dockerfile', 'deploy/secret-job-worker.Dockerfile']) {
      const dockerfile = readFileSync(dockerfilePath, 'utf8');
      for (const { path } of rootConfig.references) {
        if (!path.startsWith('packages/')) continue;
        expect(dockerfile, `missing ${path} from ${dockerfilePath} builder`).toContain(
          `COPY ${path} ${path}`,
        );
      }
    }
  });

  it('preserves the preview package ESM contract in both runtime images', () => {
    for (const dockerfilePath of [
      'deploy/preview-edge.Dockerfile',
      'deploy/preview-connector.Dockerfile',
    ]) {
      const dockerfile = readFileSync(dockerfilePath, 'utf8');
      expect(dockerfile, `missing runtime package.json from ${dockerfilePath}`).toContain(
        'COPY --from=build /src/packages/preview-tunnel/package.json ./package.json',
      );
    }
  });
});
