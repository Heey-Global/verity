/**
 * @typedef {{ tag_name: string; body: string | null; draft: boolean; prerelease: boolean }} PromotionRelease
 */

/**
 * Include staged versions only up to the approved candidate, after the delivered baseline.
 * @param {PromotionRelease[]} releases
 * @param {'server' | 'mobile-native'} product
 * @param {string} version
 */
export function promotionChangelog(releases, product, version) {
  const prefix = product === 'server' ? 'v' : 'mobile-v';
  /** @param {string} left @param {string} right */
  const compare = (left, right) => {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    return (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
  };
  const relevant = releases
    .filter((release) => {
      if (!release.tag_name.startsWith(prefix)) return false;
      const value = release.tag_name.slice(prefix.length);
      return /^\d+\.\d+\.\d+$/.test(value) && compare(value, version) <= 0;
    })
    .sort((a, b) => compare(b.tag_name.slice(prefix.length), a.tag_name.slice(prefix.length)));
  const baseline = relevant.find(
    (release) =>
      !release.draft && !release.prerelease && release.tag_name !== `${prefix}${version}`,
  );
  const changes = relevant.filter(
    (release) =>
      (release.tag_name === `${prefix}${version}` || (!release.draft && release.prerelease)) &&
      (!baseline ||
        compare(release.tag_name.slice(prefix.length), baseline.tag_name.slice(prefix.length)) > 0),
  );
  if (!changes.some((release) => release.tag_name === `${prefix}${version}`))
    throw new Error('Promotion candidate release notes are missing');
  return `## Changes since ${baseline ? `production ${baseline.tag_name}` : 'the first release'}\n\n${changes
    .map(
      (release) =>
        `### ${release.tag_name}\n\n${release.body?.trim() || 'No release notes recorded.'}`,
    )
    .join('\n\n')}`;
}
