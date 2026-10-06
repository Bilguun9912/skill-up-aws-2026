import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export type ErrorCode = 'bad_request' | 'unauthorized' | 'not_found' | 'quota_exceeded' | 'internal';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg = 'Invalid request') => new HttpError(400, 'bad_request', msg);
export const unauthorized = (msg = 'Unauthorized') => new HttpError(401, 'unauthorized', msg);
export const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
export const quotaExceeded = (msg = 'Daily question limit reached') =>
  new HttpError(429, 'quota_exceeded', msg);
export const internal = (msg = 'Internal error') => new HttpError(500, 'internal', msg);

const BASE_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** Starts an HTTP response on the Lambda response stream (writes the status/headers prelude). */
export function startResponse(
  stream: awslambda.ResponseStream,
  statusCode: number,
  headers: Record<string, string> = {},
): awslambda.ResponseStream {
  return awslambda.HttpResponseStream.from(stream, {
    statusCode,
    headers: { ...BASE_HEADERS, ...headers },
  });
}

/** Writes a complete JSON response and ends the stream. */
export async function sendJson(
  stream: awslambda.ResponseStream,
  statusCode: number,
  body: unknown,
): Promise<void> {
  const out = startResponse(stream, statusCode, { 'content-type': 'application/json' });
  await pipeline(Readable.from([JSON.stringify(body)]), out);
}

/** 204 with no body. */
export async function sendNoContent(stream: awslambda.ResponseStream): Promise<void> {
  const out = startResponse(stream, 204);
  // NOTE: the runtime writes the status prelude on the first write; an empty write makes sure it
  // is flushed even though there is no body (unverified edge case of the streaming runtime).
  await pipeline(Readable.from([Buffer.alloc(0)]), out);
}

export async function sendError(stream: awslambda.ResponseStream, err: HttpError): Promise<void> {
  await sendJson(stream, err.statusCode, { error: { code: err.code, message: err.message } });
}
