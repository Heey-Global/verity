import { Transform, type TransformCallback } from 'node:stream';

/** Test-only byte gate: preserve the upgrade and every frame, withholding a
 * suffix before the relay decoder rather than suppressing a decoded message. */
export class FrameGate extends Transform {
  private pending = Buffer.alloc(0);
  private upgraded = false;
  private armed = false;
  private held: { suffix: Buffer; callback: TransformCallback } | undefined;
  intercepted = 0;
  released = 0;
  missingBytes = 0;
  private readonly onHeld: () => void;
  constructor(onHeld: () => void) {
    super();
    this.onHeld = onHeld;
  }
  arm(): void {
    this.armed = true;
  }
  release(): void {
    const held = this.held;
    if (!held) throw new Error('No frame held');
    this.held = undefined;
    this.released++;
    this.push(held.suffix);
    this.consume(held.callback);
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const held = this.held;
    this.held = undefined;
    this.pending = Buffer.alloc(0);
    held?.callback(error ?? new Error('Frame gate aborted'));
    callback(error);
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    this.consume(callback);
  }
  private consume(callback: TransformCallback): void {
    if (!this.upgraded) {
      const end = this.pending.indexOf('\r\n\r\n');
      if (end < 0) {
        callback(this.pending.length > 8192 ? new Error('Upgrade too large') : undefined);
        return;
      }
      this.push(this.pending.subarray(0, end + 4));
      this.pending = this.pending.subarray(end + 4);
      this.upgraded = true;
    }
    while (this.pending.length >= 2) {
      const frame = this.pending;
      const masked = (frame[1]! & 128) !== 0;
      let length = frame[1]! & 127;
      let header = 2;
      if (length === 126) {
        if (frame.length < 4) break;
        length = frame.readUInt16BE(2);
        header = 4;
      } else if (length === 127) {
        if (frame.length < 10) break;
        const wide = frame.readBigUInt64BE(2);
        if (wide > 128n * 1024n) {
          callback(new Error('Frame too large'));
          return;
        }
        length = Number(wide);
        header = 10;
      }
      if (masked) header += 4;
      const total = header + length;
      if (frame.length < total) break;
      this.pending = frame.subarray(total);
      if (this.armed && (frame[0]! & 15) === 1 && length > 4096) {
        const payload = Buffer.from(frame.subarray(header, total));
        if (masked)
          for (let i = 0; i < payload.length; i++)
            payload[i] = payload[i]! ^ frame[header - 4 + (i % 4)]!;
        let data = false;
        try {
          data = (JSON.parse(payload.toString()) as { type?: unknown }).type === 'stream.data';
        } catch {
          /* Non-DATA frames pass unchanged. */
        }
        if (data) {
          this.armed = false;
          this.intercepted++;
          this.missingBytes = 295;
          this.push(frame.subarray(0, total - this.missingBytes));
          this.held = { suffix: frame.subarray(total - this.missingBytes, total), callback };
          this.onHeld();
          return;
        }
      }
      this.push(frame.subarray(0, total));
    }
    callback();
  }
}
