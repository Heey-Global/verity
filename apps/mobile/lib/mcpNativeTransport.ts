import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { MCP_NATIVE_MESSAGE_LIMIT, scriptValue } from './mcpNativeHost';

/** Channel binding is mandatory: Android may expose its raw WebView interface in subframes. */
export class NativeMcpTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private closed = false;
  private ready = false;
  private started = false;
  private queue: JSONRPCMessage[] = [];
  private count = 0;
  private windowStart = 0;

  constructor(
    private readonly channel: string,
    private readonly inject: (script: string) => void,
    private readonly failed: () => void,
  ) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.started) throw new Error('MCP host transport closed');
    if (JSON.stringify(message).length > MCP_NATIVE_MESSAGE_LIMIT)
      throw new Error('MCP app message too large');
    if (!this.ready) {
      if (this.queue.length >= 16) throw new Error('MCP host queue full');
      this.queue.push(message);
      return;
    }
    this.inject(
      `window.__verityMcpReceive(${scriptValue({ channel: this.channel, message })});true;`,
    );
  }

  receive(raw: string): void {
    if (this.closed || !this.started || raw.length > MCP_NATIVE_MESSAGE_LIMIT + 256) return;
    try {
      const envelope: unknown = JSON.parse(raw);
      if (
        !envelope ||
        typeof envelope !== 'object' ||
        !('channel' in envelope) ||
        envelope.channel !== this.channel ||
        !('kind' in envelope)
      )
        return;
      const now = Date.now();
      if (now - this.windowStart >= 1000) {
        this.windowStart = now;
        this.count = 0;
      }
      if (++this.count > 128) {
        this.failed();
        return;
      }
      if (envelope.kind === 'failed') {
        this.failed();
        return;
      }
      if (envelope.kind === 'ready') {
        if (this.ready) {
          this.failed();
          return;
        }
        this.ready = true;
        for (const message of this.queue.splice(0))
          void this.send(message).catch(() => this.failed());
      } else if (envelope.kind === 'rpc' && this.ready && 'message' in envelope) {
        const parsed = JSONRPCMessageSchema.safeParse(envelope.message);
        if (parsed.success) this.onmessage?.(parsed.data);
      }
    } catch {
      /* Invalid native events carry no authority. */
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.onclose?.();
  }
}
