/**
 * api Lambda entry (Function URL, RESPONSE_STREAM, payload format 2.0). Routes all /api/* paths
 * (ADR-008). Non-chat routes just write JSON through the stream.
 */
import type { Context, LambdaFunctionURLEvent } from 'aws-lambda';
import { authenticate } from '../lib/auth.js';
import { HttpError, internal, notFound, sendError } from '../lib/http.js';
import { errFields, log, type LogFields } from '../lib/log.js';
import { normaliseHeaders } from '../lib/request.js';
import { handleChat } from '../routes/chat.js';
import { handleMe } from '../routes/me.js';
import { handleDeleteSession, handleGetSession, handleListSessions } from '../routes/sessions.js';

type RouteName = 'chat' | 'listSessions' | 'getSession' | 'deleteSession' | 'me';

export interface MatchedRoute {
  name: RouteName;
  params: { sessionId?: string };
}

/** Pure router: method + path → route. Trailing slashes are ignored. */
export function matchRoute(method: string, rawPath: string): MatchedRoute | undefined {
  const path = rawPath.replace(/\/+$/, '') || '/';
  const m = method.toUpperCase();
  if (path === '/api/chat' && m === 'POST') return { name: 'chat', params: {} };
  if (path === '/api/sessions' && m === 'GET') return { name: 'listSessions', params: {} };
  if (path === '/api/me' && m === 'GET') return { name: 'me', params: {} };
  const s = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (s) {
    const sessionId = decodeURIComponent(s[1]!);
    if (m === 'GET') return { name: 'getSession', params: { sessionId } };
    if (m === 'DELETE') return { name: 'deleteSession', params: { sessionId } };
  }
  return undefined;
}

/** Testable inner handler (no dependency on the `awslambda` global wrapper). */
export async function handle(
  event: LambdaFunctionURLEvent,
  responseStream: awslambda.ResponseStream,
): Promise<void> {
  const started = Date.now();
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/';
  const route = matchRoute(method, rawPath);
  const logCtx: LogFields = { route: route?.name ?? 'unmatched', method };
  let status = 200;

  try {
    const headers = normaliseHeaders(event.headers);
    // Authenticate every request first (also for unknown paths).
    const user = await authenticate(headers);
    logCtx.sub = user.sub;
    if (!route) throw notFound();

    switch (route.name) {
      case 'chat':
        await handleChat(user, event, headers, responseStream, logCtx);
        break;
      case 'listSessions':
        await handleListSessions(user, responseStream);
        break;
      case 'getSession':
        await handleGetSession(user, route.params.sessionId!, responseStream);
        break;
      case 'deleteSession':
        await handleDeleteSession(user, route.params.sessionId!, responseStream);
        status = 204;
        break;
      case 'me':
        await handleMe(user, responseStream);
        break;
    }
  } catch (err) {
    const httpErr = err instanceof HttpError ? err : internal();
    status = httpErr.statusCode;
    if (!(err instanceof HttpError)) log.error('request.failed', { ...logCtx, ...errFields(err) });
    try {
      await sendError(responseStream, httpErr);
    } catch (writeErr) {
      // Stream may already be started/ended; nothing more we can send.
      log.error('response.write_failed', { ...logCtx, ...errFields(writeErr) });
    }
  } finally {
    log.info('request', { ...logCtx, status, latencyMs: Date.now() - started });
  }
}

export const handler = awslambda.streamifyResponse<LambdaFunctionURLEvent, Context>(
  async (event, responseStream) => {
    await handle(event, responseStream);
  },
);
