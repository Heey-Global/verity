/** Docker's exclusive layer sizes exclude every layer shared with another image.
 * Summing them is a lower bound, never a deduplicated union or measured saving. */
export async function readImageDiskUsage(
  read: () => Promise<unknown>,
): Promise<ReadonlyMap<string, number>> {
  const body = await read();
  if (
    !body ||
    typeof body !== 'object' ||
    !('Images' in body) ||
    !Array.isArray(body.Images) ||
    body.Images.length > 10_000
  )
    throw new Error('Invalid image disk-usage inventory');
  const result = new Map<string, number>();
  for (const value of body.Images as unknown[]) {
    if (!value || typeof value !== 'object') throw new Error('Invalid image disk usage');
    const row = value as { Id?: unknown; Size?: unknown; SharedSize?: unknown };
    if (
      typeof row.Id !== 'string' ||
      !Number.isSafeInteger(row.Size) ||
      !Number.isSafeInteger(row.SharedSize) ||
      (row.Size as number) < 0 ||
      (row.SharedSize as number) < 0 ||
      (row.SharedSize as number) > (row.Size as number)
    )
      throw new Error('Incomplete image layer sizes');
    result.set(row.Id, (row.Size as number) - (row.SharedSize as number));
  }
  return result;
}
