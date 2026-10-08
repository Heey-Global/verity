/** The same ports must be published by Docker and used by both Server and Gateway. */
export function localPreviewPorts(value = '8100-8119'): number[] {
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match) throw new Error('VERITY_LOCAL_PREVIEW_PORT_RANGE must be a start-end range');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1024 || end > 65535 || end < start || end - start >= 200) {
    throw new Error('local preview range must contain 1-200 ports between 1024 and 65535');
  }
  if (start <= 8083 && end >= 8082) {
    throw new Error('local preview range must not overlap the Verity API ports');
  }
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
