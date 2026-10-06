import type { Citation } from './types.js';

export type ChatStreamEvent =
  | { type: 'session'; sessionId: string; title: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: string; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; message: string };

export function toNdjsonLine(event: ChatStreamEvent): string {
  return JSON.stringify(event) + '\n';
}

/** Minimal NDJSON writer over a (Lambda response) Writable. Respects backpressure. */
export class NdjsonWriter {
  constructor(private readonly stream: NodeJS.WritableStream) {}

  async write(event: ChatStreamEvent): Promise<void> {
    const ok = this.stream.write(toNdjsonLine(event));
    if (!ok) await new Promise<void>((resolve) => this.stream.once('drain', () => resolve()));
  }

  async end(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(() => resolve()));
  }
}
