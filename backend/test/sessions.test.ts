import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle, matchRoute } from '../src/handlers/api.js';
import { CaptureStream, makeEvent, signToken } from './helpers.js';
import { primeAuth } from './testAuth.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const SID = '11111111-2222-4333-8444-555555555555';

async function call(method: string, path: string, sub = 'user-sub-1') {
  const out = new CaptureStream();
  await handle(makeEvent({ method, path, headers: { 'x-auth-token': signToken({ sub }) } }), out);
  return out;
}

describe('router', () => {
  it('matches all routes and ignores trailing slashes', () => {
    expect(matchRoute('POST', '/api/chat')?.name).toBe('chat');
    expect(matchRoute('GET', '/api/sessions/')?.name).toBe('listSessions');
    expect(matchRoute('GET', `/api/sessions/${SID}`)).toEqual({ name: 'getSession', params: { sessionId: SID } });
    expect(matchRoute('DELETE', `/api/sessions/${SID}`)?.name).toBe('deleteSession');
    expect(matchRoute('GET', '/api/me')?.name).toBe('me');
    expect(matchRoute('GET', '/api/chat')).toBeUndefined();
    expect(matchRoute('PUT', `/api/sessions/${SID}`)).toBeUndefined();
  });
});

describe('sessions routes', () => {
  beforeAll(primeAuth);
  beforeEach(() => ddbMock.reset());

  it('GET /api/sessions lists only the caller’s sessions, newest first', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { sessionId: 'a', title: 'A', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
        { sessionId: 'b', title: 'B', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' },
      ],
    });
    const out = await call('GET', '/api/sessions');
    expect(out.status).toBe(200);
    expect(out.json().sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(['b', 'a']);
    const q = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(q.ExpressionAttributeValues).toEqual({ ':pk': 'USER#user-sub-1', ':prefix': 'SESSION#' });
  });

  it('GET /api/sessions/{id} returns session + messages oldest first', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { PK: 'USER#user-sub-1', SK: `SESSION#${SID}`, sessionId: SID, title: 'T', createdAt: 'c', updatedAt: 'u' },
    });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { messageId: 'm1', role: 'user', content: 'q', createdAt: '1' },
        { messageId: 'm2', role: 'assistant', content: 'a [1]', citations: [{ n: 1, source: 'pmbok', title: 'x', excerpt: 'e' }], usage: { inputTokens: 1, outputTokens: 2 }, createdAt: '2' },
      ],
    });
    const out = await call('GET', `/api/sessions/${SID}`);
    expect(out.status).toBe(200);
    expect(out.json()).toEqual({
      session: { sessionId: SID, title: 'T', createdAt: 'c', updatedAt: 'u' },
      messages: [
        { messageId: 'm1', role: 'user', content: 'q', createdAt: '1' },
        { messageId: 'm2', role: 'assistant', content: 'a [1]', citations: [{ n: 1, source: 'pmbok', title: 'x', excerpt: 'e' }], createdAt: '2' },
      ],
    });
    const q = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(q.ScanIndexForward).toBe(true);
    expect(q.ExpressionAttributeValues![':pk']).toBe(`USER#user-sub-1#SESSION#${SID}`);
  });

  it("another user's session → 404 (keys are built from the caller's sub)", async () => {
    // Session exists only under user-sub-1.
    ddbMock.on(GetCommand, { Key: { PK: 'USER#user-sub-1', SK: `SESSION#${SID}` } }).resolves({
      Item: { sessionId: SID, title: 'T', createdAt: 'c', updatedAt: 'u' },
    });
    ddbMock.on(GetCommand, { Key: { PK: 'USER#intruder', SK: `SESSION#${SID}` } }).resolves({});

    const get = await call('GET', `/api/sessions/${SID}`, 'intruder');
    expect(get.status).toBe(404);
    expect(get.json()).toEqual({ error: { code: 'not_found', message: 'Session not found' } });

    const del = await call('DELETE', `/api/sessions/${SID}`, 'intruder');
    expect(del.status).toBe(404);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('malformed session id → 404', async () => {
    const out = await call('GET', '/api/sessions/not-a-uuid');
    expect(out.status).toBe(404);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('DELETE /api/sessions/{id} deletes messages + session → 204', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { sessionId: SID, title: 'T', createdAt: 'c', updatedAt: 'u' } });
    const msgPk = `USER#user-sub-1#SESSION#${SID}`;
    ddbMock.on(QueryCommand).resolves({
      Items: Array.from({ length: 30 }, (_, i) => ({ PK: msgPk, SK: `MSG#${String(i).padStart(3, '0')}` })),
    });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const out = await call('DELETE', `/api/sessions/${SID}`);
    expect(out.status).toBe(204);
    expect(out.text).toBe('');
    const batches = ddbMock.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!.TestTable!);
    expect(batches.map((b) => b.length)).toEqual([25, 6]);
    const keys = batches.flat().map((r) => r.DeleteRequest!.Key);
    expect(keys).toContainEqual({ PK: 'USER#user-sub-1', SK: `SESSION#${SID}` });
    expect(keys.every((k) => String(k!.PK).startsWith('USER#user-sub-1'))).toBe(true);
  });
});
