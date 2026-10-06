/**
 * Prompt assembly (docs/prompting.md). Pure functions — no I/O.
 *
 *   system: SYSTEM_PROMPT (static, byte-stable)
 *   messages:
 *     ...last HISTORY_TURNS user/assistant pairs (raw text, no old sources blocks)
 *     user: "<sources>\n[1] (PMBOK 7th ed., p.45) ...\n</sources>\n\n<question>\n...\n</question>"
 */
import type { Message } from '@aws-sdk/client-bedrock-runtime';
import type { Citation, UiLang } from './types.js';
import { truncateCodePoints } from './text.js';

export const CHUNK_MAX_CHARS = 1500;
export const NO_SOURCES_TEXT = 'No relevant PMBOK passages found.';

export interface RetrievedChunk {
  citation: Citation;
  /** Full chunk text from the KB (trimmed again when placed in the prompt). */
  text: string;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** e.g. "PMBOK 7th ed., p.45" / "PMBOK 6th ed." / "<title>, p.3" for user docs. */
export function sourceLabel(c: Citation): string {
  let label: string;
  if (c.source === 'pmbok') label = c.edition ? `PMBOK ${c.edition}th ed.` : 'PMBOK';
  else label = c.title;
  if (c.page !== undefined) label += `, p.${c.page}`;
  return label;
}

/**
 * Neutralises our own wrapper tags inside retrieved text so a chunk can't close the
 * <sources> block early (light prompt-injection hardening).
 */
function neutraliseTags(text: string): string {
  return text.replace(/<(\/?)(sources|question|ui_language)>/gi, '‹$1$2›');
}

export function formatChunkText(text: string): string {
  return truncateCodePoints(neutraliseTags(text.replace(/\s+/g, ' ').trim()), CHUNK_MAX_CHARS);
}

export function buildSourcesBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return `<sources>\n${NO_SOURCES_TEXT}\n</sources>`;
  const lines = chunks.map(
    (c) => `[${c.citation.n}] (${sourceLabel(c.citation)}) ${formatChunkText(c.text)}`,
  );
  return `<sources>\n${lines.join('\n')}\n</sources>`;
}

/** The final user turn: sources + (optional UI language hint) + question. */
export function buildUserTurn(question: string, chunks: RetrievedChunk[], uiLang?: UiLang): string {
  const parts = [buildSourcesBlock(chunks)];
  if (uiLang) parts.push(`<ui_language>${uiLang}</ui_language>`);
  parts.push(`<question>\n${question}\n</question>`);
  return parts.join('\n\n');
}

/**
 * Normalises history into strictly alternating user→assistant pairs (Converse requires the
 * conversation to start with a user turn and alternate). Keeps at most `maxTurns` pairs.
 */
export function selectHistory(history: HistoryMessage[], maxTurns: number): HistoryMessage[] {
  const pairs: [HistoryMessage, HistoryMessage][] = [];
  for (let i = 0; i < history.length - 1; i++) {
    const u = history[i]!;
    const a = history[i + 1]!;
    if (u.role === 'user' && a.role === 'assistant' && u.content.trim() && a.content.trim()) {
      pairs.push([u, a]);
      i++;
    }
  }
  return pairs.slice(Math.max(0, pairs.length - maxTurns)).flat();
}

export function buildMessages(params: {
  history: HistoryMessage[];
  historyTurns: number;
  question: string;
  chunks: RetrievedChunk[];
  uiLang?: UiLang;
}): Message[] {
  const history = selectHistory(params.history, params.historyTurns).map(
    (m): Message => ({ role: m.role, content: [{ text: m.content }] }),
  );
  return [
    ...history,
    { role: 'user', content: [{ text: buildUserTurn(params.question, params.chunks, params.uiLang) }] },
  ];
}
