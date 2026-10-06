import { bodyHeaders } from './hash';
import { readNdjson } from './ndjson';
import type {
  ChatEvent,
  ChatRequest,
  ErrorBody,
  ErrorCode,
  GetSessionResponse,
  ListSessionsResponse,
  MeResponse,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiClientOptions {
  /** Returns a valid Cognito access token (renewing if needed), or throws if not signed in. */
  getAccessToken: () => Promise<string>;
  /** Called on HTTP 401 so the app can trigger re-login. */
  onUnauthorized?: () => void;
  /** UI language sent as `x-ui-lang` (a hint for the backend). */
  getUiLang?: () => 'ja' | 'en';
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface StreamChatHandlers {
  onEvent: (event: ChatEvent) => void;
}

export interface ApiClient {
  getMe(signal?: AbortSignal): Promise<MeResponse>;
  listSessions(signal?: AbortSignal): Promise<ListSessionsResponse>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<GetSessionResponse>;
  deleteSession(sessionId: string): Promise<void>;
  /** Streams a chat answer. Resolves when the stream ends; rejects on HTTP errors or abort. */
  streamChat(req: ChatRequest, handlers: StreamChatHandlers, signal?: AbortSignal): Promise<void>;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : err instanceof Error && err.name === 'AbortError';
}

async function toApiError(res: Response): Promise<ApiError> {
  let code: ErrorCode = defaultCode(res.status);
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as Partial<ErrorBody>;
    if (body && body.error) {
      if (typeof body.error.code === 'string') code = body.error.code;
      if (typeof body.error.message === 'string') message = body.error.message;
    }
  } catch {
    // Non-JSON error body (e.g. a CloudFront error page) — keep defaults.
  }
  return new ApiError(res.status, code, message);
}

function defaultCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 429:
      return 'quota_exceeded';
    default:
      return 'internal';
  }
}

const EVENT_TYPES = new Set(['session', 'citations', 'delta', 'done', 'error']);

function isChatEvent(value: unknown): value is ChatEvent {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string' &&
    EVENT_TYPES.has((value as { type: string }).type)
  );
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const baseUrl = opts.baseUrl ?? '';

  async function request(
    method: string,
    path: string,
    payload?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const token = await opts.getAccessToken();
    const headers: Record<string, string> = { 'x-auth-token': token };
    const lang = opts.getUiLang?.();
    if (lang) headers['x-ui-lang'] = lang;
    let body: string | undefined;
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      Object.assign(headers, await bodyHeaders(body));
    }
    const res = await fetchImpl(`${baseUrl}${path}`, { method, headers, body, signal });
    if (!res.ok) {
      const err = await toApiError(res);
      if (res.status === 401) opts.onUnauthorized?.();
      throw err;
    }
    return res;
  }

  async function json<T>(method: string, path: string, signal?: AbortSignal): Promise<T> {
    const res = await request(method, path, undefined, signal);
    return (await res.json()) as T;
  }

  return {
    getMe: (signal) => json<MeResponse>('GET', '/api/me', signal),
    listSessions: (signal) => json<ListSessionsResponse>('GET', '/api/sessions', signal),
    getSession: (sessionId, signal) =>
      json<GetSessionResponse>('GET', `/api/sessions/${encodeURIComponent(sessionId)}`, signal),
    async deleteSession(sessionId) {
      await request('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}`);
    },
    async streamChat(req, handlers, signal) {
      const payload: ChatRequest = { message: req.message };
      if (req.sessionId) payload.sessionId = req.sessionId;
      const res = await request('POST', '/api/chat', payload, signal);
      if (!res.body) throw new ApiError(500, 'internal', 'Empty response from server');
      for await (const obj of readNdjson(res.body)) {
        if (isChatEvent(obj)) handlers.onEvent(obj);
      }
    },
  };
}
