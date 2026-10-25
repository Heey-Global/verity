/** Fixed storage prevents diagnostic capture from growing with process output. */
export class StderrTail {
  private readonly bytes: Buffer;
  private offset = 0;
  private length = 0;

  constructor(capacity = 64 * 1024) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('Invalid stderr capacity');
    this.bytes = Buffer.alloc(capacity);
  }

  clear(): void {
    this.offset = 0;
    this.length = 0;
  }

  push(chunk: Buffer | string): void {
    let source = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (source.length >= this.bytes.length) {
      source = source.subarray(-this.bytes.length);
      source.copy(this.bytes);
      this.offset = 0;
      this.length = this.bytes.length;
      return;
    }
    const first = Math.min(source.length, this.bytes.length - this.offset);
    source.copy(this.bytes, this.offset, 0, first);
    source.copy(this.bytes, 0, first);
    this.offset = (this.offset + source.length) % this.bytes.length;
    this.length = Math.min(this.bytes.length, this.length + source.length);
  }

  text(): string {
    const start = (this.offset - this.length + this.bytes.length) % this.bytes.length;
    const first = Math.min(this.length, this.bytes.length - start);
    const ordered = Buffer.concat([
      this.bytes.subarray(start, start + first),
      this.bytes.subarray(0, this.length - first),
    ]);
    // A byte cap can cut the first UTF-8 character; omit its continuation bytes.
    let boundary = 0;
    while (boundary < ordered.length && (ordered[boundary]! & 0xc0) === 0x80) boundary++;
    return ordered.subarray(boundary).toString('utf8');
  }
}
