import { describeBuild, runningReleaseVersion } from './buildInfo';
import { BUILD_COMMIT } from './buildInfo.generated';

describe('describeBuild', () => {
  it('reports the dev placeholder as not stamped', () => {
    expect(describeBuild('dev')).toEqual({ stamped: false, text: 'dev' });
  });

  it('treats an empty or whitespace commit as not stamped', () => {
    expect(describeBuild('')).toEqual({ stamped: false, text: 'dev' });
    expect(describeBuild('   ')).toEqual({ stamped: false, text: 'dev' });
  });

  it('shortens a full commit sha to seven characters', () => {
    expect(describeBuild('a1b2c3d4e5f6a7b8c9d0')).toEqual({ stamped: true, text: 'a1b2c3d' });
  });

  it('leaves an already-short commit untouched', () => {
    expect(describeBuild('a1b2c3d')).toEqual({ stamped: true, text: 'a1b2c3d' });
  });

  it('trims surrounding whitespace before shortening', () => {
    expect(describeBuild('  a1b2c3d4e5  ')).toEqual({ stamped: true, text: 'a1b2c3d' });
  });

  it('defaults to the stamped constant when called with no argument', () => {
    // Assert against the imported constant rather than a hard-coded 'dev' so the
    // test holds whether or not buildInfo.generated.ts has been locally stamped.
    expect(describeBuild()).toEqual(describeBuild(BUILD_COMMIT));
  });
});

describe('runningReleaseVersion', () => {
  it('shows the OTA version stamped into the running bundle', () => {
    expect(runningReleaseVersion('1.4.0', '1.4.2')).toBe('1.4.2');
  });

  it('falls back to the native version for the embedded bundle', () => {
    expect(runningReleaseVersion('1.5.0', null)).toBe('1.5.0');
  });

  it('uses a safe sentinel when neither version is available', () => {
    expect(runningReleaseVersion(null, null)).toBe('0.0.0');
  });
});
