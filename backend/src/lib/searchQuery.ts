/**
 * Cross-lingual retrieval: PMBOK PDFs are English, users may ask in Japanese. When the message
 * contains Japanese, a short non-streaming Converse call rewrites it into an English search
 * query. On any failure we fall back to the original message (never fail the request).
 */
import { getConfig } from './config.js';
import { converseText } from './llm.js';
import { errFields, log } from './log.js';
import { codePointLength, collapseWhitespace, containsJapanese, truncateCodePoints } from './text.js';

export const REWRITE_SYSTEM_PROMPT =
  'Rewrite as a concise English search query for the PMBOK Guide; use PMBOK terminology; output only the query.';
export const REWRITE_MAX_TOKENS = 100;
const QUERY_MAX_CHARS = 300;
/** English follow-ups shorter than this get the session title as context ("why?" → "<title>: why?"). */
const SHORT_FOLLOWUP_CHARS = 25;

export interface SearchQueryResult {
  query: string;
  /** 'rewrite' = model rewrite used; 'original' = no rewrite needed; 'fallback' = rewrite failed. */
  mode: 'rewrite' | 'original' | 'fallback';
  usage?: { inputTokens: number; outputTokens: number };
}

export function buildRewriteInput(message: string, sessionTitle?: string): string {
  const parts: string[] = [];
  if (sessionTitle) parts.push(`<conversation_topic>${sessionTitle}</conversation_topic>`);
  parts.push(`<message>${message}</message>`);
  return parts.join('\n');
}

/** Cleans the model output into a single-line query. */
export function cleanRewrite(text: string): string {
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const unquoted = firstLine.replace(/^(query|search query)\s*:\s*/i, '').replace(/^["'`「]+|["'`」]+$/g, '');
  return truncateCodePoints(collapseWhitespace(unquoted), QUERY_MAX_CHARS, '');
}

export async function buildSearchQuery(message: string, sessionTitle?: string): Promise<SearchQueryResult> {
  if (!containsJapanese(message)) {
    const short = sessionTitle && codePointLength(message) < SHORT_FOLLOWUP_CHARS;
    return { query: short ? `${sessionTitle}: ${message}` : message, mode: 'original' };
  }
  try {
    const { queryRewriteModelId } = getConfig();
    const res = await converseText({
      modelId: queryRewriteModelId,
      system: REWRITE_SYSTEM_PROMPT,
      userText: buildRewriteInput(message, sessionTitle),
      maxTokens: REWRITE_MAX_TOKENS,
    });
    const query = cleanRewrite(res.text);
    if (!query) throw new Error('empty rewrite');
    return { query, mode: 'rewrite', usage: res.usage };
  } catch (err) {
    log.warn('search_query.rewrite_failed', errFields(err));
    return { query: message, mode: 'fallback' };
  }
}
