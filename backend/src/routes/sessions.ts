import { z } from 'zod';
import { deleteSession, getSession, listMessages, listSessions } from '../lib/db.js';
import { notFound, sendJson, sendNoContent } from '../lib/http.js';
import type { AuthUser } from '../lib/types.js';

export const SessionIdSchema = z.string().uuid();

function requireSessionId(raw: string): string {
  const res = SessionIdSchema.safeParse(raw);
  if (!res.success) throw notFound(); // malformed id can't exist → same as not owned
  return res.data;
}

export async function handleListSessions(user: AuthUser, stream: awslambda.ResponseStream) {
  const sessions = await listSessions(user.sub);
  await sendJson(stream, 200, { sessions });
}

export async function handleGetSession(user: AuthUser, rawId: string, stream: awslambda.ResponseStream) {
  const sessionId = requireSessionId(rawId);
  const session = await getSession(user.sub, sessionId);
  if (!session) throw notFound('Session not found');
  const messages = await listMessages(user.sub, sessionId);
  await sendJson(stream, 200, {
    session,
    messages: messages.map((m) => ({
      messageId: m.messageId,
      role: m.role,
      content: m.content,
      ...(m.role === 'assistant' && m.citations ? { citations: m.citations } : {}),
      createdAt: m.createdAt,
    })),
  });
}

export async function handleDeleteSession(user: AuthUser, rawId: string, stream: awslambda.ResponseStream) {
  const sessionId = requireSessionId(rawId);
  const deleted = await deleteSession(user.sub, sessionId);
  if (!deleted) throw notFound('Session not found');
  await sendNoContent(stream);
}
