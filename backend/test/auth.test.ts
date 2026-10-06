import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../src/handlers/api.js';
import { CaptureStream, makeEvent, otherPrivateKey, signToken } from './helpers.js';
import { primeAuth, ssmMock } from './testAuth.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

async function callMe(headers: Record<string, string>) {
  const out = new CaptureStream();
  await handle(makeEvent({ path: '/api/me', headers }), out);
  return out;
}

describe('authentication', () => {
  beforeAll(primeAuth);
  beforeEach(() => {
    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({ Item: { count: 3 } });
  });

  it('401 when x-auth-token is missing', async () => {
    const out = await callMe({});
    expect(out.status).toBe(401);
    expect(out.json()).toEqual({ error: { code: 'unauthorized', message: 'Missing token' } });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('ignores the Authorization header (reserved for OAC SigV4)', async () => {
    const out = await callMe({ authorization: `Bearer ${signToken()}` });
    expect(out.status).toBe(401);
  });

  it.each([
    ['garbage token', () => 'not-a-jwt'],
    ['bad signature', () => signToken({}, otherPrivateKey())],
    ['expired', () => signToken({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ['id token instead of access token', () => signToken({ token_use: 'id' })],
    ['wrong client id', () => signToken({ client_id: 'someone-else' })],
    ['wrong issuer', () => signToken({ iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_Other' })],
  ])('401 for %s', async (_name, make) => {
    const out = await callMe({ 'x-auth-token': make() });
    expect(out.status).toBe(401);
    expect(out.json().error.code).toBe('unauthorized');
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('accepts a valid access token and returns /api/me', async () => {
    const out = await callMe({ 'x-auth-token': signToken() });
    expect(out.status).toBe(200);
    const body = out.json();
    expect(body).toMatchObject({ sub: 'user-sub-1', username: 'alice', usage: { count: 3, limit: 30 } });
    expect(body.usage.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const get = ddbMock.commandCalls(GetCommand)[0]!.args[0].input;
    expect(get.Key).toEqual({ PK: 'USER#user-sub-1', SK: `USAGE#${body.usage.date}` });
  });

  it('reads the client id from the SSM param named by CLIENT_ID_PARAM (cached)', async () => {
    await callMe({ 'x-auth-token': signToken() });
    await callMe({ 'x-auth-token': signToken() });
    const calls = ssmMock.commandCalls(GetParameterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({ Name: '/pmbok/test/cognito/client-id' });
  });

  it('authenticates before routing (unknown path with no token → 401, with token → 404)', async () => {
    const a = new CaptureStream();
    await handle(makeEvent({ path: '/api/nope' }), a);
    expect(a.status).toBe(401);
    const b = new CaptureStream();
    await handle(makeEvent({ path: '/api/nope', headers: { 'x-auth-token': signToken() } }), b);
    expect(b.status).toBe(404);
    expect(b.json().error.code).toBe('not_found');
  });
});
