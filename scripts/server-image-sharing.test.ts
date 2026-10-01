import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
type Step = {
  name?: string;
  uses?: string;
  with?: Record<string, string | number | boolean>;
  run?: string;
  if?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
};
type Job = { needs?: string[]; steps?: Step[]; env?: Record<string, string> };
const workflow = (name: string) =>
  parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8')) as { jobs: Record<string, Job> };

describe('shared CI image', () => {
  it('builds once and distributes the exact same archive to both installer paths', () => {
    const { jobs } = workflow('ci');
    const producer = jobs['server-image-build'];
    const consumers = jobs['server-image'];
    const builds = Object.values(jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.name === 'Build Verity server image');
    expect(builds).toHaveLength(1);
    expect(consumers.needs).toContain('server-image-build');
    expect(jobs['ci-checks'].needs).toContain('server-image-build');
    expect(jobs['ci-checks'].steps?.[0].run).toContain('require_when_changed server-image-build');
    const upload = producer.steps?.find((step) => step.name === 'Upload Server image archive');
    const download = consumers.steps?.find((step) => step.name === 'Download Server image archive');
    expect(upload?.with?.name).toBeDefined();
    expect(download?.with?.name).toBe(upload?.with?.name);
    // Failed-job reruns reuse the successful producer's artifact and image tag.
    expect(upload?.with?.name).not.toContain('github.run_attempt');
    expect(upload?.with?.overwrite).toBe(true);
    expect(Number(upload?.with?.['retention-days'])).toBeGreaterThanOrEqual(30);
    expect(producer.env?.VERITY_CI_IMAGE).toBe(consumers.env?.VERITY_CI_IMAGE);
    expect(consumers.env?.VERITY_CI_IMAGE).not.toContain('github.run_attempt');
    expect(consumers.env?.VERITY_CI_IMAGE_ARCHIVE).not.toContain('github.run_attempt');
    expect(upload?.with?.['compression-level']).toBe(0);
    expect(upload?.with?.path).toBe(
      String(builds[0].with?.outputs).replace(/^type=docker,dest=/, ''),
    );
    expect(download?.with?.path).toBe('${{ runner.temp }}');
    expect(producer.env?.VERITY_CI_IMAGE_ARCHIVE).toBe(consumers.env?.VERITY_CI_IMAGE_ARCHIVE);
    expect(consumers.steps?.some((step) => step.name === 'Build Verity server image')).toBe(false);
  });
});
