// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './client';
import { sha256Hex } from './hash';
import type { ChatEvent } from './types';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setup(fetchImpl: typeof fetch) {
  const onUnauthorized = vi.fn();
  const api = createApiClient({
    getAccessToken: async () => 'tok-123',
    onUnauthorized,
    getUiLang: () => 'ja',
    fetchImpl,
  });
  return { api, onUnauthorized };
}

describe('api client', () => {
  it('sends x-auth-token and x-ui-lang on GET, without body headers', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { sub: 's', username: 'u', usage: { date: '2026-10-06', count: 1, limit: 30 } }),
    );
    const { api } = setup(fetchMock as unknown as typeof fetch);
    const me = await api.getMe();
    expect(me.usage.limit).toBe(30);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/me');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-auth-token']).toBe('tok-123');
    expect(headers['x-ui-lang']).toBe('ja');
    expect(headers['authorization']).toBeUndefined();
    expect(headers['x-amz-content-sha256']).toBeUndefined();
  });

  it('hashes the exact POST body and streams NDJSON events', async () => {
    const ndjson =
      '{"type":"session","sessionId":"s1","title":"Scope"}\n' +
      '{"type":"citations","citations":[{"n":1,"source":"pmbok","edition":"7","title":"PMBOK Guide 7th Edition","page":12,"excerpt":"x"}]}\n' +
      '{"type":"delta","text":"Hello"}\n{"type":"unknown"}\n' +
      '{"type":"done","messageId":"m1","usage":{"inputTokens":1,"outputTokens":2}}\n';
    const fetchMock = vi.fn(
      async () => new Response(ndjson, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
    );
    const { api } = setup(fetchMock as unknown as typeof fetch);
    const events: ChatEvent[] = [];
    await api.streamChat({ message: 'スコープ変更' }, { onEvent: (e) => events.push(e) });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/chat');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"message":"スコープ変更"}');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-amz-content-sha256']).toBe(await sha256Hex(init.body as string));
    expect(events.map((e) => e.type)).toEqual(['session', 'citations', 'delta', 'done']);
  });

  it('includes sessionId when continuing a session', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const { api } = setup(fetchMock as unknown as typeof fetch);
    await api.streamChat({ sessionId: 'abc', message: 'hi' }, { onEvent: () => undefined });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ message: 'hi', sessionId: 'abc' });
  });

  it('maps 429 to quota_exceeded ApiError', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(429, { error: { code: 'quota_exceeded', message: 'Daily limit reached' } }),
    );
    const { api, onUnauthorized } = setup(fetchMock as unknown as typeof fetch);
    const err = await api.streamChat({ message: 'q' }, { onEvent: () => undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).code).toBe('quota_exceeded');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('calls onUnauthorized on 401', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: { code: 'unauthorized', message: 'no' } }));
    const { api, onUnauthorized } = setup(fetchMock as unknown as typeof fetch);
    await expect(api.listSessions()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('handles non-JSON error bodies', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    const { api } = setup(fetchMock as unknown as typeof fetch);
    await expect(api.getSession('x')).rejects.toMatchObject({ status: 502, code: 'internal' });
  });

  it('DELETE encodes the session id and sends no body hash', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const { api } = setup(fetchMock as unknown as typeof fetch);
    await api.deleteSession('a/b');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/sessions/a%2Fb');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['x-amz-content-sha256']).toBeUndefined();
  });
});
