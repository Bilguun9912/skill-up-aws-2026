/**
 * Incremental NDJSON decoder. Feed it text chunks (which may split lines or even
 * multi-byte characters when used with a streaming TextDecoder) and get back parsed objects
 * for each complete line.
 */
export class NdjsonDecoder {
  private buffer = '';

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const parsed = parseLine(line);
      if (parsed !== undefined) out.push(parsed);
    }
    return out;
  }

  /** Parse any trailing line that wasn't newline-terminated. */
  flush(): unknown[] {
    const rest = this.buffer;
    this.buffer = '';
    const parsed = parseLine(rest);
    return parsed === undefined ? [] : [parsed];
  }
}

function parseLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error('Malformed response from server');
  }
}

/** Read a byte stream as NDJSON, yielding one parsed object per line. */
export async function* readNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const ndjson = new NdjsonDecoder();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      for (const obj of ndjson.push(decoder.decode(value, { stream: true }))) yield obj;
    }
    for (const obj of ndjson.push(decoder.decode())) yield obj;
    for (const obj of ndjson.flush()) yield obj;
  } finally {
    // Consumer stopped early (or an error occurred): cancel the underlying stream.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
