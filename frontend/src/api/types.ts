// Types mirror docs/api.md exactly.

export interface Citation {
  n: number;
  source: 'pmbok' | 'user';
  edition?: '6' | '7';
  title: string;
  page?: number;
  excerpt: string;
  score?: number;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  createdAt: string;
}

export interface ListSessionsResponse {
  sessions: SessionSummary[];
}

export interface GetSessionResponse {
  session: SessionSummary;
  messages: Message[];
}

export interface Usage {
  date: string;
  count: number;
  limit: number;
}

export interface MeResponse {
  sub: string;
  username: string;
  usage: Usage;
}

export interface ChatRequest {
  sessionId?: string;
  message: string;
}

export type ChatEvent =
  | { type: 'session'; sessionId: string; title: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      messageId: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: 'error'; message: string };

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'quota_exceeded'
  | 'internal'
  | (string & {});

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

export const MAX_MESSAGE_LENGTH = 4000;
