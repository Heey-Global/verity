/** Bounded, content-defined chunks. Gear state resets at each boundary. */
const MIN_CHUNK = 64 * 1024;
export const MAX_CHUNK = 1024 * 1024;
const MASK = (1 << 18) - 1;
const GEAR = Array.from({ length: 256 }, (_, index) => {
  let value = (index + 1) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
});

export async function* chunkContent(source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  let buffer = Buffer.allocUnsafe(MAX_CHUNK);
  let length = 0;
  let hash = 0;
  for await (const block of source) {
    for (const byte of block) {
      buffer[length++] = byte;
      hash = ((hash << 1) + GEAR[byte]!) >>> 0;
      if (length >= MIN_CHUNK && ((hash & MASK) === 0 || length === MAX_CHUNK)) {
        yield buffer.subarray(0, length);
        buffer = Buffer.allocUnsafe(MAX_CHUNK);
        length = 0;
        hash = 0;
      }
    }
  }
  if (length > 0) yield buffer.subarray(0, length);
}
