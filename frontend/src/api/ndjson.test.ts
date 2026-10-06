import { describe, expect, it } from 'vitest';
import { NdjsonDecoder, readNdjson } from './ndjson';

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const obj of readNdjson(stream)) out.push(obj);
  return out;
}

describe('NdjsonDecoder', () => {
  it('splits multiple lines in one chunk', () => {
    const d = new NdjsonDecoder();
    expect(d.push('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(d.flush()).toEqual([]);
  });

  it('buffers partial lines across chunks', () => {
    const d = new NdjsonDecoder();
    expect(d.push('{"type":"del')).toEqual([]);
    expect(d.push('ta","text":"he')).toEqual([]);
    expect(d.push('llo"}\n{"type"')).toEqual([{ type: 'delta', text: 'hello' }]);
    expect(d.push(':"done"}')).toEqual([]);
    expect(d.flush()).toEqual([{ type: 'done' }]);
  });

  it('ignores blank lines and handles CRLF', () => {
    const d = new NdjsonDecoder();
    expect(d.push('\n{"a":1}\r\n\r\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('throws on malformed lines', () => {
    const d = new NdjsonDecoder();
    expect(() => d.push('not json\n')).toThrow();
  });
});

describe('readNdjson', () => {
  it('parses a full chat stream split at arbitrary points', async () => {
    const full =
      '{"type":"session","sessionId":"s1","title":"t"}\n' +
      '{"type":"citations","citations":[]}\n' +
      '{"type":"delta","text":"Hi "}\n' +
      '{"type":"delta","text":"there"}\n' +
      '{"type":"done","messageId":"m1","usage":{"inputTokens":1,"outputTokens":2}}\n';
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += 7) chunks.push(full.slice(i, i + 7));
    const events = await collect(streamOf(chunks));
    expect(events.map((e) => (e as { type: string }).type)).toEqual([
      'session',
      'citations',
      'delta',
      'delta',
      'done',
    ]);
  });

  it('handles multi-byte UTF-8 characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"type":"delta","text":"スコープ変更"}\n');
    // Split in the middle of a 3-byte Japanese character.
    const events = await collect(streamOf([bytes.slice(0, 26), bytes.slice(26)]));
    expect(events).toEqual([{ type: 'delta', text: 'スコープ変更' }]);
  });

  it('parses a final line without a trailing newline', async () => {
    const events = await collect(streamOf(['{"a":1}\n{"b"', ':2}']));
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
