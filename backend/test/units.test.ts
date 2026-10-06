import { describe, expect, it } from 'vitest';
import { decodeBody } from '../src/lib/request.js';
import { mapRetrievalResults } from '../src/lib/retrieve.js';
import { tokyoDate, usageTtl } from '../src/lib/quota.js';
import { cleanRewrite } from '../src/lib/searchQuery.js';
import { modelSpecificRequestFields } from '../src/lib/llm.js';
import { containsJapanese, makeSessionTitle } from '../src/lib/text.js';

describe('quota helpers', () => {
  it('uses the Asia/Tokyo date', () => {
    expect(tokyoDate(new Date('2026-10-06T14:59:59Z'))).toBe('2026-10-06');
    expect(tokyoDate(new Date('2026-10-06T15:00:00Z'))).toBe('2026-10-07');
  });
  it('ttl is +35 days in epoch seconds', () => {
    const now = new Date('2026-10-06T00:00:00Z');
    expect(usageTtl(now)).toBe(now.getTime() / 1000 + 35 * 86400);
  });
});

describe('request decoding', () => {
  it('handles base64 and plain bodies', () => {
    const json = JSON.stringify({ message: 'こんにちは' });
    expect(decodeBody({ body: Buffer.from(json).toString('base64'), isBase64Encoded: true })).toBe(json);
    expect(decodeBody({ body: json, isBase64Encoded: false })).toBe(json);
    expect(decodeBody({ body: undefined, isBase64Encoded: false })).toBe('');
  });
});

describe('retrieval mapping', () => {
  it('maps metadata, page numbers, excerpt ≤300 chars, skips empty chunks', () => {
    const chunks = mapRetrievalResults([
      { content: { text: '' }, metadata: { source: 'pmbok' } },
      {
        content: { text: 'x'.repeat(1000) },
        metadata: { source: 'pmbok', edition: 7, 'x-amz-bedrock-kb-document-page-number': 12.0 },
        score: 0.5,
      },
      { content: { text: 'no metadata' } },
    ] as never);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.citation).toMatchObject({ n: 1, source: 'pmbok', edition: '7', page: 12, title: 'PMBOK Guide 7th Edition', score: 0.5 });
    expect([...chunks[0]!.citation.excerpt].length).toBe(300);
    expect(chunks[0]!.text).toHaveLength(1000);
    expect(chunks[1]!.citation).toEqual({ n: 2, source: 'pmbok', title: 'PMBOK Guide', excerpt: 'no metadata' });
  });
});

describe('text helpers', () => {
  it('detects Japanese', () => {
    expect(containsJapanese('リスク')).toBe(true);
    expect(containsJapanese('ひらがな')).toBe(true);
    expect(containsJapanese('憲章')).toBe(true);
    expect(containsJapanese('ｶﾀｶﾅ')).toBe(true);
    expect(containsJapanese('What is WBS? 123')).toBe(false);
  });
  it('session title is first 40 code points', () => {
    expect(makeSessionTitle('short')).toBe('short');
    expect([...makeSessionTitle('😀'.repeat(50))].length).toBe(40);
    expect(makeSessionTitle('a\n\n b')).toBe('a b');
  });
  it('cleans rewrite output', () => {
    expect(cleanRewrite('"stakeholder engagement"\nextra')).toBe('stakeholder engagement');
    expect(cleanRewrite('Query: risk register')).toBe('risk register');
  });
});

describe('model-specific fields', () => {
  it('Claude gets effort low; Nova gets nothing', () => {
    expect(modelSpecificRequestFields('apac.anthropic.claude-sonnet-5-5')).toEqual({ output_config: { effort: 'low' } });
    expect(modelSpecificRequestFields('apac.amazon.nova-pro-v1:0')).toBeUndefined();
  });
});
