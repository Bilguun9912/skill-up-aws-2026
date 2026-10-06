import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
  type KnowledgeBaseRetrievalResult,
} from '@aws-sdk/client-bedrock-agent-runtime';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle } from '../src/handlers/api.js';
import { SYSTEM_PROMPT } from '../src/prompts/system.js';
import { CaptureStream, converseStreamEvents, makeEvent, signToken } from './helpers.js';
import { primeAuth } from './testAuth.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const bedrockMock = mockClient(BedrockRuntimeClient);
const kbMock = mockClient(BedrockAgentRuntimeClient);

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

const kbResults: KnowledgeBaseRetrievalResult[] = [
  {
    content: { text: 'Stakeholder engagement involves   continual communication with stakeholders.' },
    metadata: {
      source: 'pmbok',
      edition: '7',
      title: 'PMBOK Guide 7th Edition',
      'x-amz-bedrock-kb-document-page-number': 45,
    },
    score: 0.81,
  },
  {
    content: { text: 'Perform Integrated Change Control is the process of reviewing all change requests.' },
    metadata: { source: 'pmbok', edition: '6', title: 'PMBOK Guide 6th Edition' },
    score: 0.77,
  },
];

function chatEvent(body: unknown, opts: { base64?: boolean; headers?: Record<string, string> } = {}) {
  return makeEvent({
    method: 'POST',
    path: '/api/chat',
    headers: { 'x-auth-token': signToken(), ...(opts.headers ?? {}) },
    body,
    base64: opts.base64,
  });
}

async function run(event: ReturnType<typeof chatEvent>) {
  const out = new CaptureStream();
  await handle(event, out);
  return out;
}

function lastUserTurnText(): string {
  const input = bedrockMock.commandCalls(ConverseStreamCommand)[0]!.args[0].input;
  const last = input.messages!.at(-1)!;
  return last.content![0]!.text!;
}

describe('POST /api/chat', () => {
  beforeAll(primeAuth);
  beforeEach(() => {
    ddbMock.reset();
    bedrockMock.reset();
    kbMock.reset();
    ddbMock.on(UpdateCommand).resolves({ Attributes: { count: 1 } });
    ddbMock.on(TransactWriteCommand).resolves({});
    kbMock.on(RetrieveCommand).resolves({ retrievalResults: kbResults });
    bedrockMock
      .on(ConverseStreamCommand)
      .callsFake(async () => ({ stream: converseStreamEvents(['Hello ', 'world [1]']) }));
  });

  it('happy path: emits session → citations → delta… → done and persists the turn', async () => {
    const out = await run(chatEvent({ message: 'How do I handle scope creep from my sponsor?' }));

    expect(out.status).toBe(200);
    expect(out.metadata?.headers?.['content-type']).toMatch(/^application\/x-ndjson/);
    const events = out.ndjson();
    expect(events.map((e) => e.type)).toEqual(['session', 'citations', 'delta', 'delta', 'done']);

    const [session, cites, d1, d2, done] = events;
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.title).toBe('How do I handle scope creep from my spo…');
    expect(cites.citations).toEqual([
      {
        n: 1,
        source: 'pmbok',
        edition: '7',
        title: 'PMBOK Guide 7th Edition',
        page: 45,
        excerpt: 'Stakeholder engagement involves continual communication with stakeholders.',
        score: 0.81,
      },
      {
        n: 2,
        source: 'pmbok',
        edition: '6',
        title: 'PMBOK Guide 6th Edition',
        excerpt: 'Perform Integrated Change Control is the process of reviewing all change requests.',
        score: 0.77,
      },
    ]);
    expect(d1.text + d2.text).toBe('Hello world [1]');
    expect(done).toEqual({
      type: 'done',
      messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      usage: { inputTokens: 1200, outputTokens: 80 },
    });

    // Quota consumed with the conditional ADD.
    const quota = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(quota.UpdateExpression).toContain('ADD #count :one');
    expect(quota.ConditionExpression).toBe('attribute_not_exists(#count) OR #count < :limit');
    expect(quota.ExpressionAttributeValues![':limit']).toBe(30);
    expect(quota.Key!.PK).toBe('USER#user-sub-1');

    // Retrieve: top-k + pmbok filter, English message used as-is (no rewrite).
    const retrieve = kbMock.commandCalls(RetrieveCommand)[0]!.args[0].input;
    expect(retrieve).toEqual({
      knowledgeBaseId: 'KB123',
      retrievalQuery: { text: 'How do I handle scope creep from my sponsor?' },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: 6,
          filter: { equals: { key: 'source', value: 'pmbok' } },
        },
      },
    });
    expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(0);

    // ConverseStream request shape.
    const conv = bedrockMock.commandCalls(ConverseStreamCommand)[0]!.args[0].input;
    expect(conv.modelId).toBe('apac.anthropic.claude-sonnet-test');
    expect(conv.system![0]).toEqual({ text: SYSTEM_PROMPT });
    expect(conv.inferenceConfig).toEqual({ maxTokens: 2000 });
    expect(conv.additionalModelRequestFields).toEqual({ output_config: { effort: 'low' } });
    expect(conv.messages).toHaveLength(1);
    expect(lastUserTurnText()).toContain('[1] (PMBOK 7th ed., p.45) Stakeholder engagement');
    expect(lastUserTurnText()).toContain('[2] (PMBOK 6th ed.) Perform Integrated Change Control');

    // Persistence: new session + user msg + assistant msg (with citations & usage) atomically.
    const tx = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(tx).toHaveLength(3);
    const sessionPut = tx[0]!.Put!;
    expect(sessionPut.Item).toMatchObject({
      PK: 'USER#user-sub-1',
      SK: `SESSION#${session.sessionId}`,
      sessionId: session.sessionId,
      title: session.title,
    });
    expect(sessionPut.ConditionExpression).toBe('attribute_not_exists(PK)');
    const userMsg = tx[1]!.Put!.Item!;
    const asstMsg = tx[2]!.Put!.Item!;
    expect(userMsg).toMatchObject({
      PK: `USER#user-sub-1#SESSION#${session.sessionId}`,
      role: 'user',
      content: 'How do I handle scope creep from my sponsor?',
    });
    expect(userMsg.SK).toMatch(/^MSG#\d{4}-\d{2}-\d{2}T.*#[0-9a-f-]{36}$/);
    expect(asstMsg).toMatchObject({
      role: 'assistant',
      messageId: done.messageId,
      content: 'Hello world [1]',
      citations: cites.citations,
      usage: { inputTokens: 1200, outputTokens: 80 },
    });
    expect(String(asstMsg.SK) > String(userMsg.SK)).toBe(true);

    // Token usage recorded on the Usage item.
    const usageUpd = ddbMock.commandCalls(UpdateCommand)[1]!.args[0].input;
    expect(usageUpd.UpdateExpression).toContain('ADD inputTokens :in, outputTokens :out');
    expect(usageUpd.ExpressionAttributeValues).toMatchObject({ ':in': 1200, ':out': 80 });
  });

  it('never logs the token, the message, or the answer', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const token = signToken();
    await run(
      makeEvent({
        method: 'POST',
        path: '/api/chat',
        headers: { 'x-auth-token': token },
        body: { message: 'SECRET-QUESTION-TEXT' },
      }),
    );
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => String(c[0]))).join('\n');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('SECRET-QUESTION-TEXT');
    expect(logged).not.toContain('Hello world');
    const req = logged.split('\n').map((l) => JSON.parse(l)).find((l) => l.msg === 'request');
    expect(req).toMatchObject({ route: 'chat', sub: 'user-sub-1', status: 200, inputTokens: 1200, outputTokens: 80 });
    expect(typeof req.latencyMs).toBe('number');
  });

  it('decodes base64 bodies (Function URL isBase64Encoded)', async () => {
    const out = await run(chatEvent({ message: 'プロジェクト憲章とは？ base64' }, { base64: true }));
    expect(out.status).toBe(200);
    expect(out.ndjson()[0].title).toBe('プロジェクト憲章とは？ base64');
  });

  it('429 when the daily quota is exhausted (before streaming)', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} }));
    const out = await run(chatEvent({ message: 'hello' }));
    expect(out.status).toBe(429);
    expect(out.json()).toEqual({ error: { code: 'quota_exceeded', message: 'Daily question limit reached' } });
    expect(kbMock.calls()).toHaveLength(0);
    expect(bedrockMock.calls()).toHaveLength(0);
  });

  it.each([
    ['missing message', { sessionId: SESSION_ID }],
    ['blank message', { message: '   ' }],
    ['non-uuid sessionId', { sessionId: 'abc', message: 'hi' }],
    ['too long (4001 code points)', { message: 'a'.repeat(4001) }],
  ])('400 for %s', async (_n, body) => {
    const out = await run(chatEvent(body));
    expect(out.status).toBe(400);
    expect(out.json().error.code).toBe('bad_request');
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('400 for invalid JSON', async () => {
    const out = await run(chatEvent('{not json'));
    expect(out.status).toBe(400);
  });

  it('counts message length in code points, not UTF-16 units', async () => {
    const emoji4000 = '😀'.repeat(4000); // 8000 UTF-16 units
    expect(emoji4000.length).toBe(8000);
    const ok = await run(chatEvent({ message: emoji4000 }));
    expect(ok.status).toBe(200);
    expect([...ok.ndjson()[0].title].length).toBe(40);
    const tooLong = await run(chatEvent({ message: '😀'.repeat(4001) }));
    expect(tooLong.status).toBe(400);
  });

  it("404 when continuing another user's (or a missing) session", async () => {
    ddbMock.on(GetCommand).resolves({});
    const out = await run(chatEvent({ sessionId: SESSION_ID, message: 'follow-up' }));
    expect(out.status).toBe(404);
    const get = ddbMock.commandCalls(GetCommand)[0]!.args[0].input;
    expect(get.Key).toEqual({ PK: 'USER#user-sub-1', SK: `SESSION#${SESSION_ID}` });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0); // no quota consumed
  });

  it('existing session: loads last N turns as history and bumps updatedAt', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { sessionId: SESSION_ID, title: 'Scope creep', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' },
    });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { messageId: 'a2', role: 'assistant', content: 'Use a change log [1].', createdAt: '2026-10-01T00:00:02.000Z' },
        { messageId: 'u1', role: 'user', content: 'Sponsor keeps changing scope', createdAt: '2026-10-01T00:00:01.000Z' },
      ],
    });
    const out = await run(chatEvent({ sessionId: SESSION_ID, message: 'why?' }));
    const events = out.ndjson();
    expect(events.map((e) => e.type)).toEqual(['session', 'citations', 'delta', 'delta', 'done']);
    expect(events[0]).toEqual({ type: 'session', sessionId: SESSION_ID, title: 'Scope creep' });

    const q = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(q.ScanIndexForward).toBe(false);
    expect(q.Limit).toBe(10);
    expect(q.ExpressionAttributeValues![':pk']).toBe(`USER#user-sub-1#SESSION#${SESSION_ID}`);

    const msgs = bedrockMock.commandCalls(ConverseStreamCommand)[0]!.args[0].input.messages!;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[0]!.content![0]!.text).toBe('Sponsor keeps changing scope');
    expect(msgs[1]!.content![0]!.text).toBe('Use a change log [1].');

    // Short English follow-up → session title prefixed to the retrieval query.
    expect(kbMock.commandCalls(RetrieveCommand)[0]!.args[0].input.retrievalQuery).toEqual({ text: 'Scope creep: why?' });

    const tx = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(tx[0]!.Update).toMatchObject({
      Key: { PK: 'USER#user-sub-1', SK: `SESSION#${SESSION_ID}` },
      UpdateExpression: 'SET updatedAt = :u',
      ConditionExpression: 'attribute_exists(PK)',
    });
  });

  it('empty retrieval still answers with the "no passages" sources block', async () => {
    kbMock.on(RetrieveCommand).resolves({ retrievalResults: [] });
    const out = await run(chatEvent({ message: 'What is a burndown chart?' }));
    const events = out.ndjson();
    expect(events[1]).toEqual({ type: 'citations', citations: [] });
    expect(events.at(-1).type).toBe('done');
    expect(lastUserTurnText()).toContain('<sources>\nNo relevant PMBOK passages found.\n</sources>');
  });

  it('x-ui-lang hint goes into the user turn, never the system prompt', async () => {
    await run(chatEvent({ message: '12345' }, { headers: { 'x-ui-lang': 'ja' } }));
    const conv = bedrockMock.commandCalls(ConverseStreamCommand)[0]!.args[0].input;
    expect(lastUserTurnText()).toContain('<ui_language>ja</ui_language>');
    expect(conv.system![0]).toEqual({ text: SYSTEM_PROMPT });
  });

  it('ignores invalid x-ui-lang values', async () => {
    await run(chatEvent({ message: 'hi' }, { headers: { 'x-ui-lang': 'fr' } }));
    expect(lastUserTurnText()).not.toContain('<ui_language>');
  });

  it('Japanese question → English query rewrite is used for Retrieve', async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: 'assistant', content: [{ text: 'stakeholder engagement scope change control' }] } },
      usage: { inputTokens: 50, outputTokens: 8, totalTokens: 58 },
      stopReason: 'end_turn',
      metrics: { latencyMs: 5 },
    });
    const out = await run(chatEvent({ message: 'スポンサーが何度もスコープを変更します。どうすればいい？' }));
    expect(out.ndjson().at(-1).type).toBe('done');
    const rw = bedrockMock.commandCalls(ConverseCommand)[0]!.args[0].input;
    expect(rw.inferenceConfig).toEqual({ maxTokens: 100 });
    expect(rw.modelId).toBe('apac.anthropic.claude-sonnet-test'); // falls back to MODEL_ID
    expect(kbMock.commandCalls(RetrieveCommand)[0]!.args[0].input.retrievalQuery).toEqual({
      text: 'stakeholder engagement scope change control',
    });
    // The model still sees the original Japanese question.
    expect(lastUserTurnText()).toContain('スポンサーが何度もスコープを変更します');
    // Rewrite tokens are added to the Usage item, not to the message usage.
    const usageUpd = ddbMock.commandCalls(UpdateCommand)[1]!.args[0].input;
    expect(usageUpd.ExpressionAttributeValues).toMatchObject({ ':in': 1250, ':out': 88 });
  });

  it('rewrite failure falls back to the original message (request still succeeds)', async () => {
    bedrockMock.on(ConverseCommand).rejects(new Error('ThrottlingException'));
    const warn = vi.spyOn(console, 'warn');
    const msg = 'リスク登録簿の作り方';
    const out = await run(chatEvent({ message: msg }));
    expect(out.ndjson().at(-1).type).toBe('done');
    expect(kbMock.commandCalls(RetrieveCommand)[0]!.args[0].input.retrievalQuery).toEqual({ text: msg });
    expect(warn.mock.calls.map((c) => JSON.parse(String(c[0])).msg)).toContain('search_query.rewrite_failed');
  });

  it('model failure after streaming started → NDJSON error event, nothing persisted', async () => {
    bedrockMock.on(ConverseStreamCommand).rejects(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await run(chatEvent({ message: 'hello' }));
    expect(out.status).toBe(200);
    const events = out.ndjson();
    expect(events.map((e) => e.type)).toEqual(['session', 'citations', 'error']);
    expect(events[2].message).not.toContain('boom');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
