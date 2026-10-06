// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bodyHeaders, sha256Hex } from './hash';

describe('sha256Hex', () => {
  it('hashes the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes ASCII', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes UTF-8 bytes (Japanese)', async () => {
    // printf 'こんにちは' | shasum -a 256
    expect(await sha256Hex('こんにちは')).toBe(
      '125aeadf27b0459b8760c13a3d80912dfa8a81a68261906f60d87f4a0268646c',
    );
  });
});

describe('bodyHeaders', () => {
  it('returns content-type and the body hash', async () => {
    const body = JSON.stringify({ message: 'hi' });
    expect(await bodyHeaders(body)).toEqual({
      'content-type': 'application/json',
      'x-amz-content-sha256': await sha256Hex(body),
    });
  });
});
