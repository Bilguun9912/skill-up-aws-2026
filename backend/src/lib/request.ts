import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { z } from 'zod';
import { badRequest } from './http.js';
import type { UiLang } from './types.js';

/** Function URL payload v2 body → UTF-8 string (handles isBase64Encoded). */
export function decodeBody(event: Pick<LambdaFunctionURLEvent, 'body' | 'isBase64Encoded'>): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

/** Parses + validates a JSON body with zod; any failure ⇒ 400. */
export function parseJsonBody<T extends z.ZodType>(
  event: Pick<LambdaFunctionURLEvent, 'body' | 'isBase64Encoded'>,
  schema: T,
): z.infer<T> {
  let json: unknown;
  try {
    json = JSON.parse(decodeBody(event));
  } catch {
    throw badRequest('Body must be valid JSON');
  }
  const res = schema.safeParse(json);
  if (!res.success) throw badRequest('Invalid request body');
  return res.data;
}

/** Lower-cased header map (Function URL headers are already lower-case; be defensive). */
export function normaliseHeaders(headers: Record<string, string | undefined> | undefined) {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}

export function parseUiLang(v: string | undefined): UiLang | undefined {
  const s = v?.trim().toLowerCase();
  return s === 'ja' || s === 'en' ? s : undefined;
}
