import { randomUUID } from 'node:crypto';
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { z } from 'zod';
import { getConfig } from '../lib/config.js';
import { getRecentMessages, getSession, saveTurn } from '../lib/db.js';
import { notFound, startResponse } from '../lib/http.js';
import { streamAnswer } from '../lib/llm.js';
import { errFields, log, type LogFields } from '../lib/log.js';
import { NdjsonWriter } from '../lib/ndjson.js';
import { buildMessages } from '../lib/prompt.js';
import { consumeQuestion, recordTokenUsage } from '../lib/quota.js';
import { parseJsonBody, parseUiLang } from '../lib/request.js';
import { retrieve } from '../lib/retrieve.js';
import { buildSearchQuery } from '../lib/searchQuery.js';
import { codePointLength, makeSessionTitle } from '../lib/text.js';
import type { AuthUser, Usage } from '../lib/types.js';
import { SYSTEM_PROMPT } from '../prompts/system.js';

export const MESSAGE_MAX_CODE_POINTS = 4000;

export const ChatRequestSchema = z.object({
  sessionId: z.string().uuid().optional(),
  message: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, 'message is required')
    // Count code points, not UTF-16 units (emoji / some kanji are surrogate pairs).
    .refine((s) => codePointLength(s) <= MESSAGE_MAX_CODE_POINTS, 'message too long'),
});

export const STREAM_ERROR_MESSAGE = 'Something went wrong while generating the answer. Please try again.';

/** Monotonic-ish ISO timestamp strictly after `prev` (keeps user < assistant ordering in SK). */
function isoAfter(prev: string): string {
  const now = Date.now();
  const prevMs = Date.parse(prev);
  return new Date(now > prevMs ? now : prevMs + 1).toISOString();
}

export async function handleChat(
  user: AuthUser,
  event: LambdaFunctionURLEvent,
  headers: Record<string, string | undefined>,
  stream: awslambda.ResponseStream,
  logCtx: LogFields,
): Promise<void> {
  const cfg = getConfig();
  const body = parseJsonBody(event, ChatRequestSchema);
  const uiLang = parseUiLang(headers['x-ui-lang']);
  const userCreatedAt = new Date().toISOString();

  // --- pre-stream checks: errors here become normal JSON responses (400/404/429) ---
  let sessionId: string;
  let title: string;
  let isNew: boolean;
  if (body.sessionId) {
    const existing = await getSession(user.sub, body.sessionId);
    if (!existing) throw notFound('Session not found');
    sessionId = existing.sessionId;
    title = existing.title;
    isNew = false;
  } else {
    sessionId = randomUUID();
    title = makeSessionTitle(body.message);
    isNew = true;
  }
  logCtx.sessionNew = isNew;

  const quota = await consumeQuestion(user.sub);
  logCtx.quotaCount = quota.count;

  // --- streaming from here on: failures become an NDJSON error event ---
  const out = startResponse(stream, 200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
  const writer = new NdjsonWriter(out);
  try {
    await writer.write({ type: 'session', sessionId, title });

    const [history, search] = await Promise.all([
      isNew ? Promise.resolve([]) : getRecentMessages(user.sub, sessionId, 2 * cfg.historyTurns),
      buildSearchQuery(body.message, isNew ? undefined : title),
    ]);
    logCtx.queryMode = search.mode;

    const chunks = await retrieve(search.query);
    const citations = chunks.map((c) => c.citation);
    logCtx.retrieved = chunks.length;
    await writer.write({ type: 'citations', citations });

    const messages = buildMessages({
      history,
      historyTurns: cfg.historyTurns,
      question: body.message,
      chunks,
      uiLang,
    });

    let answer = '';
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    for await (const ev of streamAnswer({
      modelId: cfg.modelId,
      systemPrompt: SYSTEM_PROMPT,
      messages,
      maxTokens: cfg.maxOutputTokens,
    })) {
      if (ev.type === 'delta') {
        answer += ev.text;
        await writer.write({ type: 'delta', text: ev.text });
      } else {
        usage = ev.usage;
        logCtx.stopReason = ev.stopReason;
      }
    }
    logCtx.inputTokens = usage.inputTokens;
    logCtx.outputTokens = usage.outputTokens;
    if (!answer.trim()) throw new Error('Model returned an empty answer');

    const assistantMessageId = randomUUID();
    await saveTurn({
      sub: user.sub,
      sessionId,
      newSession: isNew ? { title, createdAt: userCreatedAt } : undefined,
      userMessage: { messageId: randomUUID(), content: body.message, createdAt: userCreatedAt },
      assistantMessage: {
        messageId: assistantMessageId,
        content: answer,
        citations,
        usage,
        createdAt: isoAfter(userCreatedAt),
      },
    });

    // Token accounting on the Usage item (answer + query rewrite). Best effort.
    const totalUsage: Usage = {
      inputTokens: usage.inputTokens + (search.usage?.inputTokens ?? 0),
      outputTokens: usage.outputTokens + (search.usage?.outputTokens ?? 0),
    };
    await recordTokenUsage(user.sub, totalUsage).catch((err) =>
      log.warn('usage.record_failed', { sub: user.sub, ...errFields(err) }),
    );

    await writer.write({ type: 'done', messageId: assistantMessageId, usage });
  } catch (err) {
    logCtx.status = 'stream_error';
    log.error('chat.stream_failed', { sub: user.sub, sessionId, ...errFields(err) });
    await writer.write({ type: 'error', message: STREAM_ERROR_MESSAGE }).catch(() => undefined);
  } finally {
    await writer.end();
  }
}
